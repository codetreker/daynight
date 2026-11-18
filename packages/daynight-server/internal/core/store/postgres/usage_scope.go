package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/usage"
	"github.com/jackc/pgx/v5"
)

type usageScope struct{ tx pgx.Tx }

func (s *usageScope) UsageDAO() store.UsageDAO     { return usage.New(s.tx) }
func (s *usageScope) SessionDAO() store.SessionDAO { return session.New(s.tx) }
func (s *Store) WriteUsage(ctx context.Context, f func(store.UsageScope) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin usage", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error { return f(&usageScope{tx}) })
	return teamCompletion("write usage", err)
}
func (s *Store) ReadUsage(ctx context.Context, f func(store.UsageScope) error) error {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return pg.QueryError("begin usage snapshot", err)
	}
	return transact(ctx, tx, func(tx pgx.Tx) error { return f(&usageScope{tx}) })
}
