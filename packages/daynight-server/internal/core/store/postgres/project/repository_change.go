package project

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type repositoryDAO struct {
	tx pgx.Tx
	id string
}

// NewRepositoryDAO binds repository facts and writes to the caller's scope.
func NewRepositoryDAO(tx pgx.Tx, projectID string) store.ProjectRepositoryWriteDAO {
	return &repositoryDAO{tx: tx, id: projectID}
}

func (d *repositoryDAO) RepositoryFacts(ctx context.Context, principal model.Principal) (store.ProjectRepositoryFacts, error) {
	var f store.ProjectRepositoryFacts
	var err error
	f.Access, err = pg.ReadProjectAccess(ctx, d.tx, principal.UserID, d.id)
	if err != nil {
		return f, err
	}
	f.Project, err = readProject(ctx, d.tx, d.id)
	if err != nil {
		return f, err
	}
	err = d.tx.QueryRow(ctx, `SELECT repository_identity,repository_version FROM projects WHERE id=$1 AND deleted_at IS NULL`, d.id).Scan(&f.Identity, &f.Version)
	if err != nil {
		return store.ProjectRepositoryFacts{}, pg.QueryError("read Project repository facts", err)
	}
	return f, nil
}

func (d *repositoryDAO) RepositoryOccupiedByOther(ctx context.Context, teamID, identity string) (bool, error) {
	var occupied bool
	err := d.tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM project_ownership o JOIN projects p ON p.id=o.project_id
 WHERE o.team_id=$1 AND p.deleted_at IS NULL AND p.repository_identity=$2 AND p.id<>$3)`, teamID, identity, d.id).Scan(&occupied)
	return occupied, pg.AuthQueryError("read other Team repository occupancy", err)
}

func (d *repositoryDAO) SaveRepository(ctx context.Context, address, identity string, expected int64) (int64, bool, error) {
	var version int64
	err := d.tx.QueryRow(ctx, `UPDATE projects SET repo_url=$2,repository_identity=$3,repository_version=repository_version+1,updated_at=statement_timestamp()
 WHERE id=$1 AND deleted_at IS NULL AND repository_version=$4 AND repository_version<9223372036854775807 AND repo_url<>$2
 RETURNING repository_version`, d.id, address, identity, expected).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, pg.QueryError("save Project repository", err)
	}
	return version, true, nil
}
