package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/eligibility"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/tag"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"

	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/jackc/pgx/v5"
)

type ProjectTx struct {
	tx        pgx.Tx
	projectID string
}

func (s *Store) WriteProject(ctx context.Context, projectID string, operation func(ProjectWriteScope) error) (Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Completion{Outcome: TransactionNotCommitted}, pg.QueryError("begin project write", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var id string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, projectID).Scan(&id); err != nil {
			return pg.QueryError("lock project", err)
		}
		return operation(&ProjectTx{tx: tx, projectID: projectID})
	})
	return teamCompletion("project write", err)
}

func (tx *ProjectTx) ProjectDAO() ProjectWriteDAO           { return project.NewWriter(tx.tx, tx.projectID) }
func (tx *ProjectTx) EligibilityDAO() WebhookEligibilityDAO { return eligibility.New(tx.tx) }
func (tx *ProjectTx) CaptureDAO() WebhookCaptureDAO {
	return webhook.NewProjectCapture(tx.tx, tx.projectID)
}
func (tx *ProjectTx) TagDAO() TagWriteDAO         { return tag.NewWriter(tx.tx, tx.projectID) }
func (tx *ProjectTx) TaskTagDAO() TaskTagWriteDAO { return task.NewTagWriter(tx.tx, tx.projectID) }
func (tx *ProjectTx) TaskDAO() TaskWriteDAO       { return task.NewWriter(tx.tx, tx.projectID) }
func (tx *ProjectTx) GitHubDAO() GitHubWriteDAO   { return github.NewWriter(tx.tx, tx.projectID) }
func (tx *ProjectTx) SessionDAO() ProjectSessionDAO {
	return session.NewProjectDAO(tx.tx, tx.projectID)
}
