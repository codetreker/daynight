package project

import (
	"context"

	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

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
