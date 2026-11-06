package store

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	Pool *pgxpool.Pool
}

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, &Error{Phase: "configuration", Cause: err}
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, &Error{Phase: "connect", Cause: err}
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		pool.Close()
		return nil, &Error{Phase: "migrate", Cause: err}
	}
	return &Store{Pool: pool}, nil
}

func (s *Store) Close() { s.Pool.Close() }
