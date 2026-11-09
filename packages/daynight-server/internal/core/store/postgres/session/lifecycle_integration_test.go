package session_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
)

func TestBotSessionCleanupIsTransactional(t *testing.T) {
	db := isolatedStore(t)
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
	mustQueryExec(t, db, `INSERT INTO session_resources(session_id,resource_id,descriptor) VALUES($1,$2,'{}')`, id, uuid.NewString())
	cleanup := func(commit bool) {
		tx, err := db.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(context.Background())
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

func TestSessionCredentialKindsAndMissingIdentity(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	_, actor, _ := testAuthRecords(t, db)
	now := time.Now().UTC()
	token, grant := uuid.NewString(), uuid.NewString()
	hash := sha256.Sum256([]byte(token))
	mustQueryExec(t, db, `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)`, token, grant, actor.UserID, hash[:], now, now.Add(time.Minute))
	oauth := model.Principal{Kind: model.OAuthCredential, UserID: actor.UserID, CredentialID: token}
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if err := dao.LockCredential(ctx, oauth, now); err != nil {
			return err
		}
		if err := dao.LockCredential(ctx, model.Principal{Kind: "unknown"}, now); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("unknown credential: %v", err)
		}
		if _, err := dao.ProjectAccess(ctx, actor.UserID, uuid.NewString()); err == nil {
			t.Fatal("missing project access accepted")
		}
		return nil
	})
	mustQueryExec(t, db, `DELETE FROM oauth_access_tokens WHERE id=$1`, token)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if err := dao.LockCredential(ctx, oauth, now); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("deleted OAuth token: %v", err)
		}
		return nil
	})
}

func TestSessionReadsRejectCorruptPersistedJSON(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	_, actor, _ := testAuthRecords(t, db)
	id, operation := uuid.NewString(), uuid.NewString()
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if err := dao.InsertTestSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id}, OwnerID: actor.UserID, TestExecutionID: uuid.NewString(), RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id}}}, ParentCredentialID: actor.CredentialID}); err != nil {
			return err
		}
		return dao.InsertSessionOperation(ctx, store.SessionOperation{SessionID: id, OperationID: operation, Seq: 1, Hash: []byte("operation"), Actor: actor, Command: sp.Command{Payload: json.RawMessage(`{}`)}, Receipt: sp.Operation{State: "accepted"}})
	})
	for _, column := range []string{"command", "receipt"} {
		mustQueryExec(t, db, `UPDATE session_operations SET `+column+`='[]' WHERE session_id=$1`, id)
		sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
			if _, err := dao.SessionOperation(ctx, id, operation); err == nil {
				t.Fatalf("corrupt %s accepted", column)
			}
			if column == "receipt" {
				if _, err := dao.TerminalOperation(ctx, id, operation); err == nil {
					t.Fatal("corrupt terminal result accepted")
				}
			}
			return nil
		})
		mustQueryExec(t, db, `UPDATE session_operations SET `+column+`='{}' WHERE session_id=$1`, id)
	}
	mustQueryExec(t, db, `UPDATE task_sessions SET snapshot='[]' WHERE id=$1`, id)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if _, err := dao.LockSession(ctx, id); err == nil {
			t.Fatal("corrupt session snapshot accepted")
		}
		err := dao.InsertSessionOperation(ctx, store.SessionOperation{Command: sp.Command{Payload: json.RawMessage(`{`)}})
		if err == nil {
			t.Fatal("invalid command JSON accepted")
		}
		return nil
	})
	final := uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO session_archives(session_id,state,schema_version,finalization_id,receipt) VALUES($1,'unavailable',2,$2,'[]')`, id, final)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if _, _, _, err := dao.TerminalArchive(ctx, id); err == nil {
			t.Fatal("corrupt terminal archive receipt accepted")
		}
		return nil
	})
}

func TestTestSessionListFiltersCredentialAndPaginates(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	_, actor, _ := testAuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	pat := uuid.NewString()
	hash := sha256.Sum256([]byte(pat))
	mustQueryExec(t, db, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'list',$4,$5)`, pat, actor.UserID, hash[:], now.Add(-time.Hour), now.Add(time.Hour))
	fresh, older, revoked := uuid.NewString(), uuid.NewString(), uuid.NewString()
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		for _, id := range []string{fresh, older, revoked} {
			parent := pat
			if id == revoked {
				parent = uuid.NewString()
			}
			if err := dao.InsertTestSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id}, OwnerID: actor.UserID, TestExecutionID: uuid.NewString(), RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id}}, Lifecycle: "active"}, ParentCredentialID: parent}); err != nil {
				return err
			}
		}
		if err := dao.ConnectSession(ctx, fresh, uuid.NewString(), now, ptrTime(now.Add(time.Hour))); err != nil {
			return err
		}
		return nil
	})
	mustQueryExec(t, db, `UPDATE task_sessions SET created_at=$1 WHERE id IN ($2,$3,$4)`, now.Add(-time.Hour), fresh, older, revoked)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		listed, err := dao.ListTestSessions(ctx, actor.UserID, now, 1, false, now.Add(-time.Minute), nil, "")
		if err != nil || len(listed) != 2 || listed[0].Snapshot.SessionID != fresh || listed[1].Snapshot.SessionID != older {
			t.Fatalf("list order and lookahead: %+v %v", listed, err)
		}
		cursor := listed[0].UpdatedAt
		listed, err = dao.ListTestSessions(ctx, actor.UserID, now, 1, false, now.Add(-time.Minute), &cursor, fresh)
		if err != nil || len(listed) != 1 || listed[0].Snapshot.SessionID != older {
			t.Fatalf("list cursor: %+v %v", listed, err)
		}
		listed, err = dao.ListTestSessions(ctx, actor.UserID, now, 10, true, now.Add(-time.Minute), nil, "")
		if err != nil || len(listed) != 1 || listed[0].Snapshot.SessionID != fresh {
			t.Fatalf("online filter: %+v %v", listed, err)
		}
		listed, err = dao.ListTestSessions(ctx, uuid.NewString(), now, 10, false, now.Add(-time.Minute), nil, "")
		if err != nil || len(listed) != 0 {
			t.Fatalf("foreign owner filter: %+v %v", listed, err)
		}
		return nil
	})
}
