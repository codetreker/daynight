package github

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5/pgxpool"
)

type appCredentialReader struct{ pool *pgxpool.Pool }

// NewAppCredentialReader creates a narrow reader for the current App key.
func NewAppCredentialReader(pool *pgxpool.Pool) store.GitHubAppCredentialReader {
	return &appCredentialReader{pool: pool}
}

func (r *appCredentialReader) Credentials(ctx context.Context, id string) (githubpr.CredentialSnapshot, error) {
	var result githubpr.CredentialSnapshot
	var key []byte
	var hasSecrets bool
	err := r.pool.QueryRow(ctx, `SELECT id::text, github_app_id, credential_version, private_key_pem,
 private_key_pem IS NOT NULL AND webhook_secret IS NOT NULL
 FROM github_apps WHERE id=$1 AND deleted_at IS NULL`, id).
		Scan(&result.AppResourceID, &result.GitHubAppID, &result.CredentialVersion, &key, &hasSecrets)
	if err != nil {
		return githubpr.CredentialSnapshot{}, pg.QueryError("read github app credentials", err)
	}
	if !hasSecrets {
		return githubpr.CredentialSnapshot{}, pg.QueryError("read github app credentials", errors.New("live github app credentials are missing"))
	}
	result.PrivateKeyPEM = key
	return result, nil
}
