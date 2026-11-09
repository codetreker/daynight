package postgres

import (
	"context"
	"errors"
	"fmt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"reflect"
	"strings"
	"testing"
)

func TestBotDefinitionsHaveNoProjectDependency(t *testing.T) {
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
	database := closedStore(t)
	if err := writeBotTest(database, context.Background(), func(BotWriteDAO) error { t.Fatal("closed pool invoked callback"); return nil }); err == nil {
		t.Fatal("closed pool appeared writable")
	}
}

func TestBotCleanupReceiptCallbackRollback(t *testing.T) {
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
}
