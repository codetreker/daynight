package postgres

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func (s *Store) ReadGitHubGrants(ctx context.Context, operation func(store.GitHubGrantReadDAO) error) error {
	return readSnapshot(ctx, s.Pool, func(tx pgx.Tx) error { return operation(github.NewGrantReader(tx)) }, true)
}

func (s *Store) WriteGitHubGrant(ctx context.Context, teamID, appID, actorID string, operation func(store.GitHubGrantWriteDAO) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin github grant", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var id string
		if err := tx.QueryRow(ctx, `SELECT a.id::text FROM github_apps a WHERE a.id=$1 AND a.deleted_at IS NULL AND EXISTS (SELECT 1 FROM github_app_admins m WHERE m.app_resource_id=a.id AND m.user_id=$2)`, appID, actorID).Scan(&id); err != nil {
			return pg.QueryError("check App administrator", err)
		}
		if err := tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 FOR SHARE`, teamID).Scan(&id); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return &store.Error{Phase: "lock grant Team", MissingRow: true, Cause: errors.Join(store.ErrGitHubGrantTeamRootMissing, pg.QueryError("lock grant Team", err))}
			}
			return pg.QueryError("lock grant Team", err)
		}
		if err := tx.QueryRow(ctx, `SELECT id::text FROM github_apps WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, appID).Scan(&id); err != nil {
			return pg.QueryError("lock grant App", err)
		}
		return operation(github.NewGrantWriter(tx, teamID, appID))
	})
	return teamCompletion("write github grant", err)
}
