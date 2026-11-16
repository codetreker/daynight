package github

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type appImpactDAO struct{ tx pgx.Tx }

func NewAppImpactReader(tx pgx.Tx) store.GitHubAppImpactDAO { return &appImpactDAO{tx: tx} }

// The affected set is defined by the exact stored binding, including projects
// the administrator cannot read. Project access is computed separately.
const impactConnections = `SELECT c.project_id FROM project_github c
 JOIN projects p ON p.id=c.project_id AND p.deleted_at IS NULL
 WHERE c.app_resource_id=$1 AND c.enabled AND ($3::uuid IS NULL OR c.team_grant_id=$3)`

func (d *appImpactDAO) Summary(ctx context.Context, q store.GitHubAppImpactQuery) (store.GitHubAppImpact, error) {
	var result store.GitHubAppImpact
	var grantCurrent bool
	err := d.tx.QueryRow(ctx, `SELECT a.version,a.impact_version,
 ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM github_app_team_grants g
 WHERE g.id=$3 AND g.app_resource_id=a.id AND g.revoked_at IS NULL)) FROM github_apps a
 WHERE a.id=$1 AND a.deleted_at IS NULL AND EXISTS
 (SELECT 1 FROM github_app_admins m WHERE m.app_resource_id=a.id AND m.user_id=$2)`, q.AppID, q.ActorID, q.GrantID).Scan(&result.Version, &result.ImpactVersion, &grantCurrent)
	if err != nil {
		return result, pg.AuthQueryError("read github app impact", err)
	}
	if !grantCurrent {
		result.GrantMissing = true
		return result, nil
	}
	err = d.tx.QueryRow(ctx, `WITH affected AS (`+impactConnections+`), access AS (`+pg.ProjectAccessRelation+`)
 SELECT count(*), count(*) FILTER (WHERE access.user_id IS NOT NULL)
 FROM affected LEFT JOIN access ON access.project_id=affected.project_id AND access.user_id=$2`, q.AppID, q.ActorID, q.GrantID).Scan(&result.TotalProjects, &result.VisibleProjects)
	if err != nil {
		return store.GitHubAppImpact{}, pg.QueryError("count github app impact", err)
	}
	result.HiddenProjects = result.TotalProjects - result.VisibleProjects
	return result, nil
}

func (d *appImpactDAO) Teams(ctx context.Context, q store.GitHubAppImpactQuery) (store.GitHubAppImpactTeams, error) {
	if q.Limit < 1 || q.Limit > 100 {
		return store.GitHubAppImpactTeams{}, fmt.Errorf("impact limit must be 1..100")
	}
	var after any
	if q.AfterID != "" {
		after = q.AfterID
	}
	rows, err := d.tx.Query(ctx, `SELECT t.id::text, CASE WHEN t.personal_user_id IS NULL THEN 'ordinary' ELSE 'personal' END,
 CASE WHEN t.personal_user_id IS NULL THEN t.name ELSE NULL END, (SELECT count(*) FROM project_github c JOIN projects p ON p.id=c.project_id AND p.deleted_at IS NULL
 WHERE c.app_resource_id=$1 AND c.team_grant_id=g.id AND c.enabled)
 FROM github_app_team_grants g JOIN teams t ON t.id=g.team_id
 WHERE g.app_resource_id=$1 AND g.revoked_at IS NULL AND ($3::uuid IS NULL OR g.id=$3)
 AND EXISTS (SELECT 1 FROM github_apps a JOIN github_app_admins m ON m.app_resource_id=a.id
             WHERE a.id=$1 AND a.deleted_at IS NULL AND m.user_id=$2)
 AND ($4::uuid IS NULL OR t.id>$4::uuid) ORDER BY t.id LIMIT $5`, q.AppID, q.ActorID, q.GrantID, after, q.Limit+1)
	if err != nil {
		return store.GitHubAppImpactTeams{}, pg.QueryError("list github app impact teams", err)
	}
	defer rows.Close()
	out := store.GitHubAppImpactTeams{Items: []store.GitHubAppImpactTeam{}}
	for rows.Next() {
		var item store.GitHubAppImpactTeam
		if err := rows.Scan(&item.Team.ID, &item.Team.Kind, &item.Team.Name, &item.Projects); err != nil {
			return store.GitHubAppImpactTeams{}, pg.QueryError("scan github app impact team", err)
		}
		out.Items = append(out.Items, item)
	}
	if err := rows.Err(); err != nil {
		return store.GitHubAppImpactTeams{}, pg.QueryError("list github app impact teams", err)
	}
	out.HasMore = len(out.Items) > q.Limit
	if out.HasMore {
		out.Items = out.Items[:q.Limit]
	}
	return out, nil
}

func (d *appImpactDAO) Projects(ctx context.Context, q store.GitHubAppImpactQuery) (store.GitHubAppImpactProjects, error) {
	if q.Limit < 1 || q.Limit > 100 {
		return store.GitHubAppImpactProjects{}, fmt.Errorf("impact limit must be 1..100")
	}
	var after any
	if q.AfterID != "" {
		after = q.AfterID
	}
	rows, err := d.tx.Query(ctx, `WITH affected AS (`+impactConnections+`), access AS (`+pg.ProjectAccessRelation+`)
 SELECT p.id::text,p.name,p.repo_url FROM affected JOIN projects p ON p.id=affected.project_id
 JOIN access ON access.project_id=p.id AND access.user_id=$2
 WHERE EXISTS (SELECT 1 FROM github_apps a JOIN github_app_admins m ON m.app_resource_id=a.id
               WHERE a.id=$1 AND a.deleted_at IS NULL AND m.user_id=$2)
 AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM github_app_team_grants g
               WHERE g.id=$3 AND g.app_resource_id=$1 AND g.revoked_at IS NULL))
 AND ($4::uuid IS NULL OR p.id>$4::uuid) ORDER BY p.id LIMIT $5`, q.AppID, q.ActorID, q.GrantID, after, q.Limit+1)
	if err != nil {
		return store.GitHubAppImpactProjects{}, pg.QueryError("list github app impact projects", err)
	}
	defer rows.Close()
	out := store.GitHubAppImpactProjects{Items: []store.GitHubAppImpactProject{}}
	for rows.Next() {
		var item store.GitHubAppImpactProject
		if err := rows.Scan(&item.ID, &item.Name, &item.RepoURL); err != nil {
			return store.GitHubAppImpactProjects{}, pg.QueryError("scan github app impact project", err)
		}
		out.Items = append(out.Items, item)
	}
	if err := rows.Err(); err != nil {
		return store.GitHubAppImpactProjects{}, pg.QueryError("list github app impact projects", err)
	}
	out.HasMore = len(out.Items) > q.Limit
	if out.HasMore {
		out.Items = out.Items[:q.Limit]
	}
	return out, nil
}
