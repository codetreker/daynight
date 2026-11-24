package postgres

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
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	botpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	sessionpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestBotDefinitionsHaveNoProjectDependency(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	var exists bool
	if err := database.Pool.QueryRow(context.Background(), `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='bots')`).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if !exists {
		t.Fatal("Bot definitions have no durable store")
	}
	var projectColumns int
	if err := database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='bots' AND column_name='project_id'`).Scan(&projectColumns); err != nil {
		t.Fatal(err)
	}
	if projectColumns != 0 {
		t.Fatal("Bot definitions must not require a project")
	}
}

func TestBotTransactionRollbackAndCompositeWorkerForeignKey(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	candidate, principal := storedBotCandidate(t, database)
	ctx := context.Background()
	failure := errors.New("cancel the definition after insertion")
	completion, err := database.WriteBot(ctx, func(scope BotScope) error {
		tx := scope.BotDAO()
		if err := tx.Credential(ctx, principal); err != nil {
			return err
		}
		if err := tx.Worker(ctx, principal.UserID, candidate.WorkerID); err != nil {
			return err
		}
		if err := tx.InsertBot(ctx, candidate); err != nil {
			return err
		}
		if _, err := tx.Bot(ctx, candidate.ID); err != nil {
			return err
		}
		return failure
	})
	var transaction *TransactionError
	if !errors.Is(err, failure) || !errors.As(err, &transaction) || transaction.Outcome != TransactionNotCommitted || completion.Outcome != TransactionNotCommitted {
		t.Fatalf("rollback outcome: %+v %v", completion, err)
	}
	err = database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error { _, err := snapshot.BotDAO().Bot(ctx, candidate.ID); return err })
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("rolled back Bot remained: %v", err)
	}
	other, _, _ := testAuthRecords(t, database)
	candidate.OwnerUserID = other.ID
	err = writeBotTest(database, ctx, func(tx BotWriteDAO) error { return tx.InsertBot(ctx, candidate) })
	var pgError *pgconn.PgError
	if !errors.As(err, &pgError) || pgError.Code != "23503" {
		t.Fatalf("cross-owner Worker accepted: %v", err)
	}
	candidate.OwnerUserID = principal.UserID
	completion, err = database.WriteBot(ctx, func(scope BotScope) error { return scope.BotDAO().InsertBot(ctx, candidate) })
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("commit outcome: %+v %v", completion, err)
	}
	if err := migrate(ctx, database.Pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		bot, err := snapshot.BotDAO().Bot(ctx, candidate.ID)
		if err == nil && (bot.Version != 1 || bot.CreationOrder < 1 || bot.CreatedAt.IsZero() || !bot.CreatedAt.Equal(bot.UpdatedAt)) {
			t.Fatalf("invalid committed definition: %+v", bot)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestBotSessionBindingAndRoleFreezeAreAtomic(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	bot := runtimeStoredBot(t, database)
	ctx := context.Background()
	sessionID, executionID := uuid.NewString(), uuid.NewString()
	role := model.BotRoleConfiguration{Instructions: "Use Daynight CLI.", Revision: "1", Digest: strings.Repeat("a", 64)}
	principal := runtimeBotPAT(t, database, bot)
	failure := errors.New("reject complete registration")
	bind := func(ctx context.Context, tx BotWriteDAO, raw pgx.Tx) (model.Bot, error) {
		current, err := tx.Bot(ctx, bot.ID)
		if err != nil {
			return model.Bot{}, err
		}
		if err := insertBotSession(ctx, raw, current, sessionID, executionID); err != nil {
			return model.Bot{}, err
		}
		return tx.BindBotSession(ctx, bot.ID, current.Version, sessionID, role)
	}
	if err := runtimeBotWriteAfterLock(t, database, bot, principal, runtimeSessionCredential, true, func(ctx context.Context, tx BotWriteDAO, raw pgx.Tx) error { _, err := bind(ctx, tx, raw); return err }); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("registration credential expired behind unchanged Bot lock: %v", err)
	}
	if err := writeBotWithSessionTest(database, ctx, func(tx BotWriteDAO, raw pgx.Tx) error {
		if _, err := bind(ctx, tx, raw); err != nil {
			return err
		}
		return failure
	}); !errors.Is(err, failure) {
		t.Fatalf("failed registration outcome: %v", err)
	}
	var sessions int
	if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM task_sessions WHERE bot_id=$1`, bot.ID).Scan(&sessions); err != nil || sessions != 0 {
		t.Fatalf("rolled back Session survived: count=%d error=%v", sessions, err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		current, err := snapshot.BotDAO().Bot(ctx, bot.ID)
		if err == nil && (current.Version != 1 || current.SessionID != nil || current.RoleConfiguration != nil) {
			t.Fatalf("rollback froze a partial role: %+v", current)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := runtimeBotWriteAfterLock(t, database, bot, principal, runtimeSessionCredential, false, func(ctx context.Context, tx BotWriteDAO, raw pgx.Tx) error {
		current, err := bind(ctx, tx, raw)
		if err == nil && (current.Version != 2 || current.SessionID == nil || *current.SessionID != sessionID || current.TestExecutionID == nil || *current.TestExecutionID != executionID || !reflect.DeepEqual(current.RoleConfiguration, &role)) {
			return fmt.Errorf("invalid committed binding: %+v", current)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	beforeReplay := runtimeBotState(t, database, bot.ID)
	if err := runtimeBotWriteAfterLock(t, database, bot, principal, runtimeSessionCredential, false, func(ctx context.Context, tx BotWriteDAO, _ pgx.Tx) error {
		current, err := tx.Bot(ctx, bot.ID)
		if err == nil && (current.SessionID == nil || *current.SessionID != sessionID || current.TestExecutionID == nil || *current.TestExecutionID != executionID || !reflect.DeepEqual(current.RoleConfiguration, &role)) {
			t.Error("registration read lost committed binding")
		}
		return err
	}); err != nil || runtimeBotState(t, database, bot.ID) != beforeReplay {
		t.Fatalf("registration replay changed persisted state: %v", err)
	}
	for _, version := range []int64{1, 2} {
		if err := writeBotTest(database, ctx, func(tx BotWriteDAO) error {
			_, err := tx.BindBotSession(ctx, bot.ID, version, sessionID, role)
			return err
		}); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("binding was rewritten at version %d: %v", version, err)
		}
	}
}

func TestBotReadyAndSuccessfulPreferencesShareOneTransaction(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	bot := runtimeStoredBot(t, database)
	ctx := context.Background()
	mustQueryExec(t, database, `UPDATE bots SET requested_overrides=jsonb_build_object('workerId',worker_id::text) WHERE id=$1`, bot.ID)
	if err := writeBotWithSessionTest(database, ctx, func(tx BotWriteDAO, raw pgx.Tx) error {
		current, err := tx.Bot(ctx, bot.ID)
		if err != nil {
			return err
		}
		id := uuid.NewString()
		if err := insertBotSession(ctx, raw, current, id, uuid.NewString()); err != nil {
			return err
		}
		_, err = tx.BindBotSession(ctx, bot.ID, 1, id, model.BotRoleConfiguration{Instructions: "Frozen role", Revision: "1", Digest: strings.Repeat("a", 64)})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("reject ready report after preferences")
	ready := func(tx BotWriteDAO) error {
		current, err := tx.SetBotStartup(ctx, bot.ID, 2, model.BotStartupResult{State: "ready"})
		if err != nil {
			return err
		}
		if current.Version != 3 || current.StartupResult.State != "ready" {
			t.Fatalf("ready result: %+v", current)
		}
		return tx.CommitBotPreferences(ctx, bot.ID)
	}
	if err := writeBotTest(database, ctx, func(tx BotWriteDAO) error {
		if err := ready(tx); err != nil {
			return err
		}
		return failure
	}); !errors.Is(err, failure) {
		t.Fatalf("ready rollback: %v", err)
	}
	if input := readBotDefaults(t, database, bot.OwnerUserID); input.PreferredWorkerID != nil {
		t.Fatalf("failed report committed preference: %+v", input)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		current, err := snapshot.BotDAO().Bot(ctx, bot.ID)
		if err == nil && (current.Version != 2 || current.StartupResult.State != "pending") {
			t.Fatalf("failed report committed readiness: %+v", current)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := writeBotTest(database, ctx, ready); err != nil {
		t.Fatal(err)
	}
	if input := readBotDefaults(t, database, bot.OwnerUserID); input.PreferredWorkerID == nil || *input.PreferredWorkerID != bot.WorkerID {
		t.Fatalf("ready report lost preference: %+v", input)
	}
}

func TestBotPreferencesStorageFailuresDoNotBecomePartialSuccess(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	candidate, _ := storedBotCandidate(t, database)
	bot := insertPreferenceBot(t, database, candidate, model.BotOverrides{WorkerID: &candidate.WorkerID, Cwd: botPreferenceText("/choice"), Provider: botPreferenceText("claude")})
	markPreferenceBotReady(t, database, bot.ID)
	before := runtimeBotState(t, database, bot.ID)
	for _, stage := range []string{"worker", "cwd", "provider"} {
		if !t.Run(stage, func(t *testing.T) {
			if before != runtimeBotState(t, database, bot.ID) {
				t.Fatal("previous fault changed the shared preference fixture")
			}
			table, condition := "bot_configuration_preferences", "NEW.cwd IS NOT NULL"
			if stage == "worker" {
				table, condition = "bot_worker_preferences", "true"
			} else if stage == "provider" {
				condition = "NEW.provider IS NOT NULL"
			}
			mustQueryExec(t, database, `CREATE FUNCTION refuse_preference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF `+condition+` THEN RAISE EXCEPTION 'preference store unavailable'; END IF; RETURN NEW; END $$`)
			mustQueryExec(t, database, `CREATE TRIGGER refuse_preference BEFORE INSERT OR UPDATE ON `+table+` FOR EACH ROW EXECUTE FUNCTION refuse_preference()`)
			err := writeBotTest(database, context.Background(), func(tx BotWriteDAO) error { return tx.CommitBotPreferences(context.Background(), bot.ID) })
			var transaction *TransactionError
			if err == nil || !errors.As(err, &transaction) || transaction.Outcome != TransactionNotCommitted {
				t.Fatalf("failed preference store became success: %v", err)
			}
			result := readBotDefaults(t, database, candidate.OwnerUserID)
			if result.PreferredWorkerID != nil || len(result.WorkerPreferences) != 0 {
				t.Fatalf("failed transaction left a partial preference: %+v", result)
			}
			if before != runtimeBotState(t, database, bot.ID) {
				t.Fatal("failed preference transaction changed the shared fixture")
			}
			assertMigrationPoolReusable(t, database.Pool)
			mustQueryExec(t, database, "DROP TRIGGER refuse_preference ON "+pgx.Identifier{table}.Sanitize()+"; DROP FUNCTION refuse_preference()")
			assertFaultTriggerRemoved(t, database, "refuse_preference", table)
		}) {
			return
		}
	}
}

func TestBotClosedPoolDoesNotInvokeScope(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := closedStore(t)
	if err := writeBotTest(database, context.Background(), func(BotWriteDAO) error { t.Fatal("closed pool invoked callback"); return nil }); err == nil {
		t.Fatal("closed pool appeared writable")
	}
}

func TestBotCleanupReceiptPersistsAcrossCommitAndRollback(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := context.Background()
	candidate, principal := storedBotCandidate(t, database)
	if err := writeBotTest(database, ctx, func(tx BotWriteDAO) error { return tx.InsertBot(ctx, candidate) }); err != nil {
		t.Fatal(err)
	}
	deletion := model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: 1,
		WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	var deleted model.Bot
	if err := writeBotTest(database, ctx, func(dao BotWriteDAO) error {
		var err error
		deleted, err = dao.SaveBotDeletion(ctx, candidate.ID, &deletion)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("reject cleanup receipt")
	completion, err := database.WriteBot(ctx, func(scope BotScope) error {
		dao := scope.BotDAO()
		locked, err := dao.Bot(ctx, deleted.ID)
		if err != nil {
			return err
		}
		locked.Deletion.WorkerCleanup.State = "completed"
		locked.Deletion.ReceiptDigest = strings.Repeat("a", 64)
		updated, err := dao.SaveBotDeletion(ctx, locked.ID, locked.Deletion)
		if err != nil {
			return err
		}
		if updated.Version != deleted.Version+1 || updated.Deletion.ReceiptDigest != locked.Deletion.ReceiptDigest {
			t.Fatalf("cleanup receipt lost: %+v", updated)
		}
		return failure
	})
	if !errors.Is(err, failure) || completion.Outcome != TransactionNotCommitted {
		t.Fatalf("cleanup rollback: %+v %v", completion, err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		page, err := snapshot.BotDAO().Bots(ctx, principal.UserID, &candidate.WorkerID, Page{Limit: 10})
		if err != nil {
			return err
		}
		if len(page.Items) != 1 {
			t.Fatalf("rollback lost cleanup obligation: %+v", page)
		}
		current := page.Items[0]
		if current.ID != deleted.ID || current.Version != deleted.Version || current.Deletion.ReceiptDigest != "" || current.Deletion.WorkerCleanup.State != "pending" {
			t.Fatalf("rolled-back cleanup survived: %+v", current)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	completed := deletion
	completed.WorkerCleanup = model.BotCleanupResult{State: "completed"}
	completed.ServerCleanup = model.BotCleanupResult{State: "completed"}
	receipt := []byte(fmt.Sprintf(`{"deletionId":%q,"stop":null,"result":{"state":"completed","code":null}}`, deletion.DeletionID))
	completed.ReceiptDigest = fmt.Sprintf("%x", sha256.Sum256(receipt))
	completion, err = database.WriteBot(ctx, func(scope BotScope) error {
		dao := scope.BotDAO()
		if _, err := dao.Bot(ctx, deleted.ID); err != nil {
			return err
		}
		_, err := dao.SaveBotDeletion(ctx, deleted.ID, &completed)
		return err
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("completed receipt commit: %+v %v", completion, err)
	}
	var version int64
	var updatedAt time.Time
	if err := database.Pool.QueryRow(ctx, `SELECT version,updated_at FROM bots WHERE id=$1`, deleted.ID).Scan(&version, &updatedAt); err != nil {
		t.Fatal(err)
	}
	if version != deleted.Version+1 || !updatedAt.After(deleted.UpdatedAt) {
		t.Fatalf("completed receipt version/time: %d %v", version, updatedAt)
	}
	want := deleted
	want.Version = deleted.Version + 1
	want.UpdatedAt = updatedAt.UTC()
	want.Deletion = &completed
	for range 2 {
		if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			actual, err := snapshot.BotDAO().Bot(ctx, deleted.ID)
			if err == nil && !reflect.DeepEqual(actual, want) {
				t.Fatalf("committed receipt readback: got %+v want %+v", actual, want)
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}

}

func TestBotDefinitionCredentialRechecksAfterLockedRead(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	bot, principal := storedBotCandidate(t, db)
	sessionDAOTransaction(t, db, func(s SessionScope) error { return s.BotDAO().InsertBot(t.Context(), bot) })
	before := runtimeBotState(t, db, bot.ID)
	for _, expired := range []bool{true, false} {
		err := runtimeBotWriteAfterLock(t, db, bot, principal, runtimeDefinitionCredential, expired, func(ctx context.Context, dao BotWriteDAO, _ pgx.Tx) error {
			got, err := dao.Bot(ctx, bot.ID)
			if err != nil {
				return err
			}
			if got.Version != 1 || got.Deletion != nil {
				t.Fatalf("locked read changed definition: %+v", got)
			}
			return nil
		})
		if expired && !errors.Is(err, model.ErrNotFound) || !expired && err != nil || runtimeBotState(t, db, bot.ID) != before {
			t.Fatalf("credential after lock: expired=%t err=%v", expired, err)
		}
	}
}

func TestBotDeletionKeepsIndependentTaskAndPreciseVersion(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	ctx := t.Context()
	candidate, _ := storedBotCandidate(t, db)
	project, task := uuid.NewString(), uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Independent tasks','example')`, project)
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'A task stays independent')`, task, project)
	state := func() string {
		t.Helper()
		var result string
		if err := db.Pool.QueryRow(ctx, `SELECT jsonb_build_object(
 'task',(SELECT to_jsonb(t) FROM tasks t WHERE id=$1),
 'properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY name) FROM task_properties p WHERE task_id=$1),
 'dependencies',(SELECT jsonb_agg(to_jsonb(d) ORDER BY depends_on_task_id) FROM task_dependencies d WHERE task_id=$1),
 'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM task_sessions s WHERE task_id=$1))::text`, task).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := state()
	sessionDAOTransaction(t, db, func(s SessionScope) error { return s.BotDAO().InsertBot(ctx, candidate) })
	const version = int64(9007199254740993)
	mustQueryExec(t, db, `UPDATE bots SET version=$2 WHERE id=$1`, candidate.ID, version)
	deletion := &model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: version, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	sessionDAOTransaction(t, db, func(s SessionScope) error {
		current, err := s.BotDAO().Bot(ctx, candidate.ID)
		if err != nil {
			return err
		}
		if current.Version != version {
			t.Fatalf("version rounded: %+v", current)
		}
		_, err = s.BotDAO().SaveBotDeletion(ctx, current.ID, deletion)
		return err
	})
	if err := db.ReadSnapshot(ctx, func(s SnapshotScope) error {
		got, err := s.BotDAO().Bot(ctx, candidate.ID)
		if err != nil {
			return err
		}
		if got.Version != version+1 || !reflect.DeepEqual(got.Deletion, deletion) {
			t.Fatalf("precise deletion lost: %+v", got)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if state() != before {
		t.Fatal("Bot creation/deletion changed independent task state")
	}
}

func writeBotTest(database *Store, ctx context.Context, operation func(BotWriteDAO) error) error {
	return testutil.WriteBot(database, ctx, operation)
}
func storedBotCandidate(t *testing.T, database *Store) (model.Bot, model.Principal) {
	t.Helper()
	return testutil.StoredBotCandidate(t, database)
}
func runtimeStoredBot(t *testing.T, database *Store) model.Bot {
	t.Helper()
	return testutil.RuntimeStoredBot(t, database)
}
func insertBotSession(ctx context.Context, tx pgx.Tx, candidate model.Bot, sessionID, executionID string) error {
	return testutil.InsertBotSession(ctx, tx, candidate, sessionID, executionID)
}
func runtimeBotState(t *testing.T, database *Store, id string) string {
	t.Helper()
	return testutil.RuntimeBotState(t, database.Pool, id)
}
func runtimeBotPAT(t *testing.T, database *Store, candidate model.Bot) model.Principal {
	t.Helper()
	return testutil.RuntimeBotPAT(t, database, candidate)
}
func botPreferenceText(value string) *string { return testutil.BotPreferenceText(value) }
func readBotDefaults(t *testing.T, database *Store, ownerID string) model.BotDefaultsInput {
	t.Helper()
	return testutil.ReadBotDefaults(t, database, ownerID)
}
func insertPreferenceBot(t *testing.T, database *Store, candidate model.Bot, overrides model.BotOverrides) model.Bot {
	t.Helper()
	return testutil.InsertPreferenceBot(t, database, candidate, overrides)
}
func markPreferenceBotReady(t *testing.T, database *Store, botID string) {
	t.Helper()
	testutil.MarkPreferenceBotReady(t, database.Pool, botID)
}
func commitPreferenceBot(t *testing.T, database *Store, botID string) {
	t.Helper()
	testutil.CommitPreferenceBot(t, database, botID)
}
func runtimeBotWriteAfterLock(t *testing.T, database *Store, candidate model.Bot, principal model.Principal, credential testutil.RuntimeBotCredential, expired bool, operation func(context.Context, BotWriteDAO, pgx.Tx) error) error {
	t.Helper()
	return testutil.RuntimeBotWriteAfterLock(t, database.Pool, candidate, principal,
		func(ctx context.Context, op func(BotWriteDAO, pgx.Tx) error) error {
			return writeBotWithSessionTest(database, ctx, op)
		},
		credential, expired, operation)
}

func writeBotWithSessionTest(database *Store, ctx context.Context, operation func(BotWriteDAO, pgx.Tx) error) error {
	tx, err := database.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return err
	}
	return transact(ctx, tx, func(tx pgx.Tx) error { return operation(botpg.NewWriter(tx), tx) })
}

var runtimeSessionCredential = testutil.RuntimeBotCredential{
	Check: func(ctx context.Context, _ BotWriteDAO, raw pgx.Tx, principal model.Principal, at time.Time) error {
		return sessionpg.New(raw).LockCredential(ctx, principal, at)
	},
}
var runtimeDefinitionCredential = testutil.RuntimeBotCredential{
	DatabaseClock: true,
	Check: func(ctx context.Context, dao BotWriteDAO, _ pgx.Tx, principal model.Principal, _ time.Time) error {
		return dao.Credential(ctx, principal)
	},
}

func TestBotRecoveryScopeCommitsHostingAuthorizationAndReceiptAtomically(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	bot := runtimeStoredBot(t, database)
	oldPAT, currentPAT := runtimeBotPAT(t, database, bot), runtimeBotPAT(t, database, bot)
	newWorker := uuid.NewString()
	testutil.PutWorkerSnapshot(t, database, testutil.WorkerSnapshotFixture(bot.OwnerUserID, newWorker, time.Now().UTC()))
	sessionID, executionID, nativeID := uuid.NewString(), uuid.NewString(), "original-native-session"
	initial := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: sessionID, TestExecutionID: executionID, ExecutionGeneration: "3"}, ConnectionEpoch: "5"},
		Identity:  sp.Identity{OwnerUserID: bot.OwnerUserID, ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), NativeSessionID: &nativeID, Provider: "codex"},
		Lifecycle: "active", ConnectionState: "connected", Synchronized: true}
	oldHash, newHash := bytes.Repeat([]byte{4}, 32), bytes.Repeat([]byte{8}, 32)
	expiry := time.Now().UTC().Add(time.Hour).Truncate(time.Microsecond)
	completion, err := database.WriteSession(ctx, func(scope SessionScope) error {
		if _, err := scope.BotDAO().Bot(ctx, bot.ID); err != nil {
			return err
		}
		inserted, err := scope.SessionDAO().InsertBotSession(ctx, SessionRegistration{Location: SessionLocation{SessionID: sessionID}, TestExecutionID: executionID, OwnerID: bot.OwnerUserID, RegistrationID: uuid.NewString(), Registration: json.RawMessage(`{}`), Snapshot: initial, ParentCredentialID: oldPAT.CredentialID, BotID: &bot.ID})
		if err != nil {
			return err
		}
		if !inserted {
			t.Fatal("fixture Session was not inserted")
		}
		bot, err = scope.BotDAO().BindBotSession(ctx, bot.ID, 1, sessionID, model.BotRoleConfiguration{})
		if err != nil {
			return err
		}
		bot, err = scope.BotDAO().RegisterBotRecovery(ctx, bot.ID, bot.Version, model.BotRecovery{ServiceOrigin: "https://daynight.example", MachineID: "same-machine", MachineName: "Host", IdentityHash: bytes.Repeat([]byte{2}, 32), HostingGeneration: 1})
		if err != nil {
			return err
		}
		if err := scope.SessionDAO().SetSessionGrant(ctx, SessionGrant{SessionID: sessionID, Hash: oldHash, ExpiresAt: expiry, Kind: "reconnect", ParentCredentialID: oldPAT.CredentialID}); err != nil {
			return err
		}
		return scope.SessionDAO().ConnectSession(ctx, sessionID, uuid.NewString(), time.Now().UTC(), &expiry)
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("fixture commit: %+v %v", completion, err)
	}
	mustQueryExec(t, database, `DELETE FROM personal_access_tokens WHERE id=$1`, oldPAT.CredentialID)
	_, err = database.WriteSession(ctx, func(scope SessionScope) error {
		return scope.SessionDAO().LockCredential(ctx, oldPAT, time.Now().UTC())
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("revoked original PAT retained authority: %v", err)
	}
	// Existing business claims remain owned by their Task and Bot, independently
	// of the Worker carrying the Bot's Session.
	project := queryProject(t, database, 70)
	ordinary := testutil.SetSnapshotTaskClaim(t, database.Pool, database, project.ID, 71, bot.OwnerUserID, bot.WorkerID)
	assistantTaskID := uuid.NewString()
	mustQueryExec(t, database, `INSERT INTO assistant_tasks(id,owner_user_id,request_fingerprint,application,name,purpose,scope,kind,state,takeover,version,manual_version,claim_generation,holder_bot_id,claim_token_hash,credential_operation_id,claimed_at,renewed_at,lease_until,created_at,updated_at)
 VALUES($1,$2,'fingerprint','','Business task','Purpose','Scope','continuous','active','auto',1,1,7,$3,'unchanged-business-credential',$4,now(),now(),now()+interval '1 hour',now(),now())`, assistantTaskID, bot.OwnerUserID, bot.ID, uuid.NewString())
	claimState := func() string {
		var state string
		if err := database.Pool.QueryRow(ctx, `SELECT jsonb_build_object('ordinary',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.name) FROM task_properties p WHERE task_id=$1),'assistant',(SELECT to_jsonb(a) FROM assistant_tasks a WHERE id=$2))::text`, ordinary.TaskID, assistantTaskID).Scan(&state); err != nil {
			t.Fatal(err)
		}
		return state
	}
	claimsBefore := claimState()
	operation := BotRecoveryOperation{OperationID: uuid.NewString(), Kind: "takeover", RequestHash: bytes.Repeat([]byte{3}, 32), Receipt: json.RawMessage(`{"hostingGeneration":"2"}`)}
	failure := errors.New("reject recovery after both DAO writes")
	mutate := func(stop bool) (Completion, error) {
		return database.WriteSession(ctx, func(scope SessionScope) error {
			if err := scope.SessionDAO().LockCredential(ctx, currentPAT, time.Now().UTC()); err != nil {
				return err
			}
			if _, err := scope.BotDAO().Bot(ctx, bot.ID); err != nil {
				return err
			}
			record, err := scope.SessionDAO().LockSession(ctx, sessionID)
			if err != nil {
				return err
			}
			if _, err := scope.BotDAO().AdvanceBotRecovery(ctx, bot.ID, bot.Version, 1, newWorker, model.WorkerMachine{ID: "same-machine", Name: "Renamed"}); err != nil {
				return err
			}
			if err := scope.SessionDAO().DisconnectSession(ctx, sessionID); err != nil {
				return err
			}
			if err := scope.SessionDAO().SetSessionGrant(ctx, SessionGrant{SessionID: sessionID, Hash: newHash, ExpiresAt: expiry, Kind: "reconnect", ParentCredentialID: currentPAT.CredentialID}); err != nil {
				return err
			}
			record.Snapshot.ConnectionState, record.Snapshot.Synchronized = "disconnected", false
			if err := scope.SessionDAO().SaveSession(ctx, record); err != nil {
				return err
			}
			if err := scope.BotDAO().SaveBotRecoveryOperation(ctx, bot.ID, operation); err != nil {
				return err
			}
			if stop {
				return failure
			}
			return nil
		})
	}
	check := func(committed bool) {
		t.Helper()
		completion, err := database.WriteSession(ctx, func(scope SessionScope) error {
			current, err := scope.BotDAO().Bot(ctx, bot.ID)
			if err != nil {
				return err
			}
			record, err := scope.SessionDAO().LockSession(ctx, sessionID)
			if err != nil {
				return err
			}
			if record.Snapshot.ControllerFence != initial.ControllerFence || !reflect.DeepEqual(record.Snapshot.Identity, initial.Identity) {
				t.Fatal("takeover replaced original Session or native identity")
			}
			if committed {
				if current.WorkerID != bot.WorkerID || current.Recovery.WorkerID != newWorker || current.Version != bot.Version+1 || current.Recovery.HostingGeneration != 2 || record.Parent != currentPAT.CredentialID || record.ConnectionExpiry != nil || !bytes.Equal(record.GrantHash, newHash) || record.Snapshot.Synchronized || record.Snapshot.ConnectionState != "disconnected" {
					t.Fatalf("partial recovery commit: Bot=%+v Session=%+v", current, record)
				}
				got, err := scope.BotDAO().BotRecoveryOperation(ctx, bot.ID, operation.OperationID)
				if err != nil {
					return err
				}
				if got.Kind != operation.Kind || !bytes.Equal(got.RequestHash, operation.RequestHash) {
					t.Fatal("committed operation receipt changed")
				}
			} else {
				if current.WorkerID != bot.WorkerID || current.Recovery.WorkerID != bot.WorkerID || current.Version != bot.Version || current.Recovery.HostingGeneration != 1 || record.Parent != oldPAT.CredentialID || record.ConnectionExpiry == nil || !bytes.Equal(record.GrantHash, oldHash) || !record.Snapshot.Synchronized {
					t.Fatalf("recovery rollback lost original authority: Bot=%+v Session=%+v", current, record)
				}
				if _, err := scope.BotDAO().BotRecoveryOperation(ctx, bot.ID, operation.OperationID); !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("rollback retained receipt: %v", err)
				}
			}
			return nil
		})
		if err != nil || completion.Outcome != TransactionCommitted {
			t.Fatalf("readback: %+v %v", completion, err)
		}
		if claimState() != claimsBefore {
			t.Fatal("Bot host change altered ordinary or assistant business claim")
		}
	}
	completion, err = mutate(true)
	if !errors.Is(err, failure) || completion.Outcome != TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", completion, err)
	}
	check(false)
	completion, err = mutate(false)
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("commit: %+v %v", completion, err)
	}
	check(true)
}

func botBarrierCapture(ctx context.Context, dao WebhookCaptureDAO, project string, actor wm.Actor, fact protocol.Fact) (string, error) {
	audience, err := dao.FreezeAudience(ctx, project, []string{fact.Type})
	if err != nil {
		return "", err
	}
	event, deliveries, err := taskWebhookPrepared(fact, audience)
	if err != nil {
		return "", err
	}
	event.Actor = actor
	return event.ID, dao.SaveCapture(ctx, event, deliveries)
}

func botBarrierStoredActor(t *testing.T, ctx context.Context, database *Store, eventID string) wm.Actor {
	t.Helper()
	tx, err := database.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	provenance, err := webhook.New(tx).CapturedEventProvenance(ctx, eventID)
	if err != nil {
		t.Fatal(err)
	}
	return provenance.Actor
}

func botBarrierDeletion() *model.BotDeletion {
	return &model.BotDeletion{DeletionID: uuid.NewString(), RequestedVersion: 1,
		WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
}

// Project and Thread writes read a declared Bot through the shared barrier and
// store the verified Bot actor with Task and Thread captures.
func TestDeclaredBotActorIsStoredWithTaskAndThreadCaptures(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := taskWebhookStore(t)
	bot := runtimeStoredBot(t, f.db)
	actor := wm.BotActor(bot.OwnerUserID, bot.ID)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	var events []string
	completion, err := f.db.WriteProject(ctx, f.project, func(sc ProjectWriteScope) error {
		locked, err := sc.BotBarrierDAO().Bot(ctx, bot.ID)
		if err != nil || locked.OwnerUserID != bot.OwnerUserID || locked.Deletion != nil {
			t.Fatalf("barrier Bot: %+v %v", locked, err)
		}
		changed, err := sc.TaskDAO().UpdateTask(ctx, f.task, TaskWrite{Title: "source", Status: model.TaskInProgress})
		if err != nil {
			return err
		}
		for _, fact := range []protocol.Fact{
			{Type: protocol.StatusChanged, ProjectID: f.project, TaskID: f.task, TaskVersion: changed.Version, OccurredAt: changed.UpdatedAt, PreviousStatus: "todo", Status: "in_progress"},
		} {
			id, err := botBarrierCapture(ctx, sc.CaptureDAO(), f.project, actor, fact)
			if err != nil {
				return err
			}
			events = append(events, id)
		}
		return nil
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("project capture: %v %v", completion, err)
	}
	completion, err = f.db.WriteThread(ctx, func(sc ThreadScope) error {
		if _, err := sc.BotBarrierDAO().Bot(ctx, bot.ID); err != nil {
			return err
		}
		message, err := taskWebhookInsertMessage(ctx, sc, f, "declared", nil)
		if err != nil {
			return err
		}
		id, err := botBarrierCapture(ctx, sc.CaptureDAO(), f.project, actor, protocol.Fact{Type: protocol.ThreadPosted, ProjectID: f.project, TaskID: f.task, MessageID: message.ID, CreatedAt: &message.CreatedAt, OccurredAt: message.CreatedAt})
		events = append(events, id)
		return err
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("thread capture: %v %v", completion, err)
	}
	if len(events) != 2 {
		t.Fatalf("captured events: %v", events)
	}
	for _, id := range events {
		stored := botBarrierStoredActor(t, ctx, f.db, id)
		if stored != actor || stored.Kind != wm.ActorBot || stored.UserID != bot.OwnerUserID || stored.BotID != bot.ID {
			t.Fatalf("stored actor for %s = %+v, want %+v", id, stored, actor)
		}
	}
	if _, err := webhookBarrierMissingBot(ctx, f.db, f.project); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing Bot barrier = %v, want not found", err)
	}
}

func webhookBarrierMissingBot(ctx context.Context, database *Store, project string) (model.Bot, error) {
	var bot model.Bot
	_, err := database.WriteProject(ctx, project, func(sc ProjectWriteScope) error {
		var err error
		bot, err = sc.BotBarrierDAO().Bot(ctx, uuid.NewString())
		return err
	})
	return bot, err
}

// A deletion that commits while a write waits on the barrier is visible to the
// write's fresh read, so the write cannot commit an actor for a deleted Bot.
func TestBotBarrierObservesDeletionCommittedDuringWait(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := taskWebhookStore(t)
	bot := runtimeStoredBot(t, f.db)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	write := make(chan error, 1)
	var observed model.Bot
	completion, err := f.db.WriteBot(ctx, func(scope BotScope) error {
		if _, err := scope.BotDAO().Bot(ctx, bot.ID); err != nil {
			return err
		}
		go func() {
			_, err := f.db.WriteThread(ctx, func(sc ThreadScope) error {
				var err error
				observed, err = sc.BotBarrierDAO().Bot(ctx, bot.ID)
				return err
			})
			write <- err
		}()
		waitForQueryLock(t, f.db, "SELECT id::text FROM bots WHERE id=$1 FOR SHARE")
		_, err := scope.BotDAO().SaveBotDeletion(ctx, bot.ID, botBarrierDeletion())
		return err
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("deletion: %v %v", completion, err)
	}
	if err := receiveQueryResult(t, ctx, write); err != nil {
		t.Fatal(err)
	}
	if observed.Deletion == nil {
		t.Fatal("barrier returned the Bot as live after deletion committed")
	}
}

// A write holding the barrier makes deletion wait until the Bot actor commits.
func TestBotDeletionWaitsForWriteHoldingBarrier(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := taskWebhookStore(t)
	bot := runtimeStoredBot(t, f.db)
	actor := wm.BotActor(bot.OwnerUserID, bot.ID)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	deletion := make(chan error, 1)
	var eventID string
	var capturedAt, deletedAt time.Time
	completion, err := f.db.WriteProject(ctx, f.project, func(sc ProjectWriteScope) error {
		if _, err := sc.BotBarrierDAO().Bot(ctx, bot.ID); err != nil {
			return err
		}
		go func() {
			_, err := f.db.WriteBot(ctx, func(scope BotScope) error {
				if _, err := scope.BotDAO().Bot(ctx, bot.ID); err != nil {
					return err
				}
				deletedAt = time.Now()
				_, err := scope.BotDAO().SaveBotDeletion(ctx, bot.ID, botBarrierDeletion())
				return err
			})
			deletion <- err
		}()
		waitForQueryLock(t, f.db, "SELECT id::text FROM bots WHERE id=$1 FOR UPDATE")
		changed, err := sc.TaskDAO().UpdateTask(ctx, f.task, TaskWrite{Title: "source", Status: model.TaskInProgress})
		if err != nil {
			return err
		}
		eventID, err = botBarrierCapture(ctx, sc.CaptureDAO(), f.project, actor, protocol.Fact{Type: protocol.StatusChanged, ProjectID: f.project, TaskID: f.task, TaskVersion: changed.Version, OccurredAt: changed.UpdatedAt, PreviousStatus: "todo", Status: "in_progress"})
		capturedAt = time.Now()
		return err
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("write: %v %v", completion, err)
	}
	if err := receiveQueryResult(t, ctx, deletion); err != nil {
		t.Fatal(err)
	}
	if !deletedAt.After(capturedAt) {
		t.Fatal("deletion acquired the Bot before the barrier holder committed")
	}
	if stored := botBarrierStoredActor(t, ctx, f.db, eventID); stored != actor {
		t.Fatalf("stored actor = %+v, want %+v", stored, actor)
	}
}
