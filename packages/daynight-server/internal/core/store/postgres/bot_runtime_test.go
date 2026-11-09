package postgres

import (
	"context"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	botpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	sessionpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func runtimeStoredBot(t *testing.T, database *Store) model.Bot {
	t.Helper()
	bot, _ := storedBotCandidate(t, database)
	if err := writeBotTest(database, context.Background(), func(tx BotWriteDAO) error {
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

func writeBotWithSessionTest(database *Store, ctx context.Context, operation func(BotWriteDAO, pgx.Tx) error) error {
	tx, err := database.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return err
	}
	return transact(ctx, tx, func(tx pgx.Tx) error { return operation(botpg.NewWriter(tx), tx) })
}

func runtimeBotState(t *testing.T, database *Store, id string) string {
	t.Helper()
	var state string
	if err := database.Pool.QueryRow(t.Context(), `SELECT jsonb_build_object('bot',to_jsonb(b),
 'sessions',(SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) FROM task_sessions s WHERE s.bot_id=b.id),
 'workerPreferences',(SELECT COALESCE(jsonb_agg(to_jsonb(p)),'[]'::jsonb) FROM bot_worker_preferences p WHERE p.user_id=b.owner_user_id),
 'configurationPreferences',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.worker_id),'[]'::jsonb) FROM bot_configuration_preferences p WHERE p.user_id=b.owner_user_id))::text FROM bots b WHERE b.id=$1`, id).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func runtimeBotPAT(t *testing.T, database *Store, bot model.Bot) model.Principal {
	t.Helper()
	pat := model.PersonalAccessToken{ID: uuid.NewString(), UserID: bot.OwnerUserID, TokenHash: deviceStoreHash(uuid.NewString()), Name: "Runtime boundary", CreatedAt: time.Now().UTC()}
	identityScopeTest(t, database, func(scope IdentityScope) error { return scope.IdentityDAO().InsertPAT(t.Context(), pat) })
	return model.Principal{Kind: model.PATCredential, UserID: bot.OwnerUserID, CredentialID: pat.ID}
}

func runtimeSessionCredential(ctx context.Context, _ BotWriteDAO, raw pgx.Tx, principal model.Principal) error {
	return sessionpg.New(raw).LockCredential(ctx, principal, time.Now().UTC())
}

func runtimeDefinitionCredential(ctx context.Context, dao BotWriteDAO, _ pgx.Tx, principal model.Principal) error {
	return dao.Credential(ctx, principal)
}

func runtimeBotWriteAfterLock(t *testing.T, database *Store, bot model.Bot, principal model.Principal, credential func(context.Context, BotWriteDAO, pgx.Tx, model.Principal) error, expired bool, operation func(context.Context, BotWriteDAO, pgx.Tx) error) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	table := "personal_access_tokens"
	if principal.Kind == model.SessionCredential {
		table = "sessions"
	}
	var expiry time.Time
	duration := "1 day"
	if expired {
		duration = "1 second"
	}
	if err := database.Pool.QueryRow(ctx, `UPDATE `+table+` SET expires_at=clock_timestamp()+$2::interval WHERE id=$1 RETURNING expires_at`, principal.CredentialID, duration).Scan(&expiry); err != nil {
		t.Fatal(err)
	}
	holder, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	if _, err := holder.Exec(ctx, `SELECT id FROM bots WHERE id=$1 FOR UPDATE`, bot.ID); err != nil {
		t.Fatal(err)
	}
	before := runtimeBotState(t, database, bot.ID)
	done, finished := make(chan error, 1), make(chan struct{})
	go func() {
		defer close(finished)
		done <- writeBotWithSessionTest(database, ctx, func(dao BotWriteDAO, raw pgx.Tx) error {
			if err := credential(ctx, dao, raw, principal); err != nil {
				return err
			}
			if _, err := dao.Bot(ctx, bot.ID); err != nil {
				return err
			}
			if err := operation(ctx, dao, raw); err != nil {
				return err
			}
			return credential(ctx, dao, raw, principal)
		})
	}()
	defer func() {
		cancel()
		_ = holder.Rollback(context.Background())
		select {
		case <-finished:
		case <-time.After(2 * time.Second):
			t.Error("runtime mutation did not drain after cancellation")
		}
	}()
	waitTransferTeamLock(t, ctx, database, "SELECT id::text FROM bots WHERE id=", holder.Conn().PgConn().PID())
	if expired {
		for {
			var reached bool
			if err := database.Pool.QueryRow(ctx, `SELECT clock_timestamp()>=$1::timestamptz`, expiry).Scan(&reached); err != nil {
				t.Fatal(err)
			}
			if reached {
				break
			}
			if err := waitThreadClock(ctx); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if expired && runtimeBotState(t, database, bot.ID) != before {
		t.Fatal("expired credential committed Bot, Session or preference changes")
	}
	return err
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

func TestBotStartupRejectsUnboundStaleDeletedAndExhaustedWrites(t *testing.T) {
	database := isolatedStore(t)
	bot := runtimeStoredBot(t, database)
	ctx := context.Background()
	if err := writeBotTest(database, ctx, func(tx BotWriteDAO) error {
		_, err := tx.SetBotStartup(ctx, bot.ID, 1, model.BotStartupResult{State: "ready"})
		return err
	}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("unbound Bot became ready: %v", err)
	}
	code := "directory_missing"
	principal := runtimeBotPAT(t, database, bot)
	if err := runtimeBotWriteAfterLock(t, database, bot, principal, runtimeSessionCredential, true, func(ctx context.Context, tx BotWriteDAO, _ pgx.Tx) error {
		_, err := tx.SetBotStartup(ctx, bot.ID, 1, model.BotStartupResult{State: "failed", Code: &code})
		return err
	}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("report credential expired behind unchanged Bot lock: %v", err)
	}
	if err := runtimeBotWriteAfterLock(t, database, bot, principal, runtimeSessionCredential, false, func(ctx context.Context, tx BotWriteDAO, _ pgx.Tx) error {
		current, err := tx.SetBotStartup(ctx, bot.ID, 1, model.BotStartupResult{State: "failed", Code: &code})
		if err == nil && (current.Version != 2 || current.StartupResult.State != "failed" || current.StartupResult.Code == nil || *current.StartupResult.Code != code) {
			return fmt.Errorf("failure result was lost: %+v", current)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	beforeReplay := runtimeBotState(t, database, bot.ID)
	for _, expired := range []bool{true, false} {
		err := runtimeBotWriteAfterLock(t, database, bot, principal, runtimeSessionCredential, expired, func(ctx context.Context, tx BotWriteDAO, _ pgx.Tx) error {
			current, err := tx.Bot(ctx, bot.ID)
			if err == nil && (current.Version != 2 || current.StartupResult.State != "failed" || current.StartupResult.Code == nil || *current.StartupResult.Code != code || current.SessionID != nil || current.RoleConfiguration != nil) {
				t.Error("report read lost committed preflight result")
			}
			return err
		})
		if expired && !errors.Is(err, model.ErrNotFound) || !expired && err != nil || runtimeBotState(t, database, bot.ID) != beforeReplay {
			t.Fatalf("report replay changed state or credential outcome: expired=%t error=%v", expired, err)
		}
	}
	if err := writeBotTest(database, ctx, func(tx BotWriteDAO) error {
		_, err := tx.SetBotStartup(ctx, bot.ID, 1, model.BotStartupResult{State: "pending"})
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
			if err := writeBotTest(database, ctx, func(tx BotWriteDAO) error {
				_, err := tx.SetBotStartup(ctx, candidate.ID, version, model.BotStartupResult{State: "failed", Code: &code})
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

func TestBotSessionConstraintsRejectCrossOwnerAndDuplicateBinding(t *testing.T) {
	database := isolatedStore(t)
	bot := runtimeStoredBot(t, database)
	ctx := context.Background()
	if err := writeBotWithSessionTest(database, ctx, func(_ BotWriteDAO, raw pgx.Tx) error {
		return insertBotSession(ctx, raw, bot, uuid.NewString(), uuid.NewString())
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
			err := writeBotWithSessionTest(database, ctx, func(_ BotWriteDAO, raw pgx.Tx) error {
				return insertBotSession(ctx, raw, entry.candidate, uuid.NewString(), uuid.NewString())
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
		func() error { _, err := botpg.NewWriter(tx).Bot(ctx, bot.ID); return err },
		func() error {
			_, err := botpg.NewWriter(tx).BindBotSession(ctx, bot.ID, 1, uuid.NewString(), model.BotRoleConfiguration{})
			return err
		},
		func() error {
			_, err := botpg.NewWriter(tx).SetBotStartup(ctx, bot.ID, 1, model.BotStartupResult{State: "failed"})
			return err
		},
	} {
		if err := operation(); err == nil || errors.Is(err, model.ErrNotFound) {
			t.Fatalf("closed transaction became a success or business refusal: %v", err)
		}
	}
}
