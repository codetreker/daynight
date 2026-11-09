package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func sessionDAOTransaction(t *testing.T, db *Store, fn func(store.SessionScope) error) {
	t.Helper()
	completion, err := db.WriteSession(context.Background(), fn)
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("session transaction: %+v %v", completion, err)
	}
}

func TestSessionDAOBotDeletionCleanupCanRollBackAndRetry(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	bot, principal := storedBotCandidate(t, db)
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error { return scope.BotDAO().InsertBot(ctx, bot) })
	id, execution, registration := uuid.NewString(), uuid.NewString(), uuid.NewString()
	fence := sp.Fence{SessionID: id, TestExecutionID: execution, ExecutionGeneration: "1"}
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: fence, ConnectionEpoch: "0"}, Identity: sp.Identity{OwnerUserID: principal.UserID}}
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		current, err := scope.BotDAO().Bot(ctx, bot.ID)
		if err != nil {
			return err
		}
		inserted, err := scope.SessionDAO().InsertBotSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id}, OwnerID: principal.UserID, TestExecutionID: execution, RegistrationID: registration, Registration: []byte(`{}`), Snapshot: snapshot, ParentCredentialID: principal.CredentialID, BotID: &bot.ID})
		if err != nil || !inserted {
			t.Fatalf("bind insert: %v %v", inserted, err)
		}
		role := model.BotRoleConfiguration{Instructions: "Frozen role", Revision: "1", Digest: strings.Repeat("a", 64)}
		_, err = scope.BotDAO().BindBotSession(ctx, bot.ID, current.Version, id, role)
		return err
	})
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		if _, err := scope.BotDAO().Bot(ctx, bot.ID); err != nil {
			return err
		}
		sessions, err := dao.LockBotSessions(ctx, bot.ID)
		if err != nil || len(sessions) != 1 || sessions[0].ID != id || sessions[0].Owner != principal.UserID || sessions[0].Scope != "test" {
			t.Fatalf("locked sessions: %+v %v", sessions, err)
		}
		owner, err := dao.SessionBotID(ctx, id)
		if err != nil || owner == nil || *owner != bot.ID {
			t.Fatalf("binding: %v %v", owner, err)
		}
		if err := dao.SetSessionGrant(ctx, store.SessionGrant{SessionID: id, Hash: []byte("bot grant"), ExpiresAt: time.Now().Add(time.Hour), Kind: "bootstrap", ParentCredentialID: principal.CredentialID}); err != nil {
			return err
		}
		proof, err := dao.LockBotSessionStop(ctx, id, bot.ID, principal.UserID)
		if err != nil || proof.Snapshot.Fence != fence || proof.Consumed || proof.SourceEpoch != nil {
			t.Fatalf("stop proof: %+v %v", proof, err)
		}
		opID := uuid.NewString()
		if err := dao.InsertSessionOperation(ctx, store.SessionOperation{SessionID: id, OperationID: opID, Seq: 1, Hash: []byte("child"), Actor: principal, Command: sp.Command{Fence: fence, OperationID: opID, Kind: "send_message", Payload: json.RawMessage(`{}`)}, Receipt: sp.Operation{Fence: fence, OperationID: opID, State: "accepted"}}); err != nil {
			return err
		}
		return dao.InsertRecordingEvidence(ctx, id, 1, uuid.NewString(), 1, strings.Repeat("c", 64))
	})
	state := func() string {
		t.Helper()
		var result string
		if err := db.Pool.QueryRow(ctx, `SELECT jsonb_build_object(
   'bot',to_jsonb(b),
   'sessions',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM task_sessions r WHERE r.bot_id=b.id),
   'operations',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.operation_id),'[]'::jsonb) FROM session_operations r WHERE r.session_id=$2),
   'events',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM session_events r WHERE r.session_id=$2),
   'timeline',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM session_timeline r WHERE r.session_id=$2),
   'resources',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM session_resources r WHERE r.session_id=$2),
   'archives',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM session_archives r WHERE r.session_id=$2),
   'recording',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.evidence_id),'[]'::jsonb) FROM session_recording_evidence r WHERE r.session_id=$2),
   'workerPreferences',(SELECT COALESCE(jsonb_agg(to_jsonb(r)),'[]'::jsonb) FROM bot_worker_preferences r WHERE r.user_id=b.owner_user_id),
   'configurationPreferences',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.worker_id),'[]'::jsonb) FROM bot_configuration_preferences r WHERE r.user_id=b.owner_user_id))::text FROM bots b WHERE b.id=$1`, bot.ID, id).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	blocked := func(caller model.Principal, expired bool, operation func(context.Context, store.SessionScope, model.Bot) error) (store.Completion, error) {
		t.Helper()
		probeCtx, stop := context.WithTimeout(ctx, 10*time.Second)
		defer stop()
		table := "sessions"
		if caller.Kind == model.PATCredential {
			table = "personal_access_tokens"
		}
		duration := "1 day"
		if expired {
			duration = "1 second"
		}
		var expiry time.Time
		if err := db.Pool.QueryRow(probeCtx, `UPDATE `+table+` SET expires_at=clock_timestamp()+$2::interval WHERE id=$1 RETURNING expires_at`, caller.CredentialID, duration).Scan(&expiry); err != nil {
			t.Fatal(err)
		}
		holder, err := db.Pool.Begin(probeCtx)
		if err != nil {
			t.Fatal(err)
		}
		defer holder.Rollback(context.Background())
		if _, err := holder.Exec(probeCtx, `SELECT id FROM bots WHERE id=$1 FOR UPDATE`, bot.ID); err != nil {
			t.Fatal(err)
		}
		type result struct {
			completion store.Completion
			err        error
		}
		done, finished := make(chan result, 1), make(chan struct{})
		go func() {
			defer close(finished)
			completion, err := db.WriteSession(probeCtx, func(scope store.SessionScope) error {
				if err := scope.SessionDAO().LockCredential(probeCtx, caller, time.Now().UTC()); err != nil {
					return err
				}
				current, err := scope.BotDAO().Bot(probeCtx, bot.ID)
				if err != nil {
					return err
				}
				if err := operation(probeCtx, scope, current); err != nil {
					return err
				}
				return scope.SessionDAO().LockCredential(probeCtx, caller, time.Now().UTC())
			})
			done <- result{completion, err}
		}()
		defer func() {
			stop()
			_ = holder.Rollback(context.Background())
			select {
			case <-finished:
			case <-time.After(2 * time.Second):
				t.Error("deletion transaction did not drain after cancellation")
			}
		}()
		waitTransferTeamLock(t, probeCtx, db, "SELECT id::text FROM bots WHERE id=", holder.Conn().PgConn().PID())
		if expired {
			for {
				var reached bool
				if err := db.Pool.QueryRow(probeCtx, `SELECT clock_timestamp()>=$1::timestamptz`, expiry).Scan(&reached); err != nil {
					t.Fatal(err)
				}
				if reached {
					break
				}
				if err := waitThreadClock(probeCtx); err != nil {
					t.Fatal(err)
				}
			}
		}
		if err := holder.Commit(probeCtx); err != nil {
			t.Fatal(err)
		}
		select {
		case result := <-done:
			return result.completion, result.err
		case <-probeCtx.Done():
			t.Fatal(probeCtx.Err())
			return store.Completion{}, probeCtx.Err()
		}
	}
	callers := []model.Principal{principal, runtimeBotPAT(t, db, bot)}
	deletion := &model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: 2, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	intent := func(ctx context.Context, scope store.SessionScope, current model.Bot) error {
		if current.Deletion != nil || current.Version != deletion.RequestedVersion {
			return errors.New("live deletion fixture has already changed")
		}
		sessions, err := scope.SessionDAO().LockBotSessions(ctx, bot.ID)
		if err != nil {
			return err
		}
		if len(sessions) != 1 || sessions[0].ID != id {
			return errors.New("live deletion fixture lost its Session")
		}
		if err := scope.SessionDAO().RevokeBotSessions(ctx, bot.ID); err != nil {
			return err
		}
		_, err = scope.BotDAO().SaveBotDeletion(ctx, bot.ID, deletion)
		return err
	}
	live := state()
	for _, caller := range callers {
		sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
			record, err := scope.SessionDAO().LockSession(ctx, id)
			if err != nil {
				return err
			}
			if string(record.GrantHash) != "bot grant" || record.GrantExpiry == nil || !record.GrantExpiry.After(time.Now()) || record.Consumed {
				return errors.New("expiry intent needs an unconsumed live Session grant")
			}
			return scope.SessionDAO().LockCredential(ctx, caller, time.Now().UTC())
		})
		completion, err := blocked(caller, true, intent)
		if !errors.Is(err, model.ErrNotFound) || completion.Outcome != store.TransactionNotCommitted || state() != live {
			t.Fatalf("expired deletion intent changed live state: kind=%s completion=%+v error=%v", caller.Kind, completion, err)
		}
		completion, err = blocked(caller, false, func(context.Context, store.SessionScope, model.Bot) error { return nil })
		if err != nil || completion.Outcome != store.TransactionCommitted || state() != live {
			t.Fatalf("restored credential changed live state: kind=%s completion=%+v error=%v", caller.Kind, completion, err)
		}
	}
	completion, err := blocked(principal, false, intent)
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("valid deletion intent: completion=%+v error=%v", completion, err)
	}
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		proof, err := scope.SessionDAO().LockBotSessionStop(ctx, id, bot.ID, principal.UserID)
		if err != nil || proof.Snapshot.Fence != fence || proof.Consumed || proof.SourceEpoch != nil {
			t.Fatalf("revoked Session stop proof: %+v %v", proof, err)
		}
		return nil
	})
	committed := state()
	replay := func(ctx context.Context, scope store.SessionScope, current model.Bot) error {
		if current.Version != 3 || !reflect.DeepEqual(current.Deletion, deletion) {
			return errors.New("replay did not read the matching committed deletion receipt")
		}
		record, err := scope.SessionDAO().LockSession(ctx, id)
		if err != nil {
			return err
		}
		if record.GrantHash != nil || record.GrantExpiry != nil || record.ConnectionExpiry != nil {
			return errors.New("committed deletion retained Session authorization")
		}
		return nil
	}
	for _, caller := range callers {
		completion, err := blocked(caller, true, replay)
		if !errors.Is(err, model.ErrNotFound) || completion.Outcome != store.TransactionNotCommitted || state() != committed {
			t.Fatalf("expired deletion replay changed committed state: kind=%s completion=%+v error=%v", caller.Kind, completion, err)
		}
		completion, err = blocked(caller, false, replay)
		if err != nil || completion.Outcome != store.TransactionCommitted || state() != committed {
			t.Fatalf("valid deletion replay changed committed state: kind=%s completion=%+v error=%v", caller.Kind, completion, err)
		}
	}
	rollback := errors.New("cleanup failed")
	completion, err = db.WriteSession(ctx, func(scope store.SessionScope) error {
		if _, err := scope.BotDAO().Bot(ctx, bot.ID); err != nil {
			return err
		}
		if _, err := scope.SessionDAO().LockBotSessions(ctx, bot.ID); err != nil {
			return err
		}
		if err := scope.SessionDAO().DeleteBotSession(ctx, id, bot.ID); err != nil {
			return err
		}
		if err := scope.SessionDAO().RedactDeletedBot(ctx, bot.ID); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) || completion.Outcome != store.TransactionNotCommitted || state() != committed {
		t.Fatalf("cleanup rollback: %+v %v", completion, err)
	}
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		current, err := scope.BotDAO().Bot(ctx, bot.ID)
		if err != nil || current.SessionID == nil || *current.SessionID != id {
			t.Fatalf("binding lost on rollback: %+v %v", current, err)
		}
		sessions, err := scope.SessionDAO().LockBotSessions(ctx, bot.ID)
		if err != nil || len(sessions) != 1 {
			t.Fatalf("session lost on rollback: %+v %v", sessions, err)
		}
		count, err := scope.SessionDAO().PendingSessionOperationCount(ctx, id)
		if err != nil || count != 1 {
			t.Fatalf("child lost on rollback: %d %v", count, err)
		}
		if err := scope.SessionDAO().DeleteBotSession(ctx, id, bot.ID); err != nil {
			return err
		}
		return scope.SessionDAO().RedactDeletedBot(ctx, bot.ID)
	})
	sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
		_, err := scope.SessionDAO().LockSession(ctx, id)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("deleted session: %v", err)
		}
		count, err := scope.SessionDAO().PendingSessionOperationCount(ctx, id)
		if err != nil || count != 0 {
			t.Fatalf("session child survived: %d %v", count, err)
		}
		current, err := scope.BotDAO().Bot(ctx, bot.ID)
		if err != nil || current.SessionID != nil || current.Name != "Deleted" {
			t.Fatalf("redaction: %+v %v", current, err)
		}
		return nil
	})
}

func TestSessionWriterClosedPoolDoesNotInvokeCallback(t *testing.T) {
	ctx := t.Context()
	db := isolatedStore(t)
	db.Close()
	completion, err := db.WriteSession(ctx, func(store.SessionScope) error {
		t.Fatal("closed pool invoked callback")
		return nil
	})
	if err == nil || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("closed pool: %+v %v", completion, err)
	}
}

func TestSessionDisconnectFailureRollsBackAndPreservesCause(t *testing.T) {
	database := isolatedStore(t)
	_, owner, _ := testAuthRecords(t, database)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskInProgress)
	id, claim := uuid.NewString(), uuid.NewString()
	now := time.Now().UTC().Truncate(time.Microsecond)
	expiry := now.Add(time.Hour)
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		if err := dao.InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: claim, OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}}, Lifecycle: "active"}}); err != nil {
			return err
		}
		return dao.ConnectSession(t.Context(), id, uuid.NewString(), now, &expiry)
	})
	mustQueryExec(t, database, `CREATE FUNCTION refuse_session_disconnect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected disconnect failure'; END $$;
 CREATE TRIGGER refuse_session_disconnect BEFORE UPDATE OF connection_expires_at ON task_sessions FOR EACH ROW EXECUTE FUNCTION refuse_session_disconnect()`)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	for attempt := range 2 {
		completion, err := database.WriteSession(ctx, func(scope store.SessionScope) error {
			return scope.SessionDAO().DisconnectSession(ctx, id)
		})
		var driver *pgconn.PgError
		var transaction *store.TransactionError
		if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &transaction) || transaction.Outcome != store.TransactionNotCommitted || transaction.CommitAttempted || transaction.CleanupFailed || !errors.As(err, &driver) || driver.Code != "P0001" || driver.Message != "injected disconnect failure" || !errors.Is(err, driver) {
			t.Fatalf("disconnect attempt %d lost rollback outcome or driver cause: completion=%+v error=%v", attempt, completion, err)
		}
		var persisted *time.Time
		if err := database.Pool.QueryRow(ctx, `SELECT connection_expires_at FROM task_sessions WHERE id=$1`, id).Scan(&persisted); err != nil || persisted == nil || !persisted.Equal(expiry) {
			t.Fatalf("failed disconnect changed committed lease: expiry=%v error=%v", persisted, err)
		}
	}
	mustQueryExec(t, database, `DROP TRIGGER refuse_session_disconnect ON task_sessions`)
	completion, err := database.WriteSession(ctx, func(scope store.SessionScope) error {
		return scope.SessionDAO().DisconnectSession(ctx, id)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("disconnect after removing failure: completion=%+v error=%v", completion, err)
	}
	var persisted *time.Time
	if err := database.Pool.QueryRow(ctx, `SELECT connection_expires_at FROM task_sessions WHERE id=$1`, id).Scan(&persisted); err != nil || persisted != nil {
		t.Fatalf("committed disconnect retained lease: expiry=%v error=%v", persisted, err)
	}
}

func TestSessionWriterReturnsItsOnlyPhysicalConnection(t *testing.T) {
	parsed, err := url.Parse(scopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("pool_max_conns", "1")
	parsed.RawQuery = query.Encode()
	database, err := Open(t.Context(), parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	if database.MaxConnections() != 1 {
		t.Fatalf("physical connection witness requires capacity 1, got %d", database.MaxConnections())
	}
	_, owner, _ := testAuthRecords(t, database)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskInProgress)
	id, claim := uuid.NewString(), uuid.NewString()
	mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project.ID, owner.UserID)
	sessionDAOTransaction(t, database, func(scope store.SessionScope) error {
		return scope.SessionDAO().InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: claim, OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}}, Lifecycle: "active"}})
	})
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	completion, err := database.WriteSession(ctx, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		if err := dao.ReadCredential(ctx, owner, time.Now()); err != nil {
			return err
		}
		if _, err := dao.ProjectAccess(ctx, owner.UserID, project.ID); err != nil {
			return err
		}
		metadata, err := dao.ArchiveMetadata(ctx, id)
		if err != nil {
			return err
		}
		if metadata.Owner != owner.UserID || metadata.Project != project.ID || metadata.Task != task.ID || metadata.Test || !metadata.TaskExists || !metadata.ProjectLive {
			t.Fatalf("archive metadata reads used different fixture: %+v", metadata)
		}
		if acquired := database.Pool.Stat().AcquiredConns(); acquired != 1 {
			t.Fatalf("callback did not own the physical connection: acquired=%d", acquired)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("Session read transaction: completion=%+v error=%v", completion, err)
	}
	if acquired := database.Pool.Stat().AcquiredConns(); acquired != 0 {
		t.Fatalf("completed transaction retained a physical connection: acquired=%d", acquired)
	}
	acquireCtx, stopAcquire := context.WithTimeout(ctx, time.Second)
	defer stopAcquire()
	connection, err := database.Pool.Acquire(acquireCtx)
	if err != nil {
		t.Fatal("the only physical connection was unavailable after completion", err)
	}
	defer connection.Release()
	var answer int
	if err := connection.QueryRow(acquireCtx, `SELECT 1`).Scan(&answer); err != nil || answer != 1 {
		t.Fatalf("returned lease did not provide a physical PostgreSQL connection: answer=%d error=%v", answer, err)
	}
}

func TestSessionWriterSharesTransactionAndReportsCompletion(t *testing.T) {
	ctx := context.Background()
	db := isolatedStore(t)
	project := queryProject(t, db, 1)
	taskID := queryID(2)
	queryTask(t, db, project.ID, 2, model.TaskInProgress)
	id, claim, owner, registration := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}}, Lifecycle: "active"}
	insert := func(scope store.SessionScope) error {
		if _, err := scope.SessionDAO().LockTask(ctx, project.ID, taskID); err != nil {
			return err
		}
		return scope.SessionDAO().InsertTaskSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: taskID}, ClaimID: claim, OwnerID: owner, RegistrationID: registration, Registration: []byte(`{}`), Snapshot: snapshot})
	}
	abort := errors.New("abort")
	completion, err := db.WriteSession(ctx, func(scope store.SessionScope) error {
		if err := insert(scope); err != nil {
			return err
		}
		if _, err := scope.SessionDAO().LockSession(ctx, id); err != nil {
			return err
		}
		return abort
	})
	if !errors.Is(err, abort) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: completion=%+v err=%v", completion, err)
	}
	completion, err = db.WriteSession(ctx, func(scope store.SessionScope) error {
		if _, err := scope.SessionDAO().LockSession(ctx, id); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("rolled back Session is visible: %v", err)
		}
		return insert(scope)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("commit: completion=%+v err=%v", completion, err)
	}
	completion, err = db.WriteSession(ctx, func(scope store.SessionScope) error {
		r, err := scope.SessionDAO().LockSession(ctx, id)
		if err != nil {
			return err
		}
		if r.Snapshot.SessionID != id || r.Owner != owner {
			t.Fatalf("unexpected Session: %+v", r)
		}
		r.Snapshot.Lifecycle = "archived"
		return scope.SessionDAO().SaveSession(ctx, r)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("update: completion=%+v err=%v", completion, err)
	}
	_, err = db.WriteSession(ctx, func(scope store.SessionScope) error {
		r, err := scope.SessionDAO().LockSession(ctx, id)
		if err == nil && r.Snapshot.Lifecycle != "archived" {
			t.Fatalf("saved lifecycle: %q", r.Snapshot.Lifecycle)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}
