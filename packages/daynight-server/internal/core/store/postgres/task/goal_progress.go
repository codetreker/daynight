package task

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

// GoalProgresses groups visible ordinary children once for all selected Goals.
func (s *Reader) GoalProgresses(ctx context.Context, projectID string, goalIDs []string) (map[string]model.GoalProgress, error) {
	values := make(map[string]model.GoalProgress, len(goalIDs))
	for _, id := range goalIDs {
		values[id] = model.GoalProgress{}
	}
	if len(goalIDs) == 0 {
		return values, nil
	}
	rows, err := s.tx.Query(ctx, `SELECT parent_id::text, count(*), count(*) FILTER (WHERE status='done'),
 count(*) FILTER (WHERE status='cancelled'), count(*) FILTER (WHERE status IN ('proposed','todo','in_progress'))
 FROM task_resource_rows WHERE project_id=$1 AND parent_id=ANY($2::uuid[]) AND type='task'
 AND effective_deleted_at IS NULL GROUP BY parent_id`, projectID, goalIDs)
	if err != nil {
		return nil, pg.QueryError("read goal progresses", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var progress model.GoalProgress
		if err := rows.Scan(&id, &progress.Total, &progress.Done, &progress.Cancelled, &progress.Unfinished); err != nil {
			return nil, pg.QueryError("read goal progresses", err)
		}
		values[id] = progress
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read goal progresses", err)
	}
	return values, nil
}

// TaskBodies loads a selected priority page without issuing one query per item.
func (s *Reader) TaskBodies(ctx context.Context, projectID string, ids []string) ([]model.Task, error) {
	if len(ids) == 0 {
		return []model.Task{}, nil
	}
	rows, err := s.tx.Query(ctx, `SELECT `+pg.TaskProjection+` FROM task_resource_rows t
 WHERE t.project_id=$1 AND t.id=ANY($2::uuid[]) AND t.effective_deleted_at IS NULL`, projectID, ids)
	if err != nil {
		return nil, pg.QueryError("read task bodies", err)
	}
	tasks, err := pg.CollectTasks(rows)
	if err != nil {
		return nil, pg.QueryError("read task bodies", err)
	}
	if err := pg.AttachTaskProperties(ctx, s.tx, tasks); err != nil {
		return nil, err
	}
	if err := pg.AttachTaskTags(ctx, s.tx, projectID, tasks); err != nil {
		return nil, err
	}
	return tasks, nil
}
