package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5"
)

// projectAccessRelation returns one effective role per project/user and retains
// raw user IDs so profile consumers can detect missing users.
const projectAccessRelation = `SELECT project_id,user_id,role FROM project_members`

// ReadProjectAccess evaluates access in the caller's transaction without acquiring row locks.
func ReadProjectAccess(ctx context.Context, tx pgx.Tx, userID, projectID string) (core.ProjectAccess, error) {
	var access core.ProjectAccess
	var grant core.ProjectGrant
	err := tx.QueryRow(ctx, `SELECT a.project_id::text,a.user_id::text,a.role,
        g.project_id::text,g.user_id::text,g.role,g.version,g.created_at,g.updated_at FROM (`+projectAccessRelation+`) a
        JOIN users u ON u.id=a.user_id JOIN projects p ON p.id=a.project_id
        JOIN project_members g ON g.project_id=a.project_id AND g.user_id=a.user_id
        WHERE a.project_id=$1 AND a.user_id=$2`, projectID, userID).Scan(&access.ProjectID, &access.UserID, &access.Role,
		&grant.ProjectID, &grant.UserID, &grant.Role, &grant.Version, &grant.CreatedAt, &grant.UpdatedAt)
	if err != nil {
		return core.ProjectAccess{}, authQueryError("read project access", err)
	}
	access.DirectGrant = &grant
	return access, nil
}

func (s *Snapshot) ProjectAccess(ctx context.Context, principal core.Principal, projectID string) (core.ProjectAccess, error) {
	return ReadProjectAccess(ctx, s.tx, principal.UserID, projectID)
}

func (tx *ProjectTx) ProjectAccess(ctx context.Context, principal core.Principal) (core.ProjectAccess, error) {
	return ReadProjectAccess(ctx, tx.tx, principal.UserID, tx.projectID)
}

func (s *Snapshot) AccessibleProjects(ctx context.Context, principal core.Principal, page Page) (ProjectPage, error) {
	afterTime, afterID := pageValues(page)
	rows, err := s.tx.Query(ctx, `SELECT `+projectProjection+` FROM projects p
        WHERE EXISTS (SELECT 1 FROM (`+projectAccessRelation+`) a WHERE a.project_id=p.id AND a.user_id=$1)
        AND ($2::timestamptz IS NULL OR (p.created_at,p.id)>($2,$3::uuid))
        ORDER BY p.created_at,p.id LIMIT $4`, principal.UserID, afterTime, afterID, page.Limit+1)
	if err != nil {
		return ProjectPage{}, queryError("list accessible projects", err)
	}
	defer rows.Close()
	items := []core.Project{}
	for rows.Next() {
		project, err := scanProject(rows)
		if err != nil {
			return ProjectPage{}, queryError("list accessible projects", err)
		}
		items = append(items, project)
	}
	if err := rows.Err(); err != nil {
		return ProjectPage{}, queryError("list accessible projects", err)
	}
	more := len(items) > page.Limit
	if more {
		items = items[:page.Limit]
	}
	return ProjectPage{Items: items, HasMore: more}, nil
}
