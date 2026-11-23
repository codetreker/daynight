package task

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

// UNION converges by row identity even if stored relationships contain a cycle.
func terminalAncestorGoalPredicate(project, parent string) string {
	return fmt.Sprintf(`EXISTS (WITH RECURSIVE ancestors(id,parent_id,type,status) AS (
		SELECT a.id,a.parent_id,a.type,a.status FROM tasks a WHERE a.project_id=%s AND a.id=%s
		UNION
		SELECT a.id,a.parent_id,a.type,a.status FROM tasks a JOIN ancestors child ON a.id=child.parent_id
		WHERE a.project_id=%s
	) SELECT 1 FROM ancestors WHERE type='goal' AND status IN ('done','cancelled'))`, project, parent, project)
}

func (tx *Writer) HasTerminalAncestorGoal(ctx context.Context, parentID string) (bool, error) {
	var terminal bool
	err := tx.tx.QueryRow(ctx, `SELECT `+terminalAncestorGoalPredicate("$1::uuid", "$2::uuid"), tx.projectID, parentID).Scan(&terminal)
	if err != nil {
		return false, pg.QueryError("read ancestor Goal admission", err)
	}
	return terminal, nil
}

func (tx *Writer) TaskForStart(ctx context.Context, id string) (model.Task, error) {
	rows, err := tx.tx.Query(ctx, `WITH target AS (
		SELECT id,parent_id,type,status FROM task_resource_rows
		WHERE project_id=$1 AND id=$2 AND effective_deleted_at IS NULL
	), affected(id) AS (
		SELECT id FROM target
		UNION SELECT parent.id FROM tasks parent JOIN target child ON parent.id=child.parent_id
		WHERE parent.project_id=$1 AND parent.type='goal' AND parent.status='todo'
		AND child.type='task' AND child.status <> 'in_progress'
	) SELECT t.id::text FROM tasks t JOIN affected a ON a.id=t.id
	WHERE t.project_id=$1 ORDER BY t.id FOR UPDATE OF t`, tx.projectID, id)
	if err != nil {
		return model.Task{}, pg.QueryError("lock task start rows", err)
	}
	if _, err := pgx.CollectRows(rows, pgx.RowTo[string]); err != nil {
		return model.Task{}, pg.QueryError("lock task start rows", err)
	}
	return tx.Task(ctx, id)
}
