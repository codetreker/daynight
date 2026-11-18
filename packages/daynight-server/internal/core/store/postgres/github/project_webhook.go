package github

import (
	"context"
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type projectWebhookWriter struct {
	tx pgx.Tx
	id string
}

func NewProjectWebhookWriter(tx pgx.Tx, id string) store.GitHubProjectWebhookWriteDAO {
	return &projectWebhookWriter{tx, id}
}
func (d *projectWebhookWriter) Authorization(ctx context.Context, p model.Principal) (model.ProjectAccess, error) {
	return pg.LockProjectAuthorization(ctx, d.tx, p.UserID, d.id)
}

func validWebhook(v store.GitHubProjectWebhook, secretPresent, secretValid bool) error {
	if v.Version == nil {
		if v.RepositoryID != nil || v.Enabled || v.LastReceivedAt != nil || secretPresent {
			return fmt.Errorf("invalid unconfigured project webhook")
		}
		return nil
	}
	if *v.Version < 1 || v.RepositoryID == nil || *v.RepositoryID < 1 || !secretValid || (!v.Enabled && v.LastReceivedAt != nil) {
		return fmt.Errorf("invalid project webhook configuration")
	}
	return nil
}

func (d *projectAppDAO) ProjectWebhook(ctx context.Context) (store.GitHubProjectWebhook, error) {
	var v store.GitHubProjectWebhook
	var present, valid bool
	err := d.tx.QueryRow(ctx, `SELECT hook_version,hook_repository_id,hook_enabled,hook_last_received_at,
      CASE WHEN enabled THEN repository_id ELSE NULL END,
      hook_secret IS NOT NULL,
      CASE WHEN hook_secret IS NULL THEN false ELSE octet_length(hook_secret) BETWEEN 1 AND 4096 END
      FROM project_github WHERE project_id=$1`, d.projectID).Scan(&v.Version, &v.RepositoryID, &v.Enabled, &v.LastReceivedAt, &v.CurrentRepositoryID, &present, &valid)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, nil
	}
	if err != nil {
		return v, pg.QueryError("read project webhook", err)
	}
	if err = validWebhook(v, present, valid); err != nil {
		return v, err
	}
	return v, nil
}

func (d *projectWebhookWriter) LockWebhook(ctx context.Context) (store.GitHubProjectWebhookLocked, error) {
	var v store.GitHubProjectWebhookLocked
	err := d.tx.QueryRow(ctx, `SELECT hook_version,hook_repository_id,hook_enabled,hook_last_received_at,
      CASE WHEN enabled THEN repository_id ELSE NULL END,hook_secret
      FROM project_github WHERE project_id=$1 FOR UPDATE`, d.id).Scan(&v.Version, &v.RepositoryID, &v.Enabled, &v.LastReceivedAt, &v.CurrentRepositoryID, &v.Secret)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, nil
	}
	if err != nil {
		return v, pg.QueryError("lock project webhook", err)
	}
	v.Exists = true
	if err = validWebhook(v.GitHubProjectWebhook, v.Secret != nil, len(v.Secret) > 0 && len(v.Secret) <= 4096 && utf8.Valid(v.Secret)); err != nil {
		return v, err
	}
	// This statement runs after the connection lock, so it sees any completed revocation.
	err = d.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM project_github c
      JOIN project_ownership o ON o.project_id=c.project_id
      JOIN github_apps a ON a.id=c.app_resource_id AND a.deleted_at IS NULL AND a.credential_version=c.credential_version AND a.github_app_id=c.app_id
      JOIN github_app_team_grants g ON g.id=c.team_grant_id AND g.app_resource_id=a.id AND g.team_id=o.team_id AND g.revoked_at IS NULL
      WHERE c.project_id=$1 AND c.enabled AND c.installation_id IS NOT NULL AND c.repository_id IS NOT NULL)`, d.id).Scan(&v.BindingValid)
	if err != nil {
		return v, pg.QueryError("read project webhook binding", err)
	}
	return v, nil
}
func (d *projectWebhookWriter) SaveWebhook(ctx context.Context, w store.GitHubProjectWebhookWrite) (bool, error) {
	result, err := d.tx.Exec(ctx, `UPDATE project_github SET hook_version=$3,hook_repository_id=$4,hook_enabled=$5,hook_secret=$6,hook_last_received_at=NULL WHERE project_id=$1 AND hook_version IS NOT DISTINCT FROM $2::bigint`, d.id, w.ExpectedVersion, w.Version, w.RepositoryID, w.Enabled, w.Secret)
	if err != nil {
		return false, pg.QueryError("save project webhook", err)
	}
	return result.RowsAffected() == 1, nil
}

// ReadProjectWebhookSecret limits credential access to the signature-verification path.
func ReadProjectWebhookSecret(ctx context.Context, tx pgx.Tx, id string) (store.GitHubProjectWebhookSecret, error) {
	var result store.GitHubProjectWebhookSecret
	err := tx.QueryRow(ctx, `SELECT hook_version,hook_repository_id,hook_secret FROM project_github c
        JOIN projects p ON p.id=c.project_id WHERE c.project_id=$1 AND p.deleted_at IS NULL AND c.hook_enabled`, id).Scan(&result.Version, &result.RepositoryID, &result.Secret)
	if err != nil {
		return result, pg.QueryError("read project webhook credential", err)
	}
	if result.Version < 1 || result.RepositoryID < 1 || len(result.Secret) == 0 || len(result.Secret) > 4096 || !utf8.Valid(result.Secret) {
		return store.GitHubProjectWebhookSecret{}, fmt.Errorf("invalid project webhook credential")
	}
	return result, nil
}
