package postgres

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func (s *Store) ReadGitHubAppWebhook(ctx context.Context, appID string) (store.GitHubAppWebhookSnapshot, error) {
	return github.ReadAppWebhookSnapshot(ctx, s.Pool, appID)
}

func (s *Store) WriteGitHubAppSignals(ctx context.Context, appID string, version int64, operation func(store.GitHubAppSignalWriter) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin App signal", err)
	}
	err = transactSignal(ctx, tx, func(tx pgx.Tx) error {
		var githubAppID, current int64
		if err := tx.QueryRow(ctx, `SELECT github_app_id,credential_version FROM github_apps WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, appID).Scan(&githubAppID, &current); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return store.ErrGitHubAppWebhookChanged
			}
			return pg.QueryError("lock signal App", err)
		}
		if current != version {
			return store.ErrGitHubAppWebhookChanged
		}
		rows, err := tx.Query(ctx, `SELECT id FROM github_app_team_grants WHERE app_resource_id=$1 AND revoked_at IS NULL ORDER BY id FOR SHARE`, appID)
		if err != nil {
			return pg.QueryError("lock signal grants", err)
		}
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				rows.Close()
				return pg.QueryError("lock signal grants", err)
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return pg.QueryError("lock signal grants", err)
		}
		return operation(github.NewAppSignalWriter(tx, appID, githubAppID, current))
	})
	return teamCompletion("write App signal", err)
}
