package bot_test

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	botpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	sessionpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
	"testing"
	"time"
)

func writeBotTest(database *postgres.Store, ctx context.Context, operation func(BotWriteDAO) error) error {
	return testutil.WriteBot(database, ctx, operation)
}
func storedBotCandidate(t *testing.T, database *postgres.Store) (model.Bot, model.Principal) {
	t.Helper()
	return testutil.StoredBotCandidate(t, database)
}
func runtimeStoredBot(t *testing.T, database *postgres.Store) model.Bot {
	t.Helper()
	return testutil.RuntimeStoredBot(t, database)
}
func insertBotSession(ctx context.Context, tx pgx.Tx, candidate model.Bot, sessionID, executionID string) error {
	return testutil.InsertBotSession(ctx, tx, candidate, sessionID, executionID)
}
func runtimeBotState(t *testing.T, database *postgres.Store, id string) string {
	t.Helper()
	return testutil.RuntimeBotState(t, database.Pool, id)
}
func runtimeBotPAT(t *testing.T, database *postgres.Store, candidate model.Bot) model.Principal {
	t.Helper()
	return testutil.RuntimeBotPAT(t, database, candidate)
}
func botPreferenceText(value string) *string { return testutil.BotPreferenceText(value) }
func readBotDefaults(t *testing.T, database *postgres.Store, ownerID string) model.BotDefaultsInput {
	t.Helper()
	return testutil.ReadBotDefaults(t, database, ownerID)
}
func insertPreferenceBot(t *testing.T, database *postgres.Store, candidate model.Bot, overrides model.BotOverrides) model.Bot {
	t.Helper()
	return testutil.InsertPreferenceBot(t, database, candidate, overrides)
}
func markPreferenceBotReady(t *testing.T, database *postgres.Store, botID string) {
	t.Helper()
	testutil.MarkPreferenceBotReady(t, database.Pool, botID)
}
func commitPreferenceBot(t *testing.T, database *postgres.Store, botID string) {
	t.Helper()
	testutil.CommitPreferenceBot(t, database, botID)
}
func runtimeBotWriteAfterLock(t *testing.T, database *postgres.Store, candidate model.Bot, principal model.Principal, credential func(context.Context, BotWriteDAO, pgx.Tx, model.Principal) error, expired bool, operation func(context.Context, BotWriteDAO, pgx.Tx) error) error {
	t.Helper()
	return testutil.RuntimeBotWriteAfterLock(t, database.Pool, candidate, principal,
		func(ctx context.Context, op func(BotWriteDAO, pgx.Tx) error) error {
			return writeBotWithSessionTest(database, ctx, op)
		},
		credential, expired, operation)
}

func writeBotWithSessionTest(database *postgres.Store, ctx context.Context, operation func(BotWriteDAO, pgx.Tx) error) (err error) {
	tx, err := database.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if rollbackErr := tx.Rollback(cleanup); rollbackErr != nil && !errors.Is(rollbackErr, pgx.ErrTxClosed) {
			err = errors.Join(err, rollbackErr)
		}
	}()
	if err := operation(botpg.NewWriter(tx), tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func runtimeSessionCredential(ctx context.Context, _ BotWriteDAO, raw pgx.Tx, principal model.Principal) error {
	return sessionpg.New(raw).LockCredential(ctx, principal, time.Now().UTC())
}
func runtimeDefinitionCredential(ctx context.Context, dao BotWriteDAO, _ pgx.Tx, principal model.Principal) error {
	return dao.Credential(ctx, principal)
}

func isolatedStore(t *testing.T) *postgres.Store {
	t.Helper()
	database, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	return database
}
func testAuthRecords(t *testing.T, database *postgres.Store) (model.User, model.Principal, model.Session) {
	t.Helper()
	return testutil.AuthRecords(t, database)
}
func queryID(number int) string { return testutil.QueryID(number) }
func mustQueryExec(t *testing.T, database *postgres.Store, query string, args ...any) {
	t.Helper()
	testutil.MustExec(t, database.Pool, query, args...)
}
func putWorkerSnapshot(t *testing.T, database *postgres.Store, worker model.WorkerSnapshot) model.WorkerSnapshot {
	t.Helper()
	return testutil.PutWorkerSnapshot(t, database, worker)
}
func workerSnapshotFixture(userID, workerID string, stamp time.Time) model.WorkerSnapshot {
	return testutil.WorkerSnapshotFixture(userID, workerID, stamp)
}
