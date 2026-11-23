package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func (s *Store) ReadGitHubAppAdmins(ctx context.Context, operation func(store.GitHubAppAdminReader) error) error {
	return readSnapshot(ctx, s.Pool, func(tx pgx.Tx) error { return operation(github.NewAppAdminReader(tx)) }, true)
}

func (s *Store) WriteGitHubAppAdmins(ctx context.Context, appID string, operation func(store.GitHubAppAdminWriter) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin github app administrator write", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var lockedID string
		// The App root protects the administrator set and invitation issuer
		// eligibility together; individual row versions cannot freeze both.
		if err := tx.QueryRow(ctx, `SELECT id::text FROM github_apps WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, appID).Scan(&lockedID); err != nil {
			return pg.QueryError("lock github app", err)
		}
		return operation(github.NewAppAdminWriter(tx, appID))
	})
	return teamCompletion("write github app administrators", err)
}
