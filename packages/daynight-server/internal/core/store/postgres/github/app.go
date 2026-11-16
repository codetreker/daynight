package github

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type appDAO struct{ tx pgx.Tx }

func NewAppReader(tx pgx.Tx) store.GitHubAppReadDAO  { return &appDAO{tx: tx} }
func NewAppWriter(tx pgx.Tx) store.GitHubAppWriteDAO { return &appDAO{tx: tx} }

const appProjection = `a.id::text, a.github_app_id, a.name, a.github_name, a.github_slug, a.version,
 (SELECT count(*) FROM github_app_admins m WHERE m.app_resource_id=a.id),
 (SELECT count(*) FROM github_app_team_grants g WHERE g.app_resource_id=a.id AND g.revoked_at IS NULL),
 (SELECT count(*) FROM project_github c JOIN projects p ON p.id=c.project_id AND p.deleted_at IS NULL
  WHERE c.app_resource_id=a.id AND c.enabled),
 a.created_at, a.updated_at, a.private_key_pem IS NOT NULL AND a.webhook_secret IS NOT NULL`

func scanApp(row rowScanner) (githubpr.AppMetadata, error) {
	var a githubpr.AppMetadata
	var hasSecrets bool
	if err := row.Scan(&a.ID, &a.GitHubAppID, &a.Name, &a.GitHubName, &a.GitHubSlug, &a.Version,
		&a.Administrators, &a.AuthorizedTeams, &a.ConnectedProjects, &a.CreatedAt, &a.UpdatedAt, &hasSecrets); err != nil {
		return githubpr.AppMetadata{}, err
	}
	if !hasSecrets {
		return githubpr.AppMetadata{}, fmt.Errorf("live github app credentials are missing")
	}
	a.CreatedAt, a.UpdatedAt = a.CreatedAt.UTC(), a.UpdatedAt.UTC()
	return a, nil
}

func (d *appDAO) Create(ctx context.Context, input store.GitHubAppCreate) (githubpr.AppMetadata, error) {
	_, err := d.tx.Exec(ctx, `INSERT INTO github_apps (id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret)
 VALUES ($1,$2,$3,$4,$5,$6,$7)`, input.ID, input.GitHubAppID, input.Name, input.GitHubName, input.GitHubSlug,
		input.Credentials.PrivateKeyPEM, input.Credentials.WebhookSecret)
	if err != nil {
		var pgerr *pgconn.PgError
		if errors.As(err, &pgerr) && pgerr.Code == "23505" {
			switch pgerr.ConstraintName {
			case "github_apps_live_github_app_id":
				return githubpr.AppMetadata{}, store.ErrGitHubAppIDConflict
			case "github_apps_pkey":
				return githubpr.AppMetadata{}, store.ErrGitHubAppResourceIDConflict
			}
		}
		return githubpr.AppMetadata{}, pg.QueryError("insert github app", err)
	}
	if _, err := d.tx.Exec(ctx, `INSERT INTO github_app_admins (app_resource_id,user_id) VALUES ($1,$2)`, input.ID, input.CreatorUserID); err != nil {
		return githubpr.AppMetadata{}, pg.QueryError("insert github app administrator", err)
	}
	return d.Get(ctx, input.ID, input.CreatorUserID)
}

func (d *appDAO) Get(ctx context.Context, id, actorID string) (githubpr.AppMetadata, error) {
	a, err := scanApp(d.tx.QueryRow(ctx, `SELECT `+appProjection+` FROM github_apps a
 WHERE a.id=$1 AND a.deleted_at IS NULL AND EXISTS
 (SELECT 1 FROM github_app_admins m WHERE m.app_resource_id=a.id AND m.user_id=$2)`, id, actorID))
	if err != nil {
		return githubpr.AppMetadata{}, pg.QueryError("read github app", err)
	}
	return a, nil
}

func (d *appDAO) List(ctx context.Context, q store.GitHubAppQuery) (store.GitHubAppPage, error) {
	if q.Limit < 1 || q.Limit > 100 {
		return store.GitHubAppPage{}, fmt.Errorf("github app limit must be 1..100")
	}
	stamp, id := pg.PageValues(store.Page{After: q.After})
	rows, err := d.tx.Query(ctx, `SELECT `+appProjection+` FROM github_apps a
 WHERE a.deleted_at IS NULL AND EXISTS
 (SELECT 1 FROM github_app_admins m WHERE m.app_resource_id=a.id AND m.user_id=$1)
 AND ($2::timestamptz IS NULL OR (a.created_at,a.id)>($2,$3::uuid))
 ORDER BY a.created_at,a.id LIMIT $4`, q.ActorID, stamp, id, q.Limit+1)
	if err != nil {
		return store.GitHubAppPage{}, pg.QueryError("list github apps", err)
	}
	defer rows.Close()
	page := store.GitHubAppPage{Items: []githubpr.AppMetadata{}}
	for rows.Next() {
		a, err := scanApp(rows)
		if err != nil {
			return store.GitHubAppPage{}, pg.QueryError("list github apps", err)
		}
		page.Items = append(page.Items, a)
	}
	if err := rows.Err(); err != nil {
		return store.GitHubAppPage{}, pg.QueryError("list github apps", err)
	}
	page.HasMore = len(page.Items) > q.Limit
	if page.HasMore {
		page.Items = page.Items[:q.Limit]
	}
	return page, nil
}
