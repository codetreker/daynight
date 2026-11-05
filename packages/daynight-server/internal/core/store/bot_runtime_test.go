package store

import (
	"context"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func runtimeStoredBot(t *testing.T, database *Store) model.Bot {
	t.Helper()
	bot, _ := storedBotCandidate(t, database)
	if err := database.WriteBot(context.Background(), func(tx *BotTx) error {
		return tx.InsertBot(context.Background(), bot)
	}); err != nil {
		t.Fatal(err)
	}
	return bot
}

func insertBotSession(ctx context.Context, tx pgx.Tx, bot model.Bot, sessionID, executionID string) error {
	_, err := tx.Exec(ctx, `INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot,bot_id)
 VALUES($1,'test',$2,$3,$4,'{}','{}',$5)`, sessionID, executionID, bot.OwnerUserID, uuid.NewString(), bot.ID)
	return err
}

func TestBotSessionBindingAndRoleFreezeAreAtomic(t *testing.T) {
	database := isolatedStore(t)
	bot := runtimeStoredBot(t, database)
	ctx := context.Background()
	sessionID, executionID := uuid.NewString(), uuid.NewString()
	role := model.BotRoleConfiguration{Instructions: "Use Daynight CLI.", Revision: "1", Digest: strings.Repeat("a", 64)}
	failure := errors.New("reject complete registration")
	bind := func(tx *BotTx) (model.Bot, error) {
		current, err := ReadBotForUpdate(ctx, tx.tx, bot.ID)
		if err != nil {
			return model.Bot{}, err
		}
		if err := insertBotSession(ctx, tx.tx, current, sessionID, executionID); err != nil {
			return model.Bot{}, err
		}
		return BindBotSession(ctx, tx.tx, bot.ID, current.Version, sessionID, role)
	}
	if err := database.WriteBot(ctx, func(tx *BotTx) error {
		if _, err := bind(tx); err != nil {
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
	if err := database.WriteBot(ctx, func(tx *BotTx) error {
		current, err := bind(tx)
		if err == nil && (current.Version != 2 || current.SessionID == nil || *current.SessionID != sessionID || current.TestExecutionID == nil || *current.TestExecutionID != executionID || !reflect.DeepEqual(current.RoleConfiguration, &role)) {
			t.Fatalf("invalid committed binding: %+v", current)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	for _, version := range []int64{1, 2} {
		if err := database.WriteBot(ctx, func(tx *BotTx) error {
			_, err := BindBotSession(ctx, tx.tx, bot.ID, version, sessionID, role)
			return err
		}); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("binding was rewritten at version %d: %v", version, err)
		}
	}
}

func TestBotStartupRejectsUnboundStaleDeletedAndExhaustedWrites(t *testing.T) {
	database := isolatedStore(t)
	bot := runtimeStoredBot(t, database)
	ctx := context.Background()
	if err := database.WriteBot(ctx, func(tx *BotTx) error {
		_, err := SetBotStartup(ctx, tx.tx, bot.ID, 1, model.BotStartupResult{State: "ready"})
		return err
	}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("unbound Bot became ready: %v", err)
	}
	code := "directory_missing"
	if err := database.WriteBot(ctx, func(tx *BotTx) error {
		current, err := SetBotStartup(ctx, tx.tx, bot.ID, 1, model.BotStartupResult{State: "failed", Code: &code})
		if err == nil && (current.Version != 2 || current.StartupResult.State != "failed" || current.StartupResult.Code == nil || *current.StartupResult.Code != code) {
			t.Fatalf("failure result was lost: %+v", current)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.WriteBot(ctx, func(tx *BotTx) error {
		_, err := SetBotStartup(ctx, tx.tx, bot.ID, 1, model.BotStartupResult{State: "pending"})
		return err
	}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("stale startup write succeeded: %v", err)
	}
	for _, state := range []string{"deleted", "exhausted"} {
		t.Run(state, func(t *testing.T) {
			candidate := runtimeStoredBot(t, database)
			version := int64(1)
			if state == "deleted" {
				mustQueryExec(t, database, `UPDATE bots SET deletion='{}' WHERE id=$1`, candidate.ID)
			} else {
				version = math.MaxInt64
				mustQueryExec(t, database, `UPDATE bots SET version=$2 WHERE id=$1`, candidate.ID, version)
			}
			if err := database.WriteBot(ctx, func(tx *BotTx) error {
				_, err := SetBotStartup(ctx, tx.tx, candidate.ID, version, model.BotStartupResult{State: "failed", Code: &code})
				return err
			}); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("invalid startup update: %v", err)
			}
		})
	}
}

func TestBotReadyAndSuccessfulPreferencesShareOneTransaction(t *testing.T) {
	database := isolatedStore(t)
	bot := runtimeStoredBot(t, database)
	ctx := context.Background()
	mustQueryExec(t, database, `UPDATE bots SET requested_overrides=jsonb_build_object('workerId',worker_id::text) WHERE id=$1`, bot.ID)
	if err := database.WriteBot(ctx, func(tx *BotTx) error {
		current, err := ReadBotForUpdate(ctx, tx.tx, bot.ID)
		if err != nil {
			return err
		}
		id := uuid.NewString()
		if err := insertBotSession(ctx, tx.tx, current, id, uuid.NewString()); err != nil {
			return err
		}
		_, err = BindBotSession(ctx, tx.tx, bot.ID, 1, id, model.BotRoleConfiguration{Instructions: "Frozen role", Revision: "1", Digest: strings.Repeat("a", 64)})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("reject ready report after preferences")
	ready := func(tx *BotTx) error {
		current, err := SetBotStartup(ctx, tx.tx, bot.ID, 2, model.BotStartupResult{State: "ready"})
		if err != nil {
			return err
		}
		if current.Version != 3 || current.StartupResult.State != "ready" {
			t.Fatalf("ready result: %+v", current)
		}
		return CommitBotPreferences(ctx, tx.tx, bot.ID)
	}
	if err := database.WriteBot(ctx, func(tx *BotTx) error {
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
	if err := database.WriteBot(ctx, ready); err != nil {
		t.Fatal(err)
	}
	if input := readBotDefaults(t, database, bot.OwnerUserID); input.PreferredWorkerID == nil || *input.PreferredWorkerID != bot.WorkerID {
		t.Fatalf("ready report lost preference: %+v", input)
	}
}

func TestBotSessionConstraintsRejectCrossOwnerAndDuplicateBinding(t *testing.T) {
	database := isolatedStore(t)
	bot := runtimeStoredBot(t, database)
	ctx := context.Background()
	if err := database.WriteBot(ctx, func(tx *BotTx) error {
		return insertBotSession(ctx, tx.tx, bot, uuid.NewString(), uuid.NewString())
	}); err != nil {
		t.Fatal(err)
	}
	for _, entry := range []struct {
		name, code string
		candidate  model.Bot
	}{
		{"duplicate", "23505", bot},
		{"cross_owner", "23503", model.Bot{ID: bot.ID, OwnerUserID: uuid.NewString()}},
	} {
		t.Run(entry.name, func(t *testing.T) {
			if entry.name == "cross_owner" {
				mustQueryExec(t, database, `DELETE FROM task_sessions WHERE bot_id=$1`, bot.ID)
			}
			err := database.WriteBot(ctx, func(tx *BotTx) error {
				return insertBotSession(ctx, tx.tx, entry.candidate, uuid.NewString(), uuid.NewString())
			})
			var postgres *pgconn.PgError
			if !errors.As(err, &postgres) || postgres.Code != entry.code {
				t.Fatalf("invalid binding accepted: %v", err)
			}
		})
	}
}

func TestBotSessionConstraintKeepsTasksSeparate(t *testing.T) {
	database := isolatedStore(t)
	bot := runtimeStoredBot(t, database)
	ctx := context.Background()
	for _, backend := range []string{"web", "herdr"} {
		t.Run(backend, func(t *testing.T) {
			snapshot, terminal := any(`{}`), any(nil)
			if backend == "herdr" {
				snapshot, terminal = nil, `{}`
			}
			_, err := database.Pool.Exec(ctx, `INSERT INTO task_sessions(id,scope,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,backend,terminal_state,bot_id)
 VALUES($1,'task',$2,$3,$4,$5,$6,'{}',$7,$8,$9,$10)`, uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), bot.OwnerUserID, uuid.NewString(), snapshot, backend, terminal, bot.ID)
			var postgres *pgconn.PgError
			if !errors.As(err, &postgres) || postgres.Code != "23514" || postgres.ConstraintName != "session_bot_scope" {
				t.Fatalf("task accepted a Bot binding: %v", err)
			}
		})
	}
}

func TestBotRuntimeStorageFailuresAreNotSuccessfulWrites(t *testing.T) {
	database := isolatedStore(t)
	bot := runtimeStoredBot(t, database)
	ctx := context.Background()
	tx, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []func() error{
		func() error { _, err := ReadBotForUpdate(ctx, tx, bot.ID); return err },
		func() error {
			_, err := BindBotSession(ctx, tx, bot.ID, 1, uuid.NewString(), model.BotRoleConfiguration{})
			return err
		},
		func() error {
			_, err := SetBotStartup(ctx, tx, bot.ID, 1, model.BotStartupResult{State: "failed"})
			return err
		},
	} {
		if err := operation(); err == nil || errors.Is(err, model.ErrNotFound) {
			t.Fatalf("closed transaction became a success or business refusal: %v", err)
		}
	}
}
