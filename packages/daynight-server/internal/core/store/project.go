package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5"
)

func readProject(ctx context.Context, tx pgx.Tx, id string) (core.Project, error) {
	project, err := scanProject(tx.QueryRow(ctx, `SELECT `+projectProjection+` FROM `+projectRelation+` WHERE p.id = $1`, id))
	if err != nil {
		return core.Project{}, queryError("read project", err)
	}
	return project, nil
}

func (tx *ProjectTx) Project(ctx context.Context) (core.Project, error) {
	return readProject(ctx, tx.tx, tx.projectID)
}

func (tx *ProjectTx) UpdateProjectSettings(ctx context.Context, minutes int32) (core.Project, error) {
	_, err := tx.tx.Exec(ctx, `UPDATE projects SET execution_warning_minutes = $2,
		settings_version = settings_version + 1, updated_at = statement_timestamp()
		WHERE id = $1`, tx.projectID, minutes)
	if err != nil {
		return core.Project{}, queryError("update project settings", err)
	}
	return readProject(ctx, tx.tx, tx.projectID)
}
