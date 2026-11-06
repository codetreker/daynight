package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

// WriteBot serializes existing definitions by their Bot row. Callers must lock
// this row before a related Session or archive record in the same transaction.
func (s *Store) WriteBot(ctx context.Context, operation func(store.BotScope) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin bot", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error { return operation(bot.NewWriter(tx)) })
	return teamCompletion("write bot", err)
}
