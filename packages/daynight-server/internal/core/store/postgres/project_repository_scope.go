package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
	"github.com/jackc/pgx/v5"
)

type repositoryReadScope struct {
	tx pgx.Tx
	id string
}

func (s repositoryReadScope) ProjectRepositoryDAO() store.ProjectRepositoryReadDAO {
	return project.NewRepositoryDAO(s.tx, s.id)
}
func (s repositoryReadScope) GitHubAppDAO() store.GitHubProjectAppReadDAO {
	return github.NewProjectAppReader(s.tx, s.id)
}

type repositoryWriteScope struct {
	tx pgx.Tx
	id string
}

func (s repositoryWriteScope) ProjectRepositoryDAO() store.ProjectRepositoryWriteDAO {
	return project.NewRepositoryDAO(s.tx, s.id)
}
func (s repositoryWriteScope) GitHubAppDAO() store.GitHubProjectAppReadDAO {
	return github.NewProjectAppReader(s.tx, s.id)
}
func (s repositoryWriteScope) GitHubSwitchDAO() store.GitHubRepositorySwitchDAO {
	return github.NewRepositorySwitch(s.tx, s.id)
}
func (s repositoryWriteScope) WorkerSelectionsDAO() store.WorkerProjectSelectionDAO {
	return worker.NewWriter(s.tx)
}

func (s *Store) ReadProjectRepository(ctx context.Context, id string, work func(store.ProjectRepositoryReadScope) error) error {
	return readSnapshot(ctx, s.Pool, func(tx pgx.Tx) error { return work(repositoryReadScope{tx, id}) }, true)
}
func (s *Store) WriteProjectRepository(ctx context.Context, id, actor string, work func(store.ProjectRepositoryWriteScope) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin repository change", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var locked, team string
		if e := tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&locked); e != nil {
			return pg.QueryError("lock repository Project", e)
		}
		if e := tx.QueryRow(ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1 FOR UPDATE`, id).Scan(&team); e != nil {
			return pg.QueryError("lock repository ownership", e)
		}
		if e := tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 FOR UPDATE`, team).Scan(&locked); e != nil {
			return pg.QueryError("lock repository owner Team", e)
		}
		if _, e := pg.LockProjectAuthorization(ctx, tx, actor, id); e != nil {
			return e
		}
		return work(repositoryWriteScope{tx, id})
	})
	return teamCompletion("project repository change", err)
}
