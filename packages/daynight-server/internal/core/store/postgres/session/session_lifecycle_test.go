package session_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgbot "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	pgtask "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/google/uuid"
)

func awaitSessionStoreBlock(ctx context.Context, database *postgres.Store, blocker, waiter uint32, finished <-chan struct{}) error {
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var blocked bool
		if err := database.Pool.QueryRow(ctx, `SELECT $1::integer=ANY(pg_blocking_pids($2))`, blocker, waiter).Scan(&blocked); err != nil {
			return err
		}
		if blocked {
			return nil
		}
		select {
		case <-finished:
			return fmt.Errorf("backend %d completed without waiting on backend %d", waiter, blocker)
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func assertSessionArchiveAfterDeletion(t *testing.T, database *postgres.Store, task model.Task, id, digest, path string) {
	t.Helper()
	var deleted bool
	var version int64
	if err := database.Pool.QueryRow(t.Context(), `SELECT deleted_at IS NOT NULL,version FROM tasks WHERE id=$1`, task.ID).Scan(&deleted, &version); err != nil || !deleted || version != task.Version+1 {
		t.Fatalf("committed deletion: deleted=%v version=%d error=%v", deleted, version, err)
	}
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		status, object, err := dao.SessionArchive(t.Context(), id)
		if err != nil || status.State != "ready" || status.SHA256 == nil || *status.SHA256 != digest || status.ByteLength == nil || *status.ByteLength != "7" || object != path {
			t.Fatalf("archive receipt after deletion: %+v %q %v", status, object, err)
		}
		return nil
	})
}

func TestSessionArchiveWaitsForDeletionAndReadsCommittedState(t *testing.T) {
	database := isolatedStore(t)
	task, id := prepareArchiveSession(t, database)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	deletion, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer deletion.Rollback(context.Background())
	tasks := pgtask.NewWriter(deletion, task.ProjectID)
	if _, err := tasks.Task(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := tasks.DeleteTask(ctx, task.ID, false); err != nil {
		t.Fatal(err)
	}
	archive, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Rollback(context.Background())
	digest, path := strings.Repeat("a", 64), "archive/object"
	done := make(chan struct{})
	blocker, waiter := deletion.Conn().PgConn().PID(), archive.Conn().PgConn().PID()
	var readDeleted bool
	var archiveErr error
	go func() {
		defer close(done)
		dao := pgsession.New(archive)
		var current store.SessionTask
		current, readDeleted, archiveErr = dao.LockArchiveTask(ctx, task.ProjectID, task.ID)
		if archiveErr == nil && current.Status != string(model.TaskDone) {
			archiveErr = fmt.Errorf("archive read task status %q", current.Status)
		}
		if archiveErr == nil {
			archiveErr = dao.SetSessionArchiveReady(ctx, id, digest, 7, path)
		}
		if archiveErr == nil {
			archiveErr = archive.Commit(ctx)
		}
	}()
	waitErr := awaitSessionStoreBlock(ctx, database, blocker, waiter, done)
	commitErr := deletion.Commit(ctx)
	<-done
	if waitErr != nil || commitErr != nil || archiveErr != nil || !readDeleted {
		t.Fatalf("delete-first serialization: wait=%v commit=%v archive=%v deleted=%v", waitErr, commitErr, archiveErr, readDeleted)
	}
	assertSessionArchiveAfterDeletion(t, database, task, id, digest, path)
}

func TestSessionDeletionWaitsForArchiveAndRetainsReceipt(t *testing.T) {
	database := isolatedStore(t)
	task, id := prepareArchiveSession(t, database)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	archive, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Rollback(context.Background())
	dao := pgsession.New(archive)
	if _, deleted, err := dao.LockArchiveTask(ctx, task.ProjectID, task.ID); err != nil || deleted {
		t.Fatalf("initial archive task: deleted=%v error=%v", deleted, err)
	}
	digest, path := strings.Repeat("b", 64), "archive/object"
	if err := dao.SetSessionArchiveReady(ctx, id, digest, 7, path); err != nil {
		t.Fatal(err)
	}
	deletion, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer deletion.Rollback(context.Background())
	done := make(chan struct{})
	blocker, waiter := archive.Conn().PgConn().PID(), deletion.Conn().PgConn().PID()
	var deleteErr error
	go func() {
		defer close(done)
		tasks := pgtask.NewWriter(deletion, task.ProjectID)
		_, deleteErr = tasks.Task(ctx, task.ID)
		if deleteErr == nil {
			_, deleteErr = tasks.DeleteTask(ctx, task.ID, false)
		}
		if deleteErr == nil {
			deleteErr = deletion.Commit(ctx)
		}
	}()
	waitErr := awaitSessionStoreBlock(ctx, database, blocker, waiter, done)
	commitErr := archive.Commit(ctx)
	<-done
	if waitErr != nil || commitErr != nil || deleteErr != nil {
		t.Fatalf("archive-first serialization: wait=%v commit=%v delete=%v", waitErr, commitErr, deleteErr)
	}
	assertSessionArchiveAfterDeletion(t, database, task, id, digest, path)
}

func TestSessionBotArchiveAndCleanupSerializeOnBotLock(t *testing.T) {
	for _, archiveFirst := range []bool{true, false} {
		name := "cleanup first"
		if archiveFirst {
			name = "archive first"
		}
		t.Run(name, func(t *testing.T) {
			database := isolatedStore(t)
			bot := runtimeStoredBot(t, database)
			id := uuid.NewString()
			parent := uuid.NewString()
			hash := sha256.Sum256([]byte(parent))
			now := time.Now().UTC()
			mustQueryExec(t, database, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'archive witness',$4,$5)`, parent, bot.OwnerUserID, hash[:], now.Add(-time.Hour), now.Add(time.Hour))
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			sessionBotDAOTransaction(t, database, func(dao store.SessionDAO, bots store.BotWriteDAO) error {
				current, err := bots.Bot(ctx, bot.ID)
				if err != nil {
					return err
				}
				inserted, err := dao.InsertBotSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id}, OwnerID: bot.OwnerUserID, TestExecutionID: uuid.NewString(), RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{Lifecycle: "archived"}, ParentCredentialID: parent, BotID: &bot.ID})
				if err != nil || !inserted {
					t.Fatalf("Bot Session insertion: %v %v", inserted, err)
				}
				_, err = bots.BindBotSession(ctx, bot.ID, current.Version, id, model.BotRoleConfiguration{Instructions: "Archive witness", Revision: "1", Digest: strings.Repeat("a", 64)})
				return err
			})
			holder, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(context.Background())
			holderBots, holderSessions := pgbot.NewWriter(holder), pgsession.New(holder)
			if _, err := holderBots.Bot(ctx, bot.ID); err != nil {
				t.Fatal(err)
			}
			deletion := &model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: 2, WorkerCleanup: model.BotCleanupResult{State: "completed"}, ServerCleanup: model.BotCleanupResult{State: "completed"}}
			digest, path := strings.Repeat("d", 64), "archive/bot"
			if archiveFirst {
				if _, err := holderSessions.LockSession(ctx, id); err != nil {
					t.Fatal(err)
				}
				if err := holderSessions.SetSessionArchiveReady(ctx, id, digest, 7, path); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err := holderSessions.LockBotSessions(ctx, bot.ID); err != nil {
					t.Fatal(err)
				}
				if err := holderSessions.DeleteBotSession(ctx, id, bot.ID); err != nil {
					t.Fatal(err)
				}
				if err := holderSessions.RedactDeletedBot(ctx, bot.ID); err != nil {
					t.Fatal(err)
				}
				if _, err := holderBots.SaveBotDeletion(ctx, bot.ID, deletion); err != nil {
					t.Fatal(err)
				}
			}
			waiter, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer waiter.Rollback(context.Background())
			waiterBots, waiterSessions := pgbot.NewWriter(waiter), pgsession.New(waiter)
			done := make(chan struct{})
			blocker, reader := holder.Conn().PgConn().PID(), waiter.Conn().PgConn().PID()
			var observed model.Bot
			var readErr error
			go func() {
				defer close(done)
				observed, readErr = waiterBots.Bot(ctx, bot.ID)
			}()
			waitErr := awaitSessionStoreBlock(ctx, database, blocker, reader, done)
			commitErr := holder.Commit(ctx)
			<-done
			if waitErr != nil || commitErr != nil || readErr != nil {
				t.Fatalf("Bot lock ordering: wait=%v commit=%v read=%v", waitErr, commitErr, readErr)
			}
			if archiveFirst {
				if observed.SessionID == nil || *observed.SessionID != id || observed.Deletion != nil {
					t.Fatalf("archive-first Bot binding changed: %+v", observed)
				}
				pending := *deletion
				pending.WorkerCleanup.State, pending.ServerCleanup.State = "pending", "pending"
				if _, err := waiterBots.SaveBotDeletion(ctx, bot.ID, &pending); err != nil {
					t.Fatal(err)
				}
				if err := waiter.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				sessionBotDAOTransaction(t, database, func(dao store.SessionDAO, bots store.BotWriteDAO) error {
					status, object, err := dao.SessionArchive(ctx, id)
					if err != nil || status.State != "ready" || status.SHA256 == nil || *status.SHA256 != digest || object != path {
						t.Fatalf("archive commit lost at deletion intent: %+v %q %v", status, object, err)
					}
					if _, err := bots.Bot(ctx, bot.ID); err != nil {
						return err
					}
					if _, err := dao.LockBotSessions(ctx, bot.ID); err != nil {
						return err
					}
					if err := dao.DeleteBotSession(ctx, id, bot.ID); err != nil {
						return err
					}
					if err := dao.RedactDeletedBot(ctx, bot.ID); err != nil {
						return err
					}
					_, err = bots.SaveBotDeletion(ctx, bot.ID, deletion)
					return err
				})
			} else {
				if observed.SessionID != nil || observed.Deletion == nil || observed.Deletion.ServerCleanup.State != "completed" {
					t.Fatalf("post-lock Bot read used pre-cleanup state: %+v", observed)
				}
				if _, err := waiterSessions.LockSession(ctx, id); !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("cleaned Session remained readable: %v", err)
				}
				if err := waiter.Commit(ctx); err != nil {
					t.Fatal(err)
				}
			}
			var sessions, archives int
			if err := database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM task_sessions WHERE id=$1),(SELECT count(*) FROM session_archives WHERE session_id=$1)`, id).Scan(&sessions, &archives); err != nil || sessions != 0 || archives != 0 {
				t.Fatalf("Bot cleanup left Session/archive metadata: sessions=%d archives=%d error=%v", sessions, archives, err)
			}
		})
	}
}

func testSessionDAOLedgerAndArchive(t *testing.T, db *postgres.Store) {
	ctx := context.Background()
	_, principal, _ := testAuthRecords(t, db)
	id, execution, registration := uuid.NewString(), uuid.NewString(), uuid.NewString()
	fence := sp.Fence{SessionID: id, TestExecutionID: execution, ExecutionGeneration: "1"}
	first, response := uuid.NewString(), uuid.NewString()
	interaction := uuid.NewString()
	command := sp.Command{Fence: fence, OperationID: first, Kind: "send_message", Payload: json.RawMessage(`{}`)}
	receipt := sp.Operation{Fence: fence, OperationID: first, Kind: "send_message", State: "accepted"}
	responseCommand := sp.Command{Fence: fence, OperationID: response, Kind: "interaction_response", Payload: json.RawMessage(`{"interactionId":"` + interaction + `"}`)}
	responseReceipt := sp.Operation{Fence: fence, OperationID: response, Kind: "interaction_response", State: "offered"}
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if err := dao.InsertTestSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id}, OwnerID: principal.UserID, TestExecutionID: execution, RegistrationID: registration, Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: fence}}, ParentCredentialID: principal.CredentialID}); err != nil {
			return err
		}
		if err := dao.InsertSessionOperation(ctx, store.SessionOperation{SessionID: id, OperationID: first, Seq: 1, Hash: []byte("first"), Actor: principal, Command: command, Receipt: receipt}); err != nil {
			return err
		}
		if err := dao.InsertSessionOperation(ctx, store.SessionOperation{SessionID: id, OperationID: response, Seq: 2, Hash: []byte("response"), Actor: principal, Command: responseCommand, Receipt: responseReceipt}); err != nil {
			return err
		}
		loaded, err := dao.SessionOperation(ctx, id, first)
		if err != nil || loaded.Command.Kind != "send_message" || loaded.Actor.UserID != principal.UserID || loaded.Receipt.State != "accepted" {
			t.Fatalf("operation: %+v %v", loaded, err)
		}
		duplicate, err := dao.HasOtherFirstInput(ctx, id, uuid.NewString())
		if err != nil || !duplicate {
			t.Fatalf("first input fence: %v %v", duplicate, err)
		}
		duplicate, err = dao.HasInteractionResponse(ctx, id, uuid.NewString(), interaction)
		if err != nil || !duplicate {
			t.Fatalf("interaction fence: %v %v", duplicate, err)
		}
		count, err := dao.PendingSessionOperationCount(ctx, id)
		if err != nil || count != 2 {
			t.Fatalf("pending: %d %v", count, err)
		}
		accepted, err := dao.AcceptedSessionOperations(ctx, id)
		if err != nil || !reflect.DeepEqual(accepted, []string{first}) {
			t.Fatalf("accepted: %v %v", accepted, err)
		}
		stopping, err := dao.StoppingTestOperations(ctx, id)
		if err != nil || len(stopping) != 2 {
			t.Fatalf("stopping: %v %v", stopping, err)
		}
		if err := dao.SetSessionOperationEpoch(ctx, id, response, 1); err != nil {
			return err
		}
		unresolved, err := dao.UnreconciledSessionOperations(ctx, id, 2)
		if err != nil || !reflect.DeepEqual(unresolved, []string{response}) {
			t.Fatalf("reconcile: %v %v", unresolved, err)
		}
		count, err = dao.UnreconciledSessionOperationCount(ctx, id, 2)
		if err != nil || count != 1 {
			t.Fatalf("reconcile count: %d %v", count, err)
		}
		responseReceipt.State = "rejected"
		if err := dao.SetSessionOperationReceipt(ctx, responseReceipt); err != nil {
			return err
		}
		duplicate, err = dao.HasInteractionResponse(ctx, id, uuid.NewString(), interaction)
		if err != nil || duplicate {
			t.Fatalf("rejected response blocks retry: %v %v", duplicate, err)
		}
		status, _, err := dao.SessionArchive(ctx, id)
		if err != nil || status.State != "unavailable" {
			t.Fatalf("empty archive: %+v %v", status, err)
		}
		if err := dao.SetSessionArchiveState(ctx, id, "pending", nil); err != nil {
			return err
		}
		digest, path := strings.Repeat("a", 64), "users/archive.json"
		if err := dao.SetSessionArchiveReady(ctx, id, digest, 21, path); err != nil {
			return err
		}
		status, gotPath, err := dao.SessionArchive(ctx, id)
		if err != nil || status.SHA256 == nil || *status.SHA256 != digest || gotPath != path {
			t.Fatalf("ready archive: %+v %q %v", status, gotPath, err)
		}
		return nil
	})
}

func testBotSessionCleanupIsTransactional(t *testing.T, db *postgres.Store) {
	ctx := t.Context()
	_, actor, _ := testAuthRecords(t, db)
	bot, worker, id := uuid.NewString(), uuid.NewString(), uuid.NewString()
	now := time.Now().UTC()
	parent := model.Principal{Kind: model.PATCredential, UserID: actor.UserID, CredentialID: uuid.NewString()}
	current := model.Principal{Kind: model.PATCredential, UserID: actor.UserID, CredentialID: uuid.NewString()}
	for _, credential := range []model.Principal{parent, current} {
		hash := sha256.Sum256([]byte(credential.CredentialID))
		mustQueryExec(t, db, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'bot runtime',$4,$5)`, credential.CredentialID, credential.UserID, hash[:], now, now.Add(time.Hour))
	}
	mustQueryExec(t, db, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,$3,$3,'{}','{}')`, actor.UserID, worker, now)
	mustQueryExec(t, db, `INSERT INTO bots(id,owner_user_id,worker_id,name,request_fingerprint,requested_overrides,resolved_configuration,startup_result,session_id) VALUES($1,$2,$3,'Private Bot',$4,'{"args":[]}','{"provider":"codex"}','{}',$5)`, bot, actor.UserID, worker, strings.Repeat("a", 64), id)
	registration := store.SessionRegistration{Location: store.SessionLocation{SessionID: id}, OwnerID: actor.UserID, TestExecutionID: uuid.NewString(), RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ExecutionGeneration: "1"}}, Lifecycle: "active"}, ParentCredentialID: parent.CredentialID, BotID: &bot}
	epoch := uuid.NewString()
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		inserted, err := dao.InsertBotSession(ctx, registration)
		if err != nil || !inserted {
			t.Fatalf("insert bot session: %v %v", inserted, err)
		}
		inserted, err = dao.InsertBotSession(ctx, registration)
		if err != nil || inserted {
			t.Fatalf("duplicate bot session: %v %v", inserted, err)
		}
		// The inserted parent is checked before SetSessionGrant can overwrite it.
		registered, err := dao.LockSession(ctx, id)
		if err != nil || registered.Parent != parent.CredentialID || registered.BotID == nil || *registered.BotID != bot || registered.Owner != actor.UserID {
			t.Fatalf("inserted Bot Session lost its parent association: %+v %v", registered, err)
		}
		bound, err := dao.SessionBotID(ctx, id)
		if err != nil || bound == nil || *bound != bot {
			t.Fatalf("session binding: %v %v", bound, err)
		}
		sessions, err := dao.LockBotSessions(ctx, bot)
		if err != nil || len(sessions) != 1 || sessions[0].ID != id || sessions[0].Owner != actor.UserID {
			t.Fatalf("bot sessions: %+v %v", sessions, err)
		}
		if err := dao.SetSessionGrant(ctx, store.SessionGrant{SessionID: id, Hash: []byte("bot grant"), ExpiresAt: now.Add(time.Hour), Kind: "bootstrap", ParentCredentialID: parent.CredentialID}); err != nil {
			return err
		}
		if err := dao.ConnectSession(ctx, id, uuid.NewString(), now, ptrTime(now.Add(time.Hour))); err != nil {
			return err
		}
		record, err := dao.LockSession(ctx, id)
		if err != nil {
			return err
		}
		record.SourceEpoch = &epoch
		record.SourceEpochs = []string{epoch}
		record.SourceSeq = 7
		record.OperationSeq = 8
		record.Snapshot.SessionRevision = "4"
		if err := dao.SaveSession(ctx, record); err != nil {
			return err
		}
		record, err = dao.LockSession(ctx, id)
		if err != nil || record.SourceEpoch == nil || *record.SourceEpoch != epoch || len(record.SourceEpochs) != 1 || record.SourceSeq != 7 || record.OperationSeq != 8 || record.Snapshot.SessionRevision != "4" {
			t.Fatalf("saved ledger versions: %+v %v", record, err)
		}
		return nil
	})
	assertCredentials := func(parentExists bool) {
		sessionBotDAOTransaction(t, db, func(dao store.SessionDAO, bots store.BotWriteDAO) error {
			bound, err := bots.Bot(ctx, bot)
			if err != nil {
				return err
			}
			record, err := dao.LockSession(ctx, id)
			if err != nil {
				return err
			}
			if bound.SessionID == nil || *bound.SessionID != id || record.BotID == nil || *record.BotID != bot || record.Owner != actor.UserID || record.Parent != parent.CredentialID || record.ConnectionParent != parent.CredentialID || string(record.GrantHash) != "bot grant" || record.ConnectionExpiry == nil {
				t.Fatalf("stored live Bot Session lost its parent association: bot=%+v session=%+v", bound, record)
			}
			if err := dao.LockCredential(ctx, current, now); err != nil {
				t.Fatalf("current PAT rejected while checking parent: %v", err)
			}
			registered := model.Principal{Kind: model.PATCredential, UserID: record.Owner, CredentialID: record.Parent}
			err = dao.LockCredential(ctx, registered, now)
			if parentExists {
				return err
			}
			if !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("deleted stored parent PAT accepted: %v", err)
			}
			return nil
		})
	}
	assertCredentials(true)
	mustQueryExec(t, db, `DELETE FROM personal_access_tokens WHERE id=$1`, parent.CredentialID)
	assertCredentials(false)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if err := dao.RevokeBotSessions(ctx, bot); err != nil {
			return err
		}
		proof, err := dao.LockBotSessionStop(ctx, id, bot, actor.UserID)
		if err != nil || !proof.Consumed || proof.SourceEpoch == nil || *proof.SourceEpoch != epoch {
			t.Fatalf("bot stop proof: %+v %v", proof, err)
		}
		record, err := dao.LockSession(ctx, id)
		if err != nil || record.GrantHash != nil || record.ConnectionExpiry != nil {
			t.Fatalf("revocation: %+v %v", record, err)
		}
		if _, err := dao.LockBotSessionStop(ctx, id, bot, uuid.NewString()); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("foreign owner stop: %v", err)
		}
		return nil
	})
	mustQueryExec(t, db, `UPDATE task_sessions SET snapshot='[]' WHERE id=$1`, id)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if _, err := dao.LockBotSessionStop(ctx, id, bot, actor.UserID); err == nil {
			t.Fatal("corrupt bot stop snapshot accepted")
		}
		return nil
	})
	raw, err := json.Marshal(registration.Snapshot)
	if err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, db, `UPDATE task_sessions SET snapshot=$2 WHERE id=$1`, id, raw)
	op := uuid.NewString()
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if err := dao.InsertSessionOperation(ctx, store.SessionOperation{SessionID: id, OperationID: op, Seq: 1, Hash: []byte("operation"), Actor: actor, Command: sp.Command{Kind: "send_message", Payload: json.RawMessage(`{}`)}, Receipt: sp.Operation{State: "accepted"}}); err != nil {
			return err
		}
		if err := dao.InsertRecordingEvidence(ctx, id, 1, uuid.NewString(), 1, strings.Repeat("c", 64)); err != nil {
			return err
		}
		return dao.SetSessionArchiveReady(ctx, id, strings.Repeat("b", 64), 10, "archive.json")
	})
	mustQueryExec(t, db, `INSERT INTO session_events(session_id,event_seq,event) VALUES($1,1,'{}')`, id)
	mustQueryExec(t, db, `INSERT INTO session_timeline(session_id,entry_id,entry_seq,revision,entry) VALUES($1,$2,1,1,'{}')`, id, uuid.NewString())
	resource := uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO session_resources(session_id,resource_id,descriptor) VALUES($1,$2,'{}')`, id, resource)
	// Seed every media child independently of business admission: this test owns
	// the real transaction's cleanup closure, including rollback and account scope.
	mediaRows := map[string]string{
		"session_operation_intents":   `INSERT INTO session_operation_intents(session_id,operation_id,canonical_bytes) VALUES($1,$3,'intent')`,
		"session_resource_references": `INSERT INTO session_resource_references(session_id,resource_id,kind,reference_id) VALUES($1,$4,'message','message')`,
		"session_image_uploads":       `INSERT INTO session_image_uploads(session_id,upload_id,actor_id,image_id,blob_id,spec,receipt,expires_at) VALUES($1,$3,$2,$3,$4,'{}','{"state":"complete"}',now())`,
		"session_image_chunks":        `INSERT INTO session_image_chunks(session_id,upload_id,chunk_offset,byte_length,sha256,blob_path) VALUES($1,$3,0,1,repeat('a',64),'chunk')`,
		"session_image_captures":      `INSERT INTO session_image_captures(session_id,capture_id,image_id,request,receipt) VALUES($1,$3,$3,'{}','{}')`,
		"session_resource_leases":     `INSERT INTO session_resource_leases(session_id,lease_id,owner_id,kind,resource_id,delete_epoch) VALUES($1,$3,$2,'read',$4,0)`,
		"session_resource_state":      `INSERT INTO session_resource_state(session_id,delete_epoch,deleting) VALUES($1,1,true)`,
		"session_media_requests":      `INSERT INTO session_media_requests(session_id,request_id,action,fence,body) VALUES($1,$3,'prepare','{}','{}')`,
		"session_source_hashes":       `INSERT INTO session_source_hashes(session_id,source_epoch,kind,source_seq,identity,digest) VALUES($1,$3,'event',1,'1',decode(repeat('a',64),'hex'))`,
		"session_archive_bundles":     `INSERT INTO session_archive_bundles(session_id,prepare_id,phase,revision,identity) VALUES($1,$3,'verified',1,'{}')`,
		"session_archive_files":       `INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path) VALUES($1,$3,'history',repeat('a',64),1,1,'complete','history')`,
		"session_archive_chunks":      `INSERT INTO session_archive_chunks(session_id,file_id,chunk_offset,byte_length,sha256,object_path) VALUES($1,$3,0,1,repeat('a',64),'chunk')`,
		"session_archive_migrations":  `INSERT INTO session_archive_migrations(session_id,migration_id,source_path,source_hash,source_byte_length,phase) VALUES($1,$3,'legacy',repeat('a',64),1,'verified')`,
	}
	for _, query := range mediaRows {
		// A CTE gives all statements the same typed arguments without relying on
		// the number of placeholders used by each child table.
		query = strings.ReplaceAll(query, "$1", "fixture.session_id")
		query = strings.ReplaceAll(query, "$2", "fixture.owner_id")
		query = strings.ReplaceAll(query, "$3", "fixture.operation_id")
		query = strings.ReplaceAll(query, "$4", "fixture.resource_id")
		query = strings.Replace(query, " VALUES(", " SELECT ", 1)
		query = strings.TrimSuffix(query, ")") + " FROM fixture"
		mustQueryExec(t, db, `WITH fixture AS (SELECT $1::uuid session_id,$2::uuid owner_id,$3::uuid operation_id,$4::uuid resource_id) `+query, id, actor.UserID, op, resource)
	}
	mustQueryExec(t, db, `INSERT INTO session_media_rates(owner_user_id,category,tokens,updated_at) VALUES($1,'control',1,$2)`, actor.UserID, now)
	assertMediaRows := func(want int) {
		t.Helper()
		for table := range mediaRows {
			var count int
			if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE session_id=$1`, id).Scan(&count); err != nil || count != want {
				t.Fatalf("%s cleanup: %d want %d: %v", table, count, want, err)
			}
		}
		var tokens int64
		if err := db.Pool.QueryRow(ctx, `SELECT tokens FROM session_media_rates WHERE owner_user_id=$1 AND category='control'`, actor.UserID).Scan(&tokens); err != nil || tokens != 1 {
			t.Fatalf("Session cleanup changed the account bucket: %d %v", tokens, err)
		}
	}
	cleanup := func(commit bool) {
		tx, err := db.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer rollbackSessionTestTransaction(t, tx)
		dao := pgsession.New(tx)
		if err := dao.DeleteBotSession(ctx, id, bot); err != nil {
			t.Fatal(err)
		}
		if err := dao.RedactDeletedBot(ctx, bot); err != nil {
			t.Fatal(err)
		}
		if commit {
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
		}
	}
	cleanup(false)
	assertMediaRows(1)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if _, err := dao.LockSession(ctx, id); err != nil {
			return err
		}
		count, err := dao.PendingSessionOperationCount(ctx, id)
		if err != nil || count != 1 {
			t.Fatalf("rollback lost operation: %d %v", count, err)
		}
		return nil
	})
	cleanup(true)
	assertMediaRows(0)
	for _, table := range []string{"task_sessions", "session_events", "session_timeline", "session_operations", "session_resources", "session_archives", "session_recording_evidence"} {
		column := "session_id"
		if table == "task_sessions" {
			column = "id"
		}
		var count int
		if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE `+column+`=$1`, id).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s cleanup: %d %v", table, count, err)
		}
	}
	var name string
	var bound *string
	var configuration []byte
	if err := db.Pool.QueryRow(ctx, `SELECT name,session_id::text,resolved_configuration FROM bots WHERE id=$1`, bot).Scan(&name, &bound, &configuration); err != nil || name != "Deleted" || bound != nil || string(configuration) != "{}" {
		t.Fatalf("bot redaction: %q %v %s %v", name, bound, configuration, err)
	}
}

func testNativeSessionLedgerDoesNotCreateLegacyContentRows(t *testing.T, db *postgres.Store) {
	database := db
	_, owner, _ := testAuthRecords(t, database)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskInProgress)
	id, claim, epoch, operation := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	fence := sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: fence, ConnectionEpoch: "1"}, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, Identity: sp.Identity{ProjectID: project.ID, TaskID: task.ID, OwnerUserID: owner.UserID, Provider: "codex"}, SessionRevision: "3", HistoryEpoch: uuid.NewString(), LastEventSeq: "0", LastTimelineSeq: "1", InitialInputState: "confirmed", Lifecycle: "active", ConnectionState: "disconnected", Activity: "unknown"}
	now := time.Now().UTC().Truncate(time.Microsecond)
	expiry := now.Add(time.Hour)
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		if err := dao.InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: claim, OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: snapshot}); err != nil {
			return err
		}
		return dao.ConnectSession(t.Context(), id, uuid.NewString(), now, &expiry)
	})
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		record, err := dao.LockSession(t.Context(), id)
		if err != nil {
			return err
		}
		record.SourceEpoch, record.SourceEpochs, record.SourceSeq = &epoch, []string{epoch}, 3
		if err := dao.SaveSession(t.Context(), record); err != nil {
			return err
		}
		return dao.TouchSession(t.Context(), id, now)
	})
	assertNoLegacyRows := func() {
		t.Helper()
		for _, table := range []string{"session_events", "session_timeline", "session_resources"} {
			var count int
			if err := database.Pool.QueryRow(t.Context(), `SELECT count(*) FROM `+table+` WHERE session_id=$1`, id).Scan(&count); err != nil || count != 0 {
				t.Fatalf("native Session stored legacy content in %s: count=%d error=%v", table, count, err)
			}
		}
	}
	assertNoLegacyRows()
	hash := sha256.Sum256([]byte("native control intent"))
	command := sp.Command{Fence: fence, Protocol: sp.Protocol, OperationID: operation, Kind: "send_message", Payload: json.RawMessage(`{}`)}
	receipt := sp.Operation{Fence: fence, Protocol: sp.Protocol, OperationID: operation, Kind: command.Kind, State: "accepted"}
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		if err := dao.InsertSessionOperation(t.Context(), store.SessionOperation{SessionID: id, OperationID: operation, Seq: 1, Hash: hash[:], Actor: owner, Command: command, Receipt: receipt}); err != nil {
			return err
		}
		receipt.State = "confirmed"
		if err := dao.SetSessionOperationReceipt(t.Context(), receipt); err != nil {
			return err
		}
		record, err := dao.LockSession(t.Context(), id)
		if err != nil {
			return err
		}
		record.OperationSeq = 1
		return dao.SaveSession(t.Context(), record)
	})
	assertNoLegacyRows()
	var source, operations int64
	var state string
	if err := database.Pool.QueryRow(t.Context(), `SELECT last_source_seq,last_operation_seq,(SELECT receipt->>'state' FROM session_operations WHERE session_id=$1 AND operation_id=$2) FROM task_sessions WHERE id=$1`, id, operation).Scan(&source, &operations, &state); err != nil || source != 3 || operations != 1 || state != "confirmed" {
		t.Fatalf("native control ledger did not commit: source=%d operations=%d receipt=%s error=%v", source, operations, state, err)
	}
}

func testSessionOperationPreservesStoredHashBytes(t *testing.T, db *postgres.Store) {
	database := db
	_, actor, _ := testAuthRecords(t, database)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskInProgress)
	id, claim, operation := uuid.NewString(), uuid.NewString(), uuid.NewString()
	fence := sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}
	command := sp.Command{Fence: fence, Protocol: sp.Protocol, RequestID: "hash", OperationID: operation, Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"<script>&\u2028"}],"expectedTurnId":null}`)}
	expected := [32]byte{
		0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
		0x10, 0x32, 0x54, 0x76, 0x98, 0xba, 0xdc, 0xfe,
		0x02, 0x46, 0x8a, 0xce, 0x13, 0x57, 0x9b, 0xdf,
		0x20, 0x64, 0xa8, 0xec, 0x31, 0x75, 0xb9, 0xfd,
	}
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		if err := dao.InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: claim, OwnerID: actor.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: fence}, Lifecycle: "active"}}); err != nil {
			return err
		}
		return dao.InsertSessionOperation(t.Context(), store.SessionOperation{SessionID: id, OperationID: operation, Seq: 1, Hash: expected[:], Actor: actor, Command: command, Receipt: sp.Operation{Fence: fence, OperationID: operation, Kind: command.Kind, State: "accepted"}})
	})
	assertHash := func() {
		t.Helper()
		sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
			loaded, err := dao.SessionOperation(t.Context(), id, operation)
			if err != nil || !bytes.Equal(loaded.Hash, expected[:]) {
				t.Fatalf("stored hash bytes changed on read: got=%x want=%x error=%v", loaded.Hash, expected, err)
			}
			return nil
		})
	}
	assertHash()
	expected[0] ^= 0xff
	mustQueryExec(t, database, `UPDATE session_operations SET body_hash=$1 WHERE session_id=$2 AND operation_id=$3`, expected[:], id, operation)
	assertHash()
}
