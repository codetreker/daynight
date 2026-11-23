package postgres

import (
	"context"
	"errors"
	"log/slog"

	migration083 "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/schema/migrations/083"
	migration115 "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/schema/migrations/115"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	Pool *pgxpool.Pool
}

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	return OpenWithLogger(ctx, databaseURL, slog.Default())
}

func OpenWithLogger(ctx context.Context, databaseURL string, logger *slog.Logger) (*Store, error) {
	ctx = migration083.WithLogger(ctx, logger)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, databaseFailure("configuration", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, databaseFailure("connect", err)
	}
	if err := initializeSchema(ctx, pool, schemaMigrations, currentSchemaSnapshot); err != nil {
		pool.Close()
		var identity *githubRepositoryIdentityMigrationError
		if errors.As(err, &identity) {
			return nil, databaseFailure(identity.Error(), err)
		}
		var worker *migration115.WorkerPropertyError
		if errors.As(err, &worker) {
			return nil, databaseFailure(worker.Error(), err)
		}
		var cause *pgconn.PgError
		if errors.As(err, &cause) && cause.Code == "P1047" {
			return nil, databaseFailure("migration requires active login transactions to be consumed or expired", err)
		}
		return nil, databaseFailure("migrate", err)
	}
	return &Store{Pool: pool}, nil
}

func (s *Store) MaxConnections() int { return int(s.Pool.Config().MaxConns) }

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
