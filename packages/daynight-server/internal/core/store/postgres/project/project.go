package project

import (
	"context"

	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

func readProject(ctx context.Context, tx pgx.Tx, id string) (model.Project, error) {
	project, err := pg.ScanProject(tx.QueryRow(ctx, `SELECT `+pg.ProjectProjection+` FROM `+pg.ProjectRelation+` WHERE p.id = $1 AND p.deleted_at IS NULL`, id))
	if err != nil {
		return model.Project{}, pg.QueryError("read project", err)
	}
	return project, nil
}

func (tx *writer) Project(ctx context.Context) (model.Project, error) {
	return readProject(ctx, tx.tx, tx.projectID)
}

func (tx *writer) UpdateProjectSettings(ctx context.Context, minutes int32) (model.Project, error) {
	_, err := tx.tx.Exec(ctx, `UPDATE projects SET execution_warning_minutes = $2,
		settings_version = settings_version + 1, updated_at = statement_timestamp()
		WHERE id = $1`, tx.projectID, minutes)
	if err != nil {
		return model.Project{}, pg.QueryError("update project settings", err)
	}
	return readProject(ctx, tx.tx, tx.projectID)
}
func (s *reader) Project(ctx context.Context, id string) (model.Project, error) {
	return readProject(ctx, s.tx, id)
}

func (s *reader) Projects(ctx context.Context, page Page) (ProjectPage, error) {
	afterTime, afterID := pg.PageValues(page)
	rows, err := s.tx.Query(ctx, `SELECT `+pg.ProjectProjection+` FROM `+pg.ProjectRelation+`
		WHERE p.deleted_at IS NULL AND ($1::timestamptz IS NULL OR (p.created_at, p.id) > ($1, $2::uuid))
		ORDER BY p.created_at, p.id LIMIT $3`, afterTime, afterID, page.Limit+1)
	if err != nil {
		return ProjectPage{}, pg.QueryError("list projects", err)
	}
	defer rows.Close()
	items := make([]model.Project, 0)
	for rows.Next() {
		project, err := pg.ScanProject(rows)
		if err != nil {
			return ProjectPage{}, pg.QueryError("list projects", err)
		}
		items = append(items, project)
	}
	if err := rows.Err(); err != nil {
		return ProjectPage{}, pg.QueryError("list projects", err)
	}
	hasMore := len(items) > page.Limit
	if hasMore {
		items = items[:page.Limit]
	}
	return ProjectPage{Items: items, HasMore: hasMore}, nil
}

func (tx *writer) InvalidateTaskCache(ctx context.Context) error {
	if _, err := tx.tx.Exec(ctx, `UPDATE projects SET task_cache_epoch = gen_random_uuid() WHERE id = $1`, tx.projectID); err != nil {
		return pg.QueryError("invalidate deleted task cache", err)
	}
	return nil
}

// RotateTagCatalogEpoch invalidates catalog continuations without changing Project metadata.
func (tx *writer) RotateTagCatalogEpoch(ctx context.Context) error {
	result, err := tx.tx.Exec(ctx, `UPDATE projects SET tag_catalog_epoch=gen_random_uuid() WHERE id=$1`, tx.projectID)
	if err != nil {
		return pg.QueryError("rotate tag catalog epoch", err)
	}
	if result.RowsAffected() != 1 {
		return pg.QueryError("rotate tag catalog epoch", model.ErrNotFound)
	}
	return nil
}
