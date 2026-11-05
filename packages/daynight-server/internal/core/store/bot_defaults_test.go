package store

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func botPreferenceText(value string) *string { return &value }

func readBotDefaults(t *testing.T, database *Store, ownerID string) model.BotDefaultsInput {
	t.Helper()
	var result model.BotDefaultsInput
	if err := database.ReadSnapshot(context.Background(), func(snapshot *Snapshot) error {
		var err error
		result, err = snapshot.BotDefaults(context.Background(), ownerID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return result
}

func insertPreferenceBot(t *testing.T, database *Store, candidate model.Bot, overrides model.BotOverrides) model.Bot {
	t.Helper()
	candidate.ID = uuid.NewString()
	candidate.RequestedOverrides = overrides
	if overrides.Cwd != nil {
		candidate.ResolvedConfiguration.Cwd = *overrides.Cwd
	}
	if overrides.Provider != nil {
		candidate.ResolvedConfiguration.Provider = *overrides.Provider
	}
	if err := database.WriteBot(context.Background(), func(tx *BotTx) error {
		return tx.InsertBot(context.Background(), candidate)
	}); err != nil {
		t.Fatal(err)
	}
	return candidate
}

func markPreferenceBotReady(t *testing.T, database *Store, botID string) {
	t.Helper()
	if _, err := database.Pool.Exec(context.Background(), `UPDATE bots SET session_id=$2,startup_result='{"state":"ready","code":null}' WHERE id=$1`, botID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
}

func commitPreferenceBot(t *testing.T, database *Store, botID string) {
	t.Helper()
	if err := database.WriteBot(context.Background(), func(tx *BotTx) error {
		return CommitBotPreferences(context.Background(), tx.tx, botID)
	}); err != nil {
		t.Fatal(err)
	}
}

func TestBotDefaultsReadKeepsOwnerScopeAndStableFullWorkerInventory(t *testing.T) {
	database := isolatedStore(t)
	owner, _, _ := testAuthRecords(t, database)
	other, _, _ := testAuthRecords(t, database)
	stamp := time.Now().UTC().Add(-96 * time.Hour)
	for _, id := range []string{queryID(3), queryID(1), queryID(2)} {
		putWorkerSnapshot(t, database, workerSnapshotFixture(owner.ID, id, stamp))
	}
	putWorkerSnapshot(t, database, workerSnapshotFixture(other.ID, queryID(4), stamp))
	result := readBotDefaults(t, database, owner.ID)
	if result.ObservedAt.IsZero() || len(result.Workers) != 3 || result.PreferredWorkerID != nil || len(result.WorkerPreferences) != 0 {
		t.Fatalf("initial defaults: %+v", result)
	}
	for index, worker := range result.Workers {
		if worker.WorkerID != queryID(index+1) || worker.UserID != owner.ID {
			t.Fatalf("unstable or cross-owner worker: %+v", result.Workers)
		}
	}
	if err := database.WriteBot(context.Background(), func(tx *BotTx) error {
		input, err := tx.BotDefaults(context.Background(), owner.ID)
		if err == nil && !reflect.DeepEqual(input.Workers, result.Workers) {
			t.Fatalf("creation and preview use different inputs: %+v", input)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	missing := readBotDefaults(t, database, uuid.NewString())
	if missing.Workers == nil || missing.WorkerPreferences == nil || len(missing.Workers) != 0 {
		t.Fatalf("missing owner defaults: %+v", missing)
	}
}

func TestBotPreferencesCommitOnlyExplicitFieldsByCreationOrder(t *testing.T) {
	database := isolatedStore(t)
	candidate, _ := storedBotCandidate(t, database)
	older := insertPreferenceBot(t, database, candidate, model.BotOverrides{WorkerID: &candidate.WorkerID, Cwd: botPreferenceText("/older-cwd"), Provider: botPreferenceText("claude")})
	newer := insertPreferenceBot(t, database, candidate, model.BotOverrides{Provider: botPreferenceText("copilot")})
	markPreferenceBotReady(t, database, older.ID)
	markPreferenceBotReady(t, database, newer.ID)
	commitPreferenceBot(t, database, newer.ID)
	commitPreferenceBot(t, database, older.ID)
	commitPreferenceBot(t, database, older.ID)
	result := readBotDefaults(t, database, candidate.OwnerUserID)
	preference := result.WorkerPreferences[candidate.WorkerID]
	if result.PreferredWorkerID == nil || *result.PreferredWorkerID != candidate.WorkerID || preference.Cwd == nil || *preference.Cwd != "/older-cwd" || preference.Provider == nil || *preference.Provider != "copilot" {
		t.Fatalf("reverse completion overwrote independent newer fields: %+v, %+v", result, preference)
	}
	otherWorker := uuid.NewString()
	putWorkerSnapshot(t, database, workerSnapshotFixture(candidate.OwnerUserID, otherWorker, time.Now().UTC()))
	candidate.WorkerID, candidate.ResolvedConfiguration.WorkerID = otherWorker, otherWorker
	latest := insertPreferenceBot(t, database, candidate, model.BotOverrides{WorkerID: &otherWorker, Cwd: botPreferenceText("/other-worker")})
	markPreferenceBotReady(t, database, latest.ID)
	commitPreferenceBot(t, database, latest.ID)
	commitPreferenceBot(t, database, older.ID)
	result = readBotDefaults(t, database, candidate.OwnerUserID)
	if result.PreferredWorkerID == nil || *result.PreferredWorkerID != otherWorker || result.WorkerPreferences[otherWorker].Provider != nil || *result.WorkerPreferences[otherWorker].Cwd != "/other-worker" {
		t.Fatalf("worker selection order or scope leaked: %+v", result)
	}
}

func TestBotPreferencesRefuseUnsuccessfulOrDeletedBotsAndDoNotRememberDefaults(t *testing.T) {
	database := isolatedStore(t)
	candidate, _ := storedBotCandidate(t, database)
	for _, state := range []string{"pending", "failed", "ready-without-session", "deleted"} {
		t.Run(state, func(t *testing.T) {
			bot := insertPreferenceBot(t, database, candidate, model.BotOverrides{WorkerID: &candidate.WorkerID, Cwd: botPreferenceText("/explicit")})
			switch state {
			case "failed":
				mustQueryExec(t, database, `UPDATE bots SET startup_result='{"state":"failed","code":"launch_failed"}' WHERE id=$1`, bot.ID)
			case "ready-without-session":
				mustQueryExec(t, database, `UPDATE bots SET startup_result='{"state":"ready","code":null}' WHERE id=$1`, bot.ID)
			case "deleted":
				markPreferenceBotReady(t, database, bot.ID)
				mustQueryExec(t, database, `UPDATE bots SET deletion='{}' WHERE id=$1`, bot.ID)
			}
			err := database.WriteBot(context.Background(), func(tx *BotTx) error { return CommitBotPreferences(context.Background(), tx.tx, bot.ID) })
			if !errors.Is(err, ErrBotPreferencesNotReady) {
				t.Fatalf("unsafe preference commit %q: %v", state, err)
			}
		})
	}
	bot := insertPreferenceBot(t, database, candidate, model.BotOverrides{})
	markPreferenceBotReady(t, database, bot.ID)
	commitPreferenceBot(t, database, bot.ID)
	result := readBotDefaults(t, database, candidate.OwnerUserID)
	if result.PreferredWorkerID != nil || len(result.WorkerPreferences) != 0 {
		t.Fatalf("unsuccessful or implicit choices became preferences: %+v", result)
	}
}

func TestBotPreferencesShareLifecycleTransactionAndRollback(t *testing.T) {
	database := isolatedStore(t)
	candidate, _ := storedBotCandidate(t, database)
	bot := insertPreferenceBot(t, database, candidate, model.BotOverrides{WorkerID: &candidate.WorkerID, Cwd: botPreferenceText("/rolled-back"), Provider: botPreferenceText("claude")})
	ctx := context.Background()
	tx, err := database.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE bots SET session_id=$2,startup_result='{"state":"ready","code":null}' WHERE id=$1`, bot.ID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if err := CommitBotPreferences(ctx, tx, bot.ID); err != nil {
		t.Fatal(err)
	}
	inside, err := (&BotTx{tx: tx}).BotDefaults(ctx, candidate.OwnerUserID)
	if err != nil || inside.PreferredWorkerID == nil || *inside.WorkerPreferences[candidate.WorkerID].Cwd != "/rolled-back" {
		t.Fatalf("preferences did not join lifecycle transaction: %+v %v", inside, err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	outside := readBotDefaults(t, database, candidate.OwnerUserID)
	if outside.PreferredWorkerID != nil || len(outside.WorkerPreferences) != 0 {
		t.Fatalf("rollback left preferences: %+v", outside)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		stored, err := snapshot.Bot(ctx, bot.ID)
		if err == nil && (stored.StartupResult.State != "pending" || stored.SessionID != nil) {
			t.Fatalf("rollback left readiness: %+v", stored)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestBotPreferencesConcurrentSuccessKeepsNewestExplicitValues(t *testing.T) {
	database := isolatedStore(t)
	candidate, _ := storedBotCandidate(t, database)
	older := insertPreferenceBot(t, database, candidate, model.BotOverrides{WorkerID: &candidate.WorkerID, Cwd: botPreferenceText("/older"), Provider: botPreferenceText("codex")})
	newer := insertPreferenceBot(t, database, candidate, model.BotOverrides{WorkerID: &candidate.WorkerID, Cwd: botPreferenceText("/newer"), Provider: botPreferenceText("claude")})
	markPreferenceBotReady(t, database, older.ID)
	markPreferenceBotReady(t, database, newer.ID)
	start := make(chan struct{})
	failures := make(chan error, 2)
	var workers sync.WaitGroup
	for _, id := range []string{older.ID, newer.ID} {
		workers.Go(func() {
			<-start
			failures <- database.WriteBot(context.Background(), func(tx *BotTx) error {
				return CommitBotPreferences(context.Background(), tx.tx, id)
			})
		})
	}
	close(start)
	workers.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	result := readBotDefaults(t, database, candidate.OwnerUserID)
	preference := result.WorkerPreferences[candidate.WorkerID]
	if preference.Cwd == nil || *preference.Cwd != "/newer" || preference.Provider == nil || *preference.Provider != "claude" {
		t.Fatalf("concurrent success lost newest choice: %+v", preference)
	}
}

func TestBotPreferencesStorageFailuresDoNotBecomePartialSuccess(t *testing.T) {
	for _, stage := range []string{"worker", "cwd", "provider"} {
		t.Run(stage, func(t *testing.T) {
			database := isolatedStore(t)
			candidate, _ := storedBotCandidate(t, database)
			bot := insertPreferenceBot(t, database, candidate, model.BotOverrides{WorkerID: &candidate.WorkerID, Cwd: botPreferenceText("/choice"), Provider: botPreferenceText("claude")})
			markPreferenceBotReady(t, database, bot.ID)
			table, condition := "bot_configuration_preferences", "NEW.cwd IS NOT NULL"
			if stage == "worker" {
				table, condition = "bot_worker_preferences", "true"
			} else if stage == "provider" {
				condition = "NEW.provider IS NOT NULL"
			}
			mustQueryExec(t, database, `CREATE FUNCTION refuse_preference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF `+condition+` THEN RAISE EXCEPTION 'preference store unavailable'; END IF; RETURN NEW; END $$`)
			mustQueryExec(t, database, `CREATE TRIGGER refuse_preference BEFORE INSERT OR UPDATE ON `+table+` FOR EACH ROW EXECUTE FUNCTION refuse_preference()`)
			err := database.WriteBot(context.Background(), func(tx *BotTx) error { return CommitBotPreferences(context.Background(), tx.tx, bot.ID) })
			var transaction *TransactionError
			if err == nil || !errors.As(err, &transaction) || transaction.Outcome != TransactionNotCommitted {
				t.Fatalf("failed preference store became success: %v", err)
			}
			result := readBotDefaults(t, database, candidate.OwnerUserID)
			if result.PreferredWorkerID != nil || len(result.WorkerPreferences) != 0 {
				t.Fatalf("failed transaction left a partial preference: %+v", result)
			}
		})
	}
	database := isolatedStore(t)
	candidate, _ := storedBotCandidate(t, database)
	if err := database.WriteBot(context.Background(), func(tx *BotTx) error {
		return CommitBotPreferences(context.Background(), tx.tx, uuid.NewString())
	}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing Bot was not rejected: %v", err)
	}
	tx, err := database.Pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := (&Snapshot{tx: tx}).BotDefaults(context.Background(), candidate.OwnerUserID); err == nil {
		t.Fatal("closed transaction became empty defaults")
	}
	mustQueryExec(t, database, `UPDATE workers SET telemetry='{"machine":42}' WHERE user_id=$1`, candidate.OwnerUserID)
	if err := database.ReadSnapshot(context.Background(), func(snapshot *Snapshot) error {
		_, err := snapshot.BotDefaults(context.Background(), candidate.OwnerUserID)
		return err
	}); err == nil || errors.Is(err, model.ErrNotFound) {
		t.Fatalf("corrupt worker became an empty candidate list: %v", err)
	}
}

type botDefaultsHeartbeatTracer struct{ beforeWorkers func() }

func (tracer *botDefaultsHeartbeatTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.Contains(data.SQL, "FROM workers WHERE user_id=$1 ORDER BY") && tracer.beforeWorkers != nil {
		action := tracer.beforeWorkers
		tracer.beforeWorkers = nil
		action()
	}
	return ctx
}

func (*botDefaultsHeartbeatTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestBotDefaultsCreationClockIncludesConcurrentHeartbeat(t *testing.T) {
	database := isolatedStore(t)
	candidate, _ := storedBotCandidate(t, database)
	ctx := context.Background()
	var heartbeat time.Time
	tracer := &botDefaultsHeartbeatTracer{beforeWorkers: func() {
		if err := database.Pool.QueryRow(ctx, `UPDATE workers SET last_seen_at=clock_timestamp() WHERE user_id=$1 AND worker_id=$2 RETURNING last_seen_at`, candidate.OwnerUserID, candidate.WorkerID).Scan(&heartbeat); err != nil {
			t.Fatal(err)
		}
	}}
	config := database.Pool.Config().Copy()
	config.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	traced := &Store{Pool: pool}
	if err := traced.WriteBot(ctx, func(tx *BotTx) error {
		input, err := tx.BotDefaults(ctx, candidate.OwnerUserID)
		if err != nil {
			return err
		}
		if tracer.beforeWorkers != nil || len(input.Workers) != 1 || !input.Workers[0].LastReportedAt.Equal(heartbeat) {
			t.Fatalf("concurrent heartbeat was not observed: %+v, %v", input, heartbeat)
		}
		if input.ObservedAt.Before(input.Workers[0].LastReportedAt) {
			t.Fatalf("a committed heartbeat appears to be in the future: observation=%s heartbeat=%s", input.ObservedAt, input.Workers[0].LastReportedAt)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestBotCreationLockSerializesOnlyMatchingIDsUntilTransactionEnd(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	first, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Rollback(ctx)
	id := uuid.NewString()
	if err := (&BotTx{tx: first}).LockCreation(ctx, id); err != nil {
		t.Fatal(err)
	}
	second, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Rollback(ctx)
	if _, err := second.Exec(ctx, `SET LOCAL lock_timeout='50ms'`); err != nil {
		t.Fatal(err)
	}
	if err := (&BotTx{tx: second}).LockCreation(ctx, uuid.NewString()); err != nil {
		t.Fatalf("different request ID was serialized: %v", err)
	}
	err = (&BotTx{tx: second}).LockCreation(ctx, id)
	var pgError *pgconn.PgError
	if !errors.As(err, &pgError) || pgError.Code != "55P03" {
		t.Fatalf("same request ID did not wait for original transaction: %v", err)
	}
	if err := second.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := database.WriteBot(ctx, func(tx *BotTx) error { return tx.LockCreation(ctx, id) }); err != nil {
		t.Fatalf("creation lock survived transaction end: %v", err)
	}
}
