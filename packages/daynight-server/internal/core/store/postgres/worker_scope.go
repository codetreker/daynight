package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
	"github.com/jackc/pgx/v5"
)

func (s *Store) WriteWorker(ctx context.Context, operation func(store.WorkerScope) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin worker snapshot", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error { return operation(worker.NewWriter(tx)) })
	return teamCompletion("write worker snapshot", err)
}
