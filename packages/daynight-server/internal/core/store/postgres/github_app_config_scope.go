package postgres

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func (s *Store) ReadGitHubAppConfig(ctx context.Context, appID string, operation func(store.GitHubAppConfigReader) error) error {
	return readSnapshot(ctx, s.Pool, func(tx pgx.Tx) error { return operation(github.NewAppConfigReader(tx, appID)) }, true)
}
func (s *Store) WriteGitHubAppConfig(ctx context.Context, appID string, operation func(store.GitHubAppConfigWriter) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin github app configuration", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var id string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM github_apps WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, appID).Scan(&id); err != nil {
			return pg.QueryError("lock github app configuration", err)
		}
		return operation(github.NewAppConfigWriter(tx, appID))
	})
	return teamCompletion("write github app configuration", err)
}
