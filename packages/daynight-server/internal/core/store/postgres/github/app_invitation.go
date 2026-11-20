package github

import (
	"context"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

const appInvitationFields = `i.id::text,i.app_resource_id::text,i.created_by::text,i.issuer_membership_version,i.created_at,i.expires_at,i.revoked_at,i.consumed_at,i.consumed_by::text`

func scanAppInvitation(row rowScanner, extra ...any) (githubpr.AppInvitation, error) {
	var i githubpr.AppInvitation
	targets := []any{&i.ID, &i.AppID, &i.CreatedBy, &i.IssuerMembershipVersion, &i.CreatedAt, &i.ExpiresAt, &i.RevokedAt, &i.ConsumedAt, &i.ConsumedBy}
	if err := row.Scan(append(targets, extra...)...); err != nil {
		return githubpr.AppInvitation{}, err
	}
	i.CreatedAt, i.ExpiresAt = i.CreatedAt.UTC(), i.ExpiresAt.UTC()
	i.RevokedAt, i.ConsumedAt = pg.UTCTime(i.RevokedAt), pg.UTCTime(i.ConsumedAt)
	return i, nil
}

func (d *appAdminDAO) AvailableAdminInvitation(ctx context.Context, hash []byte) (store.GitHubAdminInvitationRef, error) {
	var ref store.GitHubAdminInvitationRef
	var secrets bool
	err := d.tx.QueryRow(ctx, `SELECT i.id::text,i.app_resource_id::text,i.expires_at, a.private_key_pem IS NOT NULL AND a.webhook_secret IS NOT NULL
 FROM github_app_admin_invitations i JOIN github_apps a ON a.id=i.app_resource_id AND a.deleted_at IS NULL
 JOIN github_app_admins m ON m.app_resource_id=i.app_resource_id AND m.user_id=i.created_by AND m.version=i.issuer_membership_version
 WHERE i.token_hash=$1 AND i.revoked_at IS NULL AND i.consumed_at IS NULL AND i.expires_at>statement_timestamp()`, hash).Scan(&ref.ID, &ref.AppID, &ref.ExpiresAt, &secrets)
	if err != nil {
		return store.GitHubAdminInvitationRef{}, pg.QueryError("check github admin invitation availability", err)
	}
	if !secrets {
		return store.GitHubAdminInvitationRef{}, fmt.Errorf("live github app credentials are missing")
	}
	ref.ExpiresAt = ref.ExpiresAt.UTC()
	return ref, nil
}

func (d *appAdminDAO) Invitation(ctx context.Context, appID, invitationID string) (githubpr.AppInvitation, error) {
	i, err := scanAppInvitation(d.tx.QueryRow(ctx, `SELECT `+appInvitationFields+` FROM github_app_admin_invitations i WHERE i.app_resource_id=$1 AND i.id=$2`, appID, invitationID))
	if err != nil {
		return githubpr.AppInvitation{}, pg.QueryError("read github app invitation", err)
	}
	return i, nil
}

func (d *appAdminDAO) InvitationByHash(ctx context.Context, hash []byte) (githubpr.AppInvitation, error) {
	i, err := scanAppInvitation(d.tx.QueryRow(ctx, `SELECT `+appInvitationFields+` FROM github_app_admin_invitations i WHERE i.token_hash=$1`, hash))
	if err != nil {
		return githubpr.AppInvitation{}, pg.QueryError("read github app invitation hash", err)
	}
	return i, nil
}

func (d *appAdminDAO) InvitationPage(ctx context.Context, appID string, page store.Page) (store.GitHubAppInvitationPage, error) {
	if page.Limit < 1 || page.Limit > 100 {
		return store.GitHubAppInvitationPage{}, fmt.Errorf("github app invitation limit must be 1..100")
	}
	stamp, id := pg.PageValues(page)
	rows, err := d.tx.Query(ctx, `SELECT `+appInvitationFields+`,m.version
 FROM github_app_admin_invitations i LEFT JOIN github_app_admins m ON m.app_resource_id=i.app_resource_id AND m.user_id=i.created_by
 WHERE i.app_resource_id=$1 AND ($2::timestamptz IS NULL OR (i.created_at,i.id)>($2,$3::uuid))
 ORDER BY i.created_at,i.id LIMIT $4`, appID, stamp, id, page.Limit+1)
	if err != nil {
		return store.GitHubAppInvitationPage{}, pg.QueryError("list github app invitations", err)
	}
	defer rows.Close()
	result := store.GitHubAppInvitationPage{Items: []store.GitHubAppInvitationRecord{}}
	for rows.Next() {
		var record store.GitHubAppInvitationRecord
		var err error
		record.Invitation, err = scanAppInvitation(rows, &record.CurrentIssuerMembershipVersion)
		if err != nil {
			return store.GitHubAppInvitationPage{}, pg.QueryError("list github app invitations", err)
		}
		result.Items = append(result.Items, record)
	}
	if err := rows.Err(); err != nil {
		return store.GitHubAppInvitationPage{}, pg.QueryError("list github app invitations", err)
	}
	result.HasMore = len(result.Items) > page.Limit
	if result.HasMore {
		result.Items = result.Items[:page.Limit]
	}
	return result, nil
}

func (d *appAdminDAO) CreateInvitation(ctx context.Context, i githubpr.AppInvitation, hash []byte) error {
	if err := d.writeApp(i.AppID); err != nil {
		return err
	}
	_, err := d.tx.Exec(ctx, `INSERT INTO github_app_admin_invitations(id,app_resource_id,token_hash,created_by,issuer_membership_version,created_at,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7)`, i.ID, i.AppID, hash, i.CreatedBy, i.IssuerMembershipVersion, i.CreatedAt, i.ExpiresAt)
	return pg.AuthQueryError("create github app invitation", err)
}

func (d *appAdminDAO) RevokeInvitation(ctx context.Context, appID, invitationID string, now time.Time) error {
	if err := d.writeApp(appID); err != nil {
		return err
	}
	return appAdminMutation(ctx, d.tx, "revoke github app invitation", `UPDATE github_app_admin_invitations SET revoked_at=$3 WHERE app_resource_id=$1 AND id=$2 AND revoked_at IS NULL AND consumed_at IS NULL`, appID, invitationID, now)
}

func (d *appAdminDAO) ConsumeInvitation(ctx context.Context, appID, invitationID, userID string, now time.Time) error {
	if err := d.writeApp(appID); err != nil {
		return err
	}
	return appAdminMutation(ctx, d.tx, "consume github app invitation", `UPDATE github_app_admin_invitations SET consumed_at=$4,consumed_by=$3 WHERE app_resource_id=$1 AND id=$2 AND revoked_at IS NULL AND consumed_at IS NULL`, appID, invitationID, userID, now)
}
