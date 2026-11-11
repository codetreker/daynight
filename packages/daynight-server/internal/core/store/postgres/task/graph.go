package task

import (
	"context"

	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const taskGraphSelection = `WITH RECURSIVE chain(id) AS (
 SELECT id FROM task_resource_rows WHERE project_id = $1 AND id = $2 AND type = 'task' AND (NOT $6::boolean OR effective_deleted_at IS NULL)
 UNION
 SELECT neighbor.id FROM chain member
 CROSS JOIN LATERAL (
  SELECT depends_on_task_id AS id FROM task_dependencies
   WHERE project_id = $1 AND task_id = member.id AND NOT external AND $3::boolean
  UNION
  SELECT task_id AS id FROM task_dependencies
   WHERE project_id = $1 AND depends_on_task_id = member.id AND NOT external AND $4::boolean
 ) neighbor
 JOIN task_resource_rows live ON live.project_id = $1 AND live.id = neighbor.id AND live.type = 'task' AND (NOT $6::boolean OR live.effective_deleted_at IS NULL)
), selected(id) AS (
 SELECT id FROM chain
 UNION
 SELECT dependency.depends_on_task_id FROM task_dependencies dependency
 JOIN chain member ON member.id = dependency.task_id
 JOIN task_resource_rows live ON live.project_id = $1 AND live.id = dependency.depends_on_task_id AND live.type = 'task' AND (NOT $6::boolean OR live.effective_deleted_at IS NULL)
 WHERE dependency.project_id = $1 AND dependency.external AND $5::boolean
) `

func (s *Reader) TaskGraphTasks(ctx context.Context, projectID, taskID string, selection store.TaskGraphSelection, previewCharacters int) ([]model.GraphTask, error) {
	rows, err := s.tx.Query(ctx, taskGraphSelection+`SELECT t.id::text, t.type, t.parent_id::text, t.version, left(t.title, $7), char_length(t.title) > $7,
		t.status, t.created_at, t.updated_at, t.started_at, t.completed_at, t.cancelled_at, t.allow_agents, t.required_platform, t.assigned_to::text, `+pg.TaskDependsOn+`, `+pg.TaskExternalDependsOn+`, `+pg.TaskBlockedBy+`, `+pg.TaskReady+`
		FROM task_resource_rows t JOIN selected ON selected.id = t.id WHERE t.project_id = $1 AND t.type = 'task' AND (NOT $6::boolean OR t.effective_deleted_at IS NULL) ORDER BY t.created_at, t.id`, projectID, taskID, selection.OrdinaryPrerequisites, selection.OrdinaryDependents, selection.DirectExternal, selection.LiveOnly, previewCharacters)
	if err != nil {
		return nil, pg.QueryError("read task graph", err)
	}
	defer rows.Close()
	tasks := make([]model.GraphTask, 0)
	for rows.Next() {
		var task model.GraphTask
		if err := rows.Scan(&task.ID, &task.Type, &task.ParentID, &task.Version, &task.TitlePreview, &task.TitleTruncated, &task.Status,
			&task.CreatedAt, &task.UpdatedAt, &task.StartedAt, &task.CompletedAt, &task.CancelledAt, &task.AllowAgents, &task.RequiredPlatform, &task.AssignedTo, &task.DependsOn, &task.ExternalDependsOn, &task.BlockedBy, &task.Ready); err != nil {
			return nil, pg.QueryError("read task graph", err)
		}

		task.CreatedAt = task.CreatedAt.UTC()
		task.UpdatedAt = task.UpdatedAt.UTC()
		task.StartedAt = pg.UTCTime(task.StartedAt)
		task.CompletedAt = pg.UTCTime(task.CompletedAt)
		task.CancelledAt = pg.UTCTime(task.CancelledAt)
		tasks = append(tasks, task)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read task graph", err)
	}
	return tasks, nil
}
