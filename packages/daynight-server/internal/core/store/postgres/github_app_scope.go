package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func (s *Store) WriteGitHubApp(ctx context.Context, operation func(store.GitHubAppWriteDAO) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin github app", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error { return operation(github.NewAppWriter(tx)) })
	return teamCompletion("write github app", err)
}

func (s *Store) ReadGitHubApps(ctx context.Context, operation func(store.GitHubAppReadDAO) error) error {
	return readSnapshot(ctx, s.Pool, func(tx pgx.Tx) error { return operation(github.NewAppReader(tx)) }, true)
}
