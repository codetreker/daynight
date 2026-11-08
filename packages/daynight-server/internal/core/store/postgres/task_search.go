package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type taskSearchReader struct{ pool *pgxpool.Pool }

func NewTaskSearch(pool *pgxpool.Pool) store.TaskSearchReader {
	return &taskSearchReader{pool: pool}
}

func (r *taskSearchReader) ReadTaskSearch(ctx context.Context, operation func(store.TaskSearchSnapshot) error) error {
	return ReadOnlySnapshot(ctx, r.pool, func(tx pgx.Tx) error { return operation(task.NewSearchSnapshot(tx)) })
}
