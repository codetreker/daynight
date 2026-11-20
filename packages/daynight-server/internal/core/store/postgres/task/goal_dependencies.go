package task

import (
	"context"
	"errors"
	"math"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type goalDependencyWriter struct {
	tx        pgx.Tx
	projectID string
}

func NewGoalDependencyWriter(tx pgx.Tx, projectID string) store.GoalDependencyDAO {
	return &goalDependencyWriter{tx: tx, projectID: projectID}
}

func (d *goalDependencyWriter) LockTeam(ctx context.Context) error {
	return pg.LockGoalDependencyTeam(ctx, d.tx, d.projectID)
}

func (d *goalDependencyWriter) UnsatisfiedPrerequisites(ctx context.Context, goalID string) (bool, error) {
	var found bool
	err := d.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_dependencies d
 WHERE d.project_id=$1 AND d.task_id=$2 AND d.dependency_type='goal'
 AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.id=d.depends_on_task_id AND t.type='goal' AND t.deleted_at IS NULL AND t.status='done'))`, d.projectID, goalID).Scan(&found)
	if err != nil {
		return false, pg.QueryError("read unsatisfied goal prerequisites", err)
	}
	return found, nil
}

func (d *goalDependencyWriter) DoneSuccessors(ctx context.Context, goalID string) (bool, error) {
	var found bool
	err := d.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks t ON t.id=d.task_id AND t.project_id=d.project_id
 WHERE d.depends_on_task_id=$1 AND d.dependency_type='goal' AND t.type='goal' AND t.deleted_at IS NULL AND t.status='done')`, goalID).Scan(&found)
	if err != nil {
		return false, pg.QueryError("read completed goal successors", err)
	}
	return found, nil
}

func (d *goalDependencyWriter) HasIncoming(ctx context.Context, goalID string) (bool, error) {
	var found bool
	err := d.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_dependencies d
 JOIN task_resource_rows t ON t.project_id=d.project_id AND t.id=d.task_id
 WHERE d.depends_on_task_id=$1 AND d.dependency_type='goal' AND t.type='goal' AND t.effective_deleted_at IS NULL)`, goalID).Scan(&found)
	if err != nil {
		return false, pg.QueryError("read incoming goal dependencies", err)
	}
	return found, nil
}

func (d *goalDependencyWriter) RemoveOutgoing(ctx context.Context, goalID string) error {
	var exists bool
	err := d.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_dependencies WHERE project_id=$1 AND task_id=$2 AND dependency_type='goal')`, d.projectID, goalID).Scan(&exists)
	if err != nil {
		return pg.QueryError("read outgoing goal dependencies", err)
	}
	if !exists {
		return nil
	}
	var revision int64
	err = d.tx.QueryRow(ctx, `SELECT revision FROM goal_dependency_revisions WHERE goal_id=$1 FOR UPDATE`, goalID).Scan(&revision)
	newRevision := errors.Is(err, pgx.ErrNoRows)
	if err != nil && !newRevision {
		return pg.QueryError("read goal dependency revision", err)
	}
	if !newRevision && revision == math.MaxInt64 {
		return &model.Fault{Code: "version_exhausted", Message: "Goal dependency revision is exhausted."}
	}
	if !newRevision && revision < 1 {
		return pg.QueryError("read goal dependency revision", errors.New("invalid goal dependency revision"))
	}
	if _, err := d.tx.Exec(ctx, `DELETE FROM task_dependencies WHERE project_id=$1 AND task_id=$2 AND dependency_type='goal'`, d.projectID, goalID); err != nil {
		return pg.QueryError("remove outgoing goal dependencies", err)
	}
	if newRevision {
		_, err = d.tx.Exec(ctx, `INSERT INTO goal_dependency_revisions(goal_id,revision) VALUES($1,2)`, goalID)
		if err != nil {
			return pg.QueryError("create goal dependency revision", err)
		}
		return nil
	}
	_, err = d.tx.Exec(ctx, `UPDATE goal_dependency_revisions SET revision=$2 WHERE goal_id=$1`, goalID, revision+1)
	if err != nil {
		return pg.QueryError("advance goal dependency revision", err)
	}
	return nil
}
