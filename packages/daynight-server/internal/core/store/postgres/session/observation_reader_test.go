package session_test

import (
	"crypto/sha256"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/jackc/pgx/v5"
)

func testObservationSnapshotRechecksCredentialsAndMembershipWithoutWrites(t *testing.T, db *postgres.Store, kind model.CredentialKind) {
	_, member, project := prepareMembership(t, db)
	mustQueryExec(t, db, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, member.UserID)
	task := queryTask(t, db, project.ID, 11, model.TaskInProgress)
	worker, raw := readerWorker(t, queryID(100))
	mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, task.ID, raw)
	seen := time.Now().UTC()
	insertReaderSession(t, db, queryID(111), project.ID, task.ID, worker, readerSnapshot(t, queryID(111), project.ID, task.ID, worker, "active"), &seen, nil)
	actor := model.Principal{Kind: kind, UserID: member.UserID, CredentialID: queryID(201)}
	hash := sha256.Sum256([]byte(actor.CredentialID))
	table := "personal_access_tokens"
	if kind == model.PATCredential {
		mustQueryExec(t, db, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'observation',$4,$5)`, actor.CredentialID, actor.UserID, hash[:], seen.Add(-10*time.Minute), seen.Add(10*time.Minute))
	} else {
		table = "oauth_access_tokens"
		mustQueryExec(t, db, `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)`, actor.CredentialID, queryID(202), actor.UserID, hash[:], seen.Add(-10*time.Minute), seen.Add(10*time.Minute))
	}
	read := func(wantCredential, wantMember bool) {
		t.Helper()
		if err := db.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
			_, credentialErr := snapshot.CredentialDAO().Credential(t.Context(), actor)
			if wantCredential && credentialErr != nil || !wantCredential && !errors.Is(credentialErr, model.ErrNotFound) {
				t.Fatalf("credential: %v", credentialErr)
			}
			_, memberErr := snapshot.ProjectDAO().ProjectAccess(t.Context(), actor, project.ID)
			if wantMember && memberErr != nil || !wantMember && !errors.Is(memberErr, model.ErrNotFound) {
				t.Fatalf("membership: %v", memberErr)
			}
			if !wantCredential || !wantMember {
				return nil
			}
			sources, err := snapshot.SessionDAO().TaskSessionSources(t.Context(), project.ID, []string{task.ID})
			if err != nil {
				return err
			}
			if len(sources) != 1 || sources[0].Session == nil || sources[0].Session.SessionID != queryID(111) {
				t.Fatalf("observation sources: %#v", sources)
			}
			_, err = snapshot.SessionDAO().TaskSessionInspectionSource(t.Context(), project.ID, task.ID, queryID(111))
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	read(true, true)
	mustQueryExec(t, db, `UPDATE `+table+` SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, actor.CredentialID)
	read(false, true)
	mustQueryExec(t, db, `UPDATE `+table+` SET expires_at=clock_timestamp()+interval '10 minutes' WHERE id=$1`, actor.CredentialID)
	read(true, true)
	mustQueryExec(t, db, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, member.UserID)
	read(true, false)
	mustQueryExec(t, db, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, member.UserID)
	read(true, true)
	mustQueryExec(t, db, `DELETE FROM `+table+` WHERE id=$1`, actor.CredentialID)
	read(false, true)
	var version int64
	var operations int
	if err := db.Pool.QueryRow(t.Context(), `SELECT version,(SELECT count(*) FROM session_operations WHERE session_id=$2) FROM tasks WHERE id=$1`, task.ID, queryID(111)).Scan(&version, &operations); err != nil || version != task.Version || operations != 0 {
		t.Fatalf("read changed durable state: version=%d operations=%d err=%v", version, operations, err)
	}
}

func testObservationReaderSelectsTaskIDsAndHistoricalSession(t *testing.T, db *postgres.Store) {
	project := queryProject(t, db, 1)
	other := queryProject(t, db, 2)
	worker, raw := readerWorker(t, queryID(100))
	current := queryTask(t, db, project.ID, 11, model.TaskInProgress)
	absent := queryTask(t, db, project.ID, 12, model.TaskTodo)
	foreign := queryTask(t, db, other.ID, 13, model.TaskInProgress)
	mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, current.ID, raw)
	seen := time.Now().UTC().Truncate(time.Microsecond)
	expiry := seen.Add(time.Minute)
	insertReaderSession(t, db, queryID(111), project.ID, current.ID, worker, readerSnapshot(t, queryID(111), project.ID, current.ID, worker, "active"), &seen, nil)
	mustQueryExec(t, db, `UPDATE task_sessions SET connection_expires_at=$2,snapshot=snapshot||jsonb_build_object('initialInputState','confirmed','controls',jsonb_build_object('catalog',$3::text)) WHERE id=$1`, queryID(111), expiry, strings.Repeat("unread", 10000))
	mustQueryExec(t, db, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{identity,nativeSessionId}','"native-original"'::jsonb) WHERE id=$1`, queryID(111))
	old := worker
	old.ClaimID = queryID(101)
	insertReaderSession(t, db, queryID(112), project.ID, current.ID, old, readerSnapshot(t, queryID(112), project.ID, current.ID, old, "archived"), &seen, nil)
	mustQueryExec(t, db, `INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path) VALUES($1,'ready',$2,1,'private/archive')`, queryID(112), strings.Repeat("a", 64))
	if err := postgres.ReadOnlySnapshot(t.Context(), db.Pool, func(tx pgx.Tx) error {
		counted := &countedReaderTx{Tx: tx}
		reader := pgsession.NewReader(counted)
		sources, err := reader.TaskSessionSources(t.Context(), project.ID, []string{foreign.ID, absent.ID, current.ID, current.ID})
		if err != nil {
			return err
		}
		if len(sources) != 2 || counted.queries != 1 {
			t.Fatalf("selected batch: rows=%d queries=%d", len(sources), counted.queries)
		}
		first := sources[0]
		if first.ProjectID != project.ID || first.TaskID != current.ID || first.TaskVersion != current.Version || first.Session == nil || first.Session.SessionID != queryID(111) || first.Session.OwnerID != worker.UserID || first.Session.InitialInputState != "confirmed" || first.Session.ConnectionExpiry == nil || !first.Session.ConnectionExpiry.Equal(expiry) || first.Session.Identity.NativeSessionID == nil || *first.Session.Identity.NativeSessionID != "native-original" {
			t.Fatalf("current projection: %#v %#v", first, first.Session)
		}
		if sources[1].TaskStatus != model.TaskTodo || sources[1].Session != nil {
			t.Fatalf("absence: %#v", sources[1])
		}
		historical, err := reader.TaskSessionInspectionSource(t.Context(), project.ID, current.ID, queryID(112))
		if err != nil {
			return err
		}
		if historical.Session.ClaimID != old.ClaimID || historical.Worker.ClaimID != worker.ClaimID || historical.Session.ArchiveState != "ready" {
			t.Fatalf("historical source: %#v", historical)
		}
		if _, err := reader.TaskSessionInspectionSource(t.Context(), project.ID, absent.ID, queryID(112)); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("wrong task: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func testObservationReaderBoundsBatchBeforeQuery(t *testing.T, db *postgres.Store) {
	project := queryProject(t, db, 1)
	if err := postgres.ReadOnlySnapshot(t.Context(), db.Pool, func(tx pgx.Tx) error {
		counted := &countedReaderTx{Tx: tx}
		reader := pgsession.NewReader(counted)
		empty, err := reader.TaskSessionSources(t.Context(), project.ID, nil)
		if err != nil || empty == nil || len(empty) != 0 || counted.queries != 0 {
			t.Fatalf("empty batch: %#v %v queries=%d", empty, err, counted.queries)
		}
		ids := make([]string, 201)
		for i := range ids {
			ids[i] = queryID(1000 + i)
		}
		if _, err := reader.TaskSessionSources(t.Context(), project.ID, ids); err == nil || counted.queries != 0 {
			t.Fatalf("201-ID batch reached database: %v calls=%d", err, counted.queries)
		}
		if _, err := reader.TaskSessionSources(t.Context(), project.ID, ids[:200]); err != nil || counted.queries != 1 {
			t.Fatalf("200-ID batch: %v calls=%d", err, counted.queries)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func testObservationReaderProjectsHerdrWithoutFrames(t *testing.T, db *postgres.Store) {
	project := queryProject(t, db, 1)
	task := queryTask(t, db, project.ID, 11, model.TaskInProgress)
	worker, raw := readerWorker(t, queryID(100))
	raw = strings.ReplaceAll(raw, `"agentControlMode":"web"`, `"agentControlMode":"herdr"`)
	mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, task.ID, raw)
	state := `{"Envelope":{"sessionId":"` + queryID(111) + `","claimId":"` + worker.ClaimID + `","executionGeneration":"9"},"Owner":{"projectId":"` + project.ID + `","taskId":"` + task.ID + `","workerId":"` + worker.WorkerID + `","worktreeId":"` + worker.WorktreeID + `","provider":"codex"},"Binding":{"nativeSessionId":"native-terminal"},"ConnectionEpoch":"4","FinalizationID":null}`
	mustQueryExec(t, db, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,backend,snapshot,terminal_state) VALUES($1,$2,$3,$4,$5,$1,'{}','herdr',NULL,$6)`, queryID(111), project.ID, task.ID, worker.ClaimID, worker.UserID, state)
	if err := db.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
		sources, err := snapshot.SessionDAO().TaskSessionSources(t.Context(), project.ID, []string{task.ID})
		if err != nil {
			return err
		}
		got := sources[0].Session
		if got == nil || got.Backend != "herdr" || got.Fence.ExecutionGeneration != "9" || got.Fence.ConnectionEpoch != "4" || got.Identity.NativeSessionID == nil || *got.Identity.NativeSessionID != "native-terminal" || got.Identity.WorkerID != worker.WorkerID {
			t.Fatalf("herdr source: %#v", got)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
