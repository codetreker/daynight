package postgres

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/eligibility"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/team"
	"github.com/jackc/pgx/v5"
)

type appProjectTransferScope struct {
	tx pgx.Tx
	id string
}

func (s appProjectTransferScope) ProjectDAO() store.ProjectWriteDAO {
	return project.NewWriter(s.tx, s.id)
}
func (s appProjectTransferScope) GitHubDAO() store.GitHubProjectRetirementDAO {
	return github.NewProjectRetirement(s.tx, s.id)
}
func (s appProjectTransferScope) EligibilityDAO() store.WebhookEligibilityDAO {
	return eligibility.New(s.tx)
}

type appProjectDeletionScope struct{ appProjectTransferScope }

func (s appProjectDeletionScope) ProjectDAO() store.ProjectDeletionDAO {
	return &appProjectDeletion{projectDeletion{tx: s.tx, projectID: s.id}}
}
func (s appProjectDeletionScope) SessionDAO() store.ProjectSessionRetirementDAO {
	return session.NewProjectRetirementDAO(s.tx, s.id)
}

// appProjectDeletion supplies the raw marker; the original deletion DAO retains
// its fixed-App invalidation callback until its production caller is replaced.
type appProjectDeletion struct{ projectDeletion }

func (d *appProjectDeletion) MarkDeleted(ctx context.Context) (bool, error) {
	tag, err := d.tx.Exec(ctx, `UPDATE projects SET deleted_at=statement_timestamp(),updated_at=statement_timestamp(),task_cache_epoch=gen_random_uuid() WHERE id=$1 AND deleted_at IS NULL`, d.projectID)
	if err != nil {
		return false, pg.QueryError("mark App-aware project deleted", err)
	}
	if tag.RowsAffected() == 1 {
		if err := d.clearProjectWebhook(ctx); err != nil {
			return false, err
		}
	}
	return tag.RowsAffected() == 1, nil
}

func (s *Store) WriteGitHubProjectTransfer(ctx context.Context, id string, op func(store.GitHubProjectTransferScope) error) (store.Completion, error) {
	return s.writeAppProjectLifecycle(ctx, id, false, func(tx pgx.Tx) error { return op(appProjectTransferScope{tx, id}) })
}
func (s *Store) WriteGitHubProjectDeletion(ctx context.Context, id string, op func(store.GitHubProjectDeletionScope) error) (store.Completion, error) {
	return s.writeAppProjectLifecycle(ctx, id, true, func(tx pgx.Tx) error { return op(appProjectDeletionScope{appProjectTransferScope{tx, id}}) })
}
func (s *Store) writeAppProjectLifecycle(ctx context.Context, id string, deleting bool, op func(pgx.Tx) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin App project lifecycle", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var locked string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&locked); err != nil {
			return pg.QueryError("lock App lifecycle Project", err)
		}
		if deleting {
			rows, err := tx.Query(ctx, `SELECT id FROM tasks WHERE project_id=$1 ORDER BY id FOR UPDATE`, id)
			if err != nil {
				return pg.QueryError("lock App lifecycle Tasks", err)
			}
			for rows.Next() {
				var task string
				if err = rows.Scan(&task); err != nil {
					break
				}
			}
			if err == nil {
				err = rows.Err()
			}
			rows.Close()
			if err != nil {
				return pg.QueryError("lock App lifecycle Tasks", err)
			}
			var owner string
			if err := tx.QueryRow(ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1 FOR UPDATE`, id).Scan(&owner); err != nil {
				return fmt.Errorf("lock deletion ownership: %w", err)
			}
			if err := tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 FOR SHARE`, owner).Scan(&locked); err != nil {
				return fmt.Errorf("lock deletion owner Team: %w", err)
			}
		}
		return op(tx)
	})
	return teamCompletion("App project lifecycle", err)
}

type appTeamDeletionScope struct {
	tx pgx.Tx
	id string
}

func (s appTeamDeletionScope) TeamDAO() store.TeamWriteDAO { return team.NewWriter(s.tx, s.id) }
func (s appTeamDeletionScope) GitHubDAO() store.GitHubTeamRetirementDAO {
	return github.NewTeamRetirement(s.tx, s.id)
}
func (s appTeamDeletionScope) EligibilityDAO() store.WebhookEligibilityDAO {
	return eligibility.New(s.tx)
}
func (s *Store) WriteGitHubTeamDeletion(ctx context.Context, id string, op func(store.GitHubTeamDeletionScope) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin App Team deletion", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var locked string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 FOR UPDATE`, id).Scan(&locked); err != nil {
			return pg.QueryError("lock App deletion Team", err)
		}
		return op(appTeamDeletionScope{tx, id})
	})
	return teamCompletion("App Team deletion", err)
}
