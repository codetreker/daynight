package postgres

import (
	"context"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	Pool *pgxpool.Pool
}

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, databaseFailure("configuration", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, databaseFailure("connect", err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		pool.Close()
		return nil, databaseFailure("migrate", err)
	}
	return &Store{Pool: pool}, nil
}

func (s *Store) Close() { s.Pool.Close() }

func (s *Store) Ready(ctx context.Context) error {
	if err := s.Pool.Ping(ctx); err != nil {
		return databaseFailure("readiness", err)
	}
	return nil
}

func (s *Store) ReadTaskSearch(ctx context.Context, operation func(TaskSearchSnapshot) error) error {
	return NewTaskSearch(s.Pool).ReadTaskSearch(ctx, operation)
}
