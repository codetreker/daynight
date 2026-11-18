package project

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func (s *reader) FindVisibleRepositoryForCreation(ctx context.Context, principal model.Principal, teamID, identity string) ([]model.Project, error) {
	rows, err := s.tx.Query(ctx, `SELECT `+pg.ProjectProjection+` FROM `+pg.ProjectRelation+`
		WHERE o.team_id=$1 AND p.deleted_at IS NULL AND p.repository_identity=$2
		AND EXISTS (SELECT 1 FROM (`+pg.ProjectAccessRelation+`) a WHERE a.project_id=p.id AND a.user_id=$3)
		ORDER BY p.created_at,p.id LIMIT 2`, teamID, identity, principal.UserID)
	if err != nil {
		return nil, pg.QueryError("find visible Team repository", err)
	}
	defer rows.Close()
	items := make([]model.Project, 0, 2)
	for rows.Next() {
		project, err := pg.ScanProject(rows)
		if err != nil {
			return nil, pg.QueryError("find visible Team repository", err)
		}
		items = append(items, project)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("find visible Team repository", err)
	}
	return items, nil
}

func repositoryOccupied(ctx context.Context, tx pgx.Tx, teamID, identity string) (bool, error) {
	var occupied bool
	err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM project_ownership o JOIN projects p ON p.id=o.project_id
 WHERE o.team_id=$1 AND p.deleted_at IS NULL AND p.repository_identity=$2)`, teamID, identity).Scan(&occupied)
	return occupied, pg.AuthQueryError("read Team repository occupancy", err)
}

func (tx *creator) RepositoryOccupied(ctx context.Context, teamID, identity string) (bool, error) {
	return repositoryOccupied(ctx, tx.tx, teamID, identity)
}

func (tx *writer) RepositoryOccupied(ctx context.Context, teamID, identity string) (bool, error) {
	return repositoryOccupied(ctx, tx.tx, teamID, identity)
}

func (tx *writer) RepositoryIdentity(ctx context.Context) (*string, error) {
	var identity *string
	err := tx.tx.QueryRow(ctx, `SELECT repository_identity FROM projects WHERE id=$1`, tx.projectID).Scan(&identity)
	return identity, pg.AuthQueryError("read locked Project repository identity", err)
}
