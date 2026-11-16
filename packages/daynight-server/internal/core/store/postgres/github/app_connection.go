package github

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"
	"github.com/jackc/pgx/v5"
)

type projectAppDAO struct {
	*writer
	lock bool
}

func NewProjectAppReader(tx pgx.Tx, projectID string) store.GitHubProjectAppReadDAO {
	return &projectAppDAO{writer: &writer{tx, projectID}}
}
func NewProjectAppWriter(tx pgx.Tx, projectID string) store.GitHubProjectAppWriteDAO {
	return &projectAppDAO{writer: &writer{tx, projectID}, lock: true}
}

func (d *projectAppDAO) Facts(ctx context.Context, p model.Principal) (store.GitHubProjectAppFacts, error) {
	var f store.GitHubProjectAppFacts
	var err error
	f.Access, err = pg.ReadProjectAccess(ctx, d.tx, p.UserID, d.projectID)
	if err != nil {
		return f, err
	}
	f.Project, err = project.NewReader(d.tx).Project(ctx, d.projectID)
	if err != nil {
		return f, err
	}
	f.Connection, err = readConnection(ctx, d.tx, d.projectID, d.lock)
	if err != nil {
		return f, err
	}
	// The fresh statement observes cleanup performed during an App lock wait.
	err = d.tx.QueryRow(ctx, `SELECT app_resource_id::text,team_grant_id::text,credential_version FROM project_github WHERE project_id=$1`, d.projectID).Scan(&f.AppResourceID, &f.GrantID, &f.CredentialVersion)
	if err == pgx.ErrNoRows {
		return f, nil
	}
	if err != nil {
		return f, pg.QueryError("read project App identity", err)
	}
	return f, nil
}

func (d *projectAppDAO) App(ctx context.Context, appID, grantID, teamID string) (store.GitHubProjectApp, error) {
	var a store.GitHubProjectApp
	err := d.tx.QueryRow(ctx, `SELECT a.id::text,a.name,a.github_slug,a.github_app_id,a.version,a.credential_version FROM github_apps a JOIN github_app_team_grants g ON g.app_resource_id=a.id WHERE a.id=$1 AND a.deleted_at IS NULL AND g.id=$2 AND g.team_id=$3 AND g.revoked_at IS NULL`, appID, grantID, teamID).Scan(&a.ID, &a.Name, &a.GitHubSlug, &a.GitHubAppID, &a.Version, &a.CredentialVersion)
	if err != nil {
		return a, pg.QueryError("read project App grant", err)
	}
	return a, nil
}

func (d *projectAppDAO) Save(ctx context.Context, w store.GitHubProjectAppWrite) (bool, error) {
	ok, err := d.SaveConfiguration(ctx, w.Configuration)
	if err != nil || !ok {
		return ok, err
	}
	result, err := d.tx.Exec(ctx, `UPDATE project_github SET app_resource_id=$2,team_grant_id=$3,credential_version=$4,not_before=CASE WHEN $6 THEN NULL ELSE not_before END WHERE project_id=$1 AND version=$5 AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM github_apps a JOIN github_app_team_grants g ON g.app_resource_id=a.id JOIN project_ownership o ON o.team_id=g.team_id WHERE a.id=$2 AND a.deleted_at IS NULL AND a.credential_version=$4 AND g.id=$3 AND g.revoked_at IS NULL AND o.project_id=$1))`, d.projectID, w.AppResourceID, w.GrantID, w.CredentialVersion, w.Configuration.Version, w.ClearWork)
	if err != nil {
		return false, pg.QueryError("save project App identity", err)
	}
	if result.RowsAffected() != 1 {
		return false, fmt.Errorf("project App identity changed inside locked scope")
	}
	return true, nil
}

func (d *projectAppDAO) AdvanceImpact(ctx context.Context, appID string) error {
	return NewConnectionStopWriter(d.tx, appID).AdvanceImpact(ctx)
}
