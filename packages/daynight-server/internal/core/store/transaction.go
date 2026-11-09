package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/internal/transaction"
	"github.com/jackc/pgx/v5"
)

const cleanupTimeout = transaction.CleanupTimeout

func transact(ctx context.Context, tx pgx.Tx, operation func(pgx.Tx) error) error {
	return transaction.Run(ctx, tx, operation, false)
}
func transactReadOnly(ctx context.Context, tx pgx.Tx, operation func(pgx.Tx) error) error {
	return transaction.Run(ctx, tx, operation, true)
}
