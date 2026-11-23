package github

import (
	"context"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type appAdminDAO struct {
	tx    pgx.Tx
	appID string
}

func NewAppAdminReader(tx pgx.Tx) store.GitHubAppAdminReader { return &appAdminDAO{tx: tx} }
func NewAppAdminWriter(tx pgx.Tx, appID string) store.GitHubAppAdminWriter {
	return &appAdminDAO{tx: tx, appID: appID}
}

func (d *appAdminDAO) writeApp(appID string) error {
	if d.appID == "" || d.appID != appID {
		return fmt.Errorf("github app administrator write does not match its locked App")
	}
	return nil
}

func (d *appAdminDAO) App(ctx context.Context, appID string) (githubpr.AppIdentity, error) {
	var app githubpr.AppIdentity
	var hasSecrets bool
	if err := d.tx.QueryRow(ctx, `SELECT id::text,github_app_id,name,github_name,github_slug,private_key_pem IS NOT NULL AND webhook_secret IS NOT NULL FROM github_apps WHERE id=$1 AND deleted_at IS NULL`, appID).
		Scan(&app.ID, &app.GitHubAppID, &app.Name, &app.GitHubName, &app.GitHubSlug, &hasSecrets); err != nil {
		return githubpr.AppIdentity{}, pg.QueryError("read github app identity", err)
	}
	if !hasSecrets {
		return githubpr.AppIdentity{}, fmt.Errorf("live github app credentials are missing")
	}
	return app, nil
}

func (d *appAdminDAO) AppAdminVisibility(ctx context.Context, appID, actor string) error {
	var secrets, admin bool
	err := d.tx.QueryRow(ctx, `SELECT private_key_pem IS NOT NULL AND webhook_secret IS NOT NULL, EXISTS (SELECT 1 FROM github_app_admins m WHERE m.app_resource_id=a.id AND m.user_id=$2) FROM github_apps a WHERE a.id=$1 AND a.deleted_at IS NULL`, appID, actor).Scan(&secrets, &admin)
	if err != nil {
		return pg.QueryError("check github app administrator", err)
	}
	if !secrets {
		return fmt.Errorf("live github app credentials are missing")
	}
	if !admin {
		return model.ErrNotFound
	}
	return nil
}

func (d *appAdminDAO) AdminMembershipVisibility(ctx context.Context, appID, userID string) error {
	var visible bool
	err := d.tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM github_app_admins WHERE app_resource_id=$1 AND user_id=$2)`, appID, userID).Scan(&visible)
	if err != nil {
		return pg.QueryError("check github app administrator target", err)
	}
	if !visible {
		return model.ErrNotFound
	}
	return nil
}

func (d *appAdminDAO) AdminInvitationVisibility(ctx context.Context, appID, invitationID string) error {
	var visible bool
	err := d.tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM github_app_admin_invitations WHERE app_resource_id=$1 AND id=$2)`, appID, invitationID).Scan(&visible)
	if err != nil {
		return pg.QueryError("check github app invitation target", err)
	}
	if !visible {
		return model.ErrNotFound
	}
	return nil
}

func (d *appAdminDAO) ObservedAt(ctx context.Context) (time.Time, error) {
	var now time.Time
	if err := d.tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&now); err != nil {
		return time.Time{}, pg.QueryError("read github app administrator clock", err)
	}
	return now.UTC(), nil
}

const appAdminFields = `app_resource_id::text,user_id::text,version,created_at,updated_at`

func scanAppAdmin(row rowScanner) (githubpr.AdminMembership, error) {
	var m githubpr.AdminMembership
	if err := row.Scan(&m.AppID, &m.UserID, &m.Version, &m.CreatedAt, &m.UpdatedAt); err != nil {
		return githubpr.AdminMembership{}, err
	}
	m.CreatedAt, m.UpdatedAt = m.CreatedAt.UTC(), m.UpdatedAt.UTC()
	return m, nil
}

func (d *appAdminDAO) Membership(ctx context.Context, appID, userID string) (githubpr.AdminMembership, error) {
	m, err := scanAppAdmin(d.tx.QueryRow(ctx, `SELECT `+appAdminFields+` FROM github_app_admins WHERE app_resource_id=$1 AND user_id=$2`, appID, userID))
	if err != nil {
		return githubpr.AdminMembership{}, pg.QueryError("read github app administrator", err)
	}
	return m, nil
}

func (d *appAdminDAO) AdminPage(ctx context.Context, appID string, page store.Page) (store.GitHubAppAdminPage, error) {
	if page.Limit < 1 || page.Limit > 100 {
		return store.GitHubAppAdminPage{}, fmt.Errorf("github app administrator limit must be 1..100")
	}
	stamp, id := pg.PageValues(page)
	rows, err := d.tx.Query(ctx, `SELECT m.app_resource_id::text,m.user_id::text,m.version,m.created_at,m.updated_at,u.name,u.email,u.avatar_url
 FROM github_app_admins m LEFT JOIN users u ON u.id=m.user_id WHERE m.app_resource_id=$1
 AND ($2::timestamptz IS NULL OR (m.created_at,m.user_id)>($2,$3::uuid)) ORDER BY m.created_at,m.user_id LIMIT $4`, appID, stamp, id, page.Limit+1)
	if err != nil {
		return store.GitHubAppAdminPage{}, pg.QueryError("list github app administrators", err)
	}
	defer rows.Close()
	result := store.GitHubAppAdminPage{Items: []githubpr.AdminProfile{}}
	for rows.Next() {
		var m githubpr.AdminProfile
		if err := rows.Scan(&m.AppID, &m.UserID, &m.Version, &m.CreatedAt, &m.UpdatedAt, &m.Name, &m.Email, &m.AvatarURL); err != nil {
			return store.GitHubAppAdminPage{}, pg.QueryError("list github app administrators", err)
		}
		m.CreatedAt, m.UpdatedAt = m.CreatedAt.UTC(), m.UpdatedAt.UTC()
		result.Items = append(result.Items, m)
	}
	if err := rows.Err(); err != nil {
		return store.GitHubAppAdminPage{}, pg.QueryError("list github app administrators", err)
	}
	result.HasMore = len(result.Items) > page.Limit
	if result.HasMore {
		result.Items = result.Items[:page.Limit]
	}
	return result, nil
}

func (d *appAdminDAO) CountAdmins(ctx context.Context, appID string) (int64, error) {
	if err := d.writeApp(appID); err != nil {
		return 0, err
	}
	var count int64
	if err := d.tx.QueryRow(ctx, `SELECT count(*) FROM github_app_admins WHERE app_resource_id=$1`, appID).Scan(&count); err != nil {
		return 0, pg.QueryError("count github app administrators", err)
	}
	return count, nil
}

func (d *appAdminDAO) AddAdmin(ctx context.Context, appID, userID string) (githubpr.AdminMembership, error) {
	if err := d.writeApp(appID); err != nil {
		return githubpr.AdminMembership{}, err
	}
	m, err := scanAppAdmin(d.tx.QueryRow(ctx, `INSERT INTO github_app_admins(app_resource_id,user_id)
 SELECT $1,id FROM users WHERE id=$2 RETURNING `+appAdminFields, appID, userID))
	if err != nil {
		return githubpr.AdminMembership{}, pg.QueryError("add github app administrator", err)
	}
	return m, nil
}

func (d *appAdminDAO) RemoveAdmin(ctx context.Context, appID, userID string, version int64) error {
	if err := d.writeApp(appID); err != nil {
		return err
	}
	return appAdminMutation(ctx, d.tx, "remove github app administrator", `DELETE FROM github_app_admins WHERE app_resource_id=$1 AND user_id=$2 AND version=$3`, appID, userID, version)
}

func appAdminMutation(ctx context.Context, tx pgx.Tx, phase, query string, args ...any) error {
	result, err := tx.Exec(ctx, query, args...)
	if err != nil {
		return pg.QueryError(phase, err)
	}
	if result.RowsAffected() != 1 {
		return pg.QueryError(phase, pgx.ErrNoRows)
	}
	return nil
}
