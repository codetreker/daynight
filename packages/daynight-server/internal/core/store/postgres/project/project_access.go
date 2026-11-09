package project

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func (tx *thread) LockProjectAuthorization(ctx context.Context, principal model.Principal, projectID string) (model.ProjectAccess, error) {
	access, err := pg.LockProjectAuthorization(ctx, tx.tx, principal.UserID, projectID)
	return access, distinguishDeletedProject(ctx, tx.tx, projectID, err)
}

func (s *reader) ProjectAccess(ctx context.Context, principal model.Principal, projectID string) (model.ProjectAccess, error) {
	access, err := pg.ReadProjectAccess(ctx, s.tx, principal.UserID, projectID)
	return access, distinguishDeletedProject(ctx, s.tx, projectID, err)
}

func distinguishDeletedProject(ctx context.Context, tx pgx.Tx, projectID string, err error) error {
	if !errors.Is(err, model.ErrNotFound) {
		return err
	}
	var deleted bool
	if queryErr := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1 AND deleted_at IS NOT NULL)`, projectID).Scan(&deleted); queryErr != nil {
		return pg.QueryError("check project lifecycle", queryErr)
	}
	if deleted {
		return store.ErrProjectDeleted
	}
	return err
}

func (tx *writer) ProjectAccess(ctx context.Context, principal model.Principal) (model.ProjectAccess, error) {
	return pg.ReadProjectAccess(ctx, tx.tx, principal.UserID, tx.projectID)
}

func (s *reader) AccessibleProjects(ctx context.Context, principal model.Principal, page store.Page) (store.ProjectPage, error) {
	return s.ScopedProjects(ctx, principal, store.ProjectScope{Kind: store.ProjectScopeAll}, page)
}

func (s *reader) ScopedProjects(ctx context.Context, principal model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
	condition := ""
	var arguments []any
	switch scope.Kind {
	case store.ProjectScopeAll:
		if scope.TeamID != "" {
			return store.ProjectPage{}, pg.QueryError("list projects", fmt.Errorf("invalid project scope"))
		}
	case store.ProjectScopeTeam:
		if scope.TeamID == "" {
			return store.ProjectPage{}, pg.QueryError("list projects", fmt.Errorf("invalid project scope"))
		}
		var member int
		err := s.tx.QueryRow(ctx, `SELECT 1 FROM teams t JOIN team_members m ON m.team_id=t.id
            WHERE t.id=$1 AND m.user_id=$2`, scope.TeamID, principal.UserID).Scan(&member)
		if err != nil {
			return store.ProjectPage{}, pg.QueryError("read team membership", err)
		}
		condition = ` AND o.team_id=$5::uuid`
		arguments = append(arguments, scope.TeamID)
	case store.ProjectScopeShared:
		if scope.TeamID != "" {
			return store.ProjectPage{}, pg.QueryError("list projects", fmt.Errorf("invalid project scope"))
		}
		condition = ` AND EXISTS (SELECT 1 FROM project_grants g WHERE g.project_id=p.id AND g.user_id=$1)
            AND NOT EXISTS (SELECT 1 FROM team_members m WHERE m.team_id=o.team_id AND m.user_id=$1)`
	default:
		return store.ProjectPage{}, pg.QueryError("list projects", fmt.Errorf("invalid project scope"))
	}
	afterTime, afterID := pg.PageValues(page)
	arguments = append([]any{principal.UserID, afterTime, afterID, page.Limit + 1}, arguments...)
	rows, err := s.tx.Query(ctx, `SELECT `+pg.ProjectProjection+` FROM `+pg.ProjectRelation+`
        WHERE p.deleted_at IS NULL AND EXISTS (SELECT 1 FROM (`+pg.ProjectAccessRelation+`) a WHERE a.project_id=p.id AND a.user_id=$1)
        AND ($2::timestamptz IS NULL OR (p.created_at,p.id)>($2,$3::uuid))`+condition+`
		ORDER BY p.created_at,p.id LIMIT $4`, arguments...)
	if err != nil {
		return store.ProjectPage{}, pg.QueryError("list accessible projects", err)
	}
	defer rows.Close()
	items := []model.Project{}
	for rows.Next() {
		project, err := pg.ScanProject(rows)
		if err != nil {
			return store.ProjectPage{}, pg.QueryError("list accessible projects", err)
		}
		items = append(items, project)
	}
	if err := rows.Err(); err != nil {
		return store.ProjectPage{}, pg.QueryError("list accessible projects", err)
	}
	more := len(items) > page.Limit
	if len(items) > page.Limit {
		items = items[:page.Limit]
	}
	return store.ProjectPage{Items: items, HasMore: more}, nil
}
