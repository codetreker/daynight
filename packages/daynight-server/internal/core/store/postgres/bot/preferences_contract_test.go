package bot_test

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	botpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

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
	if err := writeBotTest(database, context.Background(), func(tx BotWriteDAO) error {
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
			err := writeBotTest(database, context.Background(), func(tx BotWriteDAO) error { return tx.CommitBotPreferences(context.Background(), bot.ID) })
			if !errors.Is(err, botpg.ErrBotPreferencesNotReady) {
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
	if err := botpg.NewWriter(tx).CommitBotPreferences(ctx, bot.ID); err != nil {
		t.Fatal(err)
	}
	inside, err := botpg.NewWriter(tx).BotDefaults(ctx, candidate.OwnerUserID)
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
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		stored, err := snapshot.BotDAO().Bot(ctx, bot.ID)
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
			failures <- writeBotTest(database, context.Background(), func(tx BotWriteDAO) error {
				return tx.CommitBotPreferences(context.Background(), id)
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
	traced := &postgres.Store{Pool: pool}
	if err := writeBotTest(traced, ctx, func(tx BotWriteDAO) error {
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
	if err := botpg.NewWriter(first).LockCreation(ctx, id); err != nil {
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
	if err := botpg.NewWriter(second).LockCreation(ctx, uuid.NewString()); err != nil {
		t.Fatalf("different request ID was serialized: %v", err)
	}
	err = botpg.NewWriter(second).LockCreation(ctx, id)
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
	if err := writeBotTest(database, ctx, func(tx BotWriteDAO) error { return tx.LockCreation(ctx, id) }); err != nil {
		t.Fatalf("creation lock survived transaction end: %v", err)
	}
}

func TestBotNativePreferencesRemainIndependentUnderReverseCompletion(t *testing.T) {
	database := isolatedStore(t)
	candidate, _ := storedBotCandidate(t, database)
	create := func(selected, effort string, explicitModel, explicitEffort bool) model.Bot {
		t.Helper()
		candidate.ResolvedConfiguration.Model = botPreferenceText(selected)
		candidate.ResolvedConfiguration.ReasoningEffort = botPreferenceText(effort)
		candidate.ResolvedConfiguration.Selection = &model.BotSelection{SchemaVersion: 1, ModelSource: "explicit", ReasoningEffortSource: "explicit"}
		overrides := model.BotOverrides{}
		if explicitModel {
			overrides.Model = botPreferenceText(selected)
		}
		if explicitEffort {
			overrides.ReasoningEffort = botPreferenceText(effort)
		}
		return insertPreferenceBot(t, database, candidate, overrides)
	}
	older := create("model-a", "high", true, true)
	newer := create("model-b", "low", true, false)
	latestEffort := create("model-a", "low", false, true)
	for _, bot := range []model.Bot{latestEffort, newer, older} {
		markPreferenceBotReady(t, database, bot.ID)
		commitPreferenceBot(t, database, bot.ID)
	}
	input := readBotDefaults(t, database, candidate.OwnerUserID)
	preference := input.WorkerPreferences[candidate.WorkerID].Native[candidate.ResolvedConfiguration.Provider]
	if preference.Model == nil || *preference.Model != "model-b" || preference.Efforts["model-a"] != "low" || len(preference.Efforts) != 1 {
		t.Fatalf("field order corrupted preference: %+v", preference)
	}
	implicit := create("implicit", "high", false, false)
	markPreferenceBotReady(t, database, implicit.ID)
	commitPreferenceBot(t, database, implicit.ID)
	for _, state := range []string{"pending", "failed"} {
		bot := create("unsuccessful", "high", true, true)
		if state == "failed" {
			mustQueryExec(t, database, `UPDATE bots SET startup_result='{"state":"failed","code":"invalid_cwd"}' WHERE id=$1`, bot.ID)
		}
		err := writeBotTest(database, context.Background(), func(tx BotWriteDAO) error { return tx.CommitBotPreferences(context.Background(), bot.ID) })
		if !errors.Is(err, botpg.ErrBotPreferencesNotReady) {
			t.Fatalf("remembered %s: %v", state, err)
		}
	}
	input = readBotDefaults(t, database, candidate.OwnerUserID)
	preference = input.WorkerPreferences[candidate.WorkerID].Native[candidate.ResolvedConfiguration.Provider]
	if *preference.Model != "model-b" || len(preference.Efforts) != 1 {
		t.Fatalf("implicit/failed polluted preference: %+v", preference)
	}
}

func TestBotNativePreferencesRollbackAndLegacyRecords(t *testing.T) {
	database := isolatedStore(t)
	candidate, _ := storedBotCandidate(t, database)
	legacy := insertPreferenceBot(t, database, candidate, model.BotOverrides{})
	var stored string
	if err := database.Pool.QueryRow(context.Background(), `SELECT resolved_configuration::text FROM bots WHERE id=$1`, legacy.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	candidate.ResolvedConfiguration.Model = botPreferenceText("model-a")
	candidate.ResolvedConfiguration.ReasoningEffort = botPreferenceText("high")
	candidate.ResolvedConfiguration.Selection = &model.BotSelection{SchemaVersion: 1, ModelSource: "explicit", ReasoningEffortSource: "explicit"}
	bot := insertPreferenceBot(t, database, candidate, model.BotOverrides{Model: botPreferenceText("model-a"), ReasoningEffort: botPreferenceText("high")})
	markPreferenceBotReady(t, database, bot.ID)
	ctx := context.Background()
	tx, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := botpg.NewWriter(tx).CommitBotPreferences(ctx, bot.ID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if len(readBotDefaults(t, database, candidate.OwnerUserID).WorkerPreferences) != 0 {
		t.Fatal("rolled back preferences escaped transaction")
	}
	var after string
	if err := database.Pool.QueryRow(ctx, `SELECT resolved_configuration::text FROM bots WHERE id=$1`, legacy.ID).Scan(&after); err != nil || after != stored {
		t.Fatalf("legacy snapshot changed: %s %v", after, err)
	}
	var version int
	if err := database.Pool.QueryRow(ctx, `SELECT max(version) FROM schema_migrations`).Scan(&version); err != nil || version < 45 {
		t.Fatalf("missing native preference migration: %d %v", version, err)
	}
}

func TestBotPreferencesStorageErrorsRemainObservable(t *testing.T) {
	database := isolatedStore(t)
	candidate, _ := storedBotCandidate(t, database)
	if err := writeBotTest(database, context.Background(), func(tx BotWriteDAO) error {
		return tx.CommitBotPreferences(context.Background(), uuid.NewString())
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
	if _, err := botpg.NewReader(tx).BotDefaults(context.Background(), candidate.OwnerUserID); err == nil {
		t.Fatal("closed transaction became empty defaults")
	}
	mustQueryExec(t, database, `UPDATE workers SET telemetry='{"machine":42}' WHERE user_id=$1`, candidate.OwnerUserID)
	if err := database.ReadSnapshot(context.Background(), func(snapshot SnapshotScope) error {
		_, err := snapshot.BotDAO().BotDefaults(context.Background(), candidate.OwnerUserID)
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
