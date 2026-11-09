package postgres

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	botpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	sessionpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
	"testing"
	"time"
)

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
func runtimeBotWriteAfterLock(t *testing.T, database *Store, candidate model.Bot, principal model.Principal, credential func(context.Context, BotWriteDAO, pgx.Tx, model.Principal) error, expired bool, operation func(context.Context, BotWriteDAO, pgx.Tx) error) error {
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
func runtimeSessionCredential(ctx context.Context, _ BotWriteDAO, raw pgx.Tx, principal model.Principal) error {
	return sessionpg.New(raw).LockCredential(ctx, principal, time.Now().UTC())
}
func runtimeDefinitionCredential(ctx context.Context, dao BotWriteDAO, _ pgx.Tx, principal model.Principal) error {
	return dao.Credential(ctx, principal)
}
