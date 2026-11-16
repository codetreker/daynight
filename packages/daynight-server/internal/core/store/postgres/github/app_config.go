package github

import (
	"context"
	"fmt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
	"math"
)

type appConfigDAO struct {
	tx    pgx.Tx
	appID string
}

func NewAppConfigReader(tx pgx.Tx, appID string) store.GitHubAppConfigReader {
	return &appConfigDAO{tx, appID}
}
func NewAppConfigWriter(tx pgx.Tx, appID string) store.GitHubAppConfigWriter {
	return &appConfigDAO{tx, appID}
}
func (d *appConfigDAO) Facts(ctx context.Context, actor string) (store.GitHubAppConfigFacts, error) {
	var f store.GitHubAppConfigFacts
	var hasSecrets bool
	a := &f.App
	err := d.tx.QueryRow(ctx, `SELECT `+appProjection+`,a.credential_version,a.impact_version,m.version,a.private_key_pem,a.webhook_secret,
 (EXISTS (SELECT 1 FROM github_app_team_grants g WHERE g.app_resource_id=a.id AND g.revoked_at IS NULL) OR EXISTS (SELECT 1 FROM project_github c WHERE c.app_resource_id=a.id))
 FROM github_apps a JOIN github_app_admins m ON m.app_resource_id=a.id AND m.user_id=$2
 WHERE a.id=$1 AND a.deleted_at IS NULL`, d.appID, actor).Scan(&a.ID, &a.GitHubAppID, &a.Name, &a.GitHubName, &a.GitHubSlug, &a.Version,
		&a.Administrators, &a.AuthorizedTeams, &a.ConnectedProjects, &a.CreatedAt, &a.UpdatedAt, &hasSecrets,
		&f.CredentialVersion, &f.ImpactVersion, &f.MembershipVersion, &f.Credentials.PrivateKeyPEM, &f.Credentials.WebhookSecret, &f.HasImpact)
	if err != nil {
		return store.GitHubAppConfigFacts{}, pg.QueryError("read github app configuration", err)
	}
	if !hasSecrets {
		return store.GitHubAppConfigFacts{}, fmt.Errorf("live github app credentials are missing")
	}
	a.CreatedAt, a.UpdatedAt = a.CreatedAt.UTC(), a.UpdatedAt.UTC()
	return f, nil
}
func (d *appConfigDAO) Update(ctx context.Context, v store.GitHubAppConfigUpdate) (githubpr.AppMetadata, error) {
	tag, err := d.tx.Exec(ctx, `UPDATE github_apps SET name=$2,github_name=$3,github_slug=$4,version=$5,credential_version=$6,private_key_pem=$7,webhook_secret=$8,updated_at=statement_timestamp() WHERE id=$1 AND deleted_at IS NULL`, d.appID, v.Name, v.GitHubName, v.GitHubSlug, v.Version, v.CredentialVersion, v.Credentials.PrivateKeyPEM, v.Credentials.WebhookSecret)
	if err != nil {
		return githubpr.AppMetadata{}, pg.QueryError("update github app configuration", err)
	}
	if tag.RowsAffected() != 1 {
		return githubpr.AppMetadata{}, model.ErrNotFound
	}
	a, err := scanApp(d.tx.QueryRow(ctx, `SELECT `+appProjection+` FROM github_apps a WHERE a.id=$1 AND a.deleted_at IS NULL`, d.appID))
	if err != nil {
		return githubpr.AppMetadata{}, pg.QueryError("read updated github app", err)
	}
	return a, nil
}
func (d *appConfigDAO) FenceConnections(ctx context.Context, v store.GitHubAppCredentialFence) error {
	var exhausted bool
	err := d.tx.QueryRow(ctx, `SELECT COALESCE(bool_or(generation=$2 OR revision=$2),false) FROM (SELECT generation,revision FROM project_github WHERE app_resource_id=$1 ORDER BY project_id FOR UPDATE) locked`, d.appID, int64(math.MaxInt64)).Scan(&exhausted)
	if err != nil {
		return pg.QueryError("lock github app connections", err)
	}
	if exhausted {
		return &model.Fault{Code: "version_exhausted", Message: "GitHub connection version is exhausted."}
	}
	if _, err = d.tx.Exec(ctx, `DELETE FROM project_github_pending_prs WHERE project_id IN (SELECT project_id FROM project_github WHERE app_resource_id=$1)`, d.appID); err != nil {
		return pg.QueryError("clear github app pending", err)
	}
	_, err = d.tx.Exec(ctx, `UPDATE project_github SET credential_version=$2,generation=generation+1,revision=revision+1,access_state=$3,access_reason=NULL,access_checked_at=NULL,next_access_check_at=CASE WHEN sync_enabled AND $4 THEN statement_timestamp() ELSE NULL END,next_poll_at=NULL,not_before=NULL,claim_token=NULL,claim_until=NULL,claim_kind=NULL,access_hint_id=NULL,access_delivery_id=NULL,updated_at=statement_timestamp() WHERE app_resource_id=$1`, d.appID, v.CredentialVersion, v.AccessState, v.ScheduleSyncAccess)
	if err != nil {
		return pg.QueryError("fence github app connections", err)
	}
	return nil
}
func (d *appConfigDAO) StopAppConnections(ctx context.Context, v store.GitHubStopDecision) error {
	return NewConnectionStopWriter(d.tx, d.appID).StopAppConnections(ctx, v)
}
func (d *appConfigDAO) RemoveRelations(ctx context.Context) error {
	for _, q := range []string{`DELETE FROM github_app_admin_invitations WHERE app_resource_id=$1`, `DELETE FROM github_app_admins WHERE app_resource_id=$1`, `UPDATE github_app_team_grants SET revoked_at=statement_timestamp() WHERE app_resource_id=$1 AND revoked_at IS NULL`} {
		if _, err := d.tx.Exec(ctx, q, d.appID); err != nil {
			return pg.QueryError("remove github app relations", err)
		}
	}
	return nil
}
func (d *appConfigDAO) Tombstone(ctx context.Context, impactVersion int64) error {
	tag, err := d.tx.Exec(ctx, `UPDATE github_apps SET deleted_at=statement_timestamp(),private_key_pem=NULL,webhook_secret=NULL,impact_version=$2,updated_at=statement_timestamp() WHERE id=$1 AND deleted_at IS NULL`, d.appID, impactVersion)
	if err != nil {
		return pg.QueryError("remove github app", err)
	}
	if tag.RowsAffected() != 1 {
		return model.ErrNotFound
	}
	return nil
}
