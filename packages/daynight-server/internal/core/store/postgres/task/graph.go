package task

import (
	"context"
	"fmt"

	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func (s *Reader) TaskGraphSize(ctx context.Context, projectID string) (store.TaskGraphSize, error) {
	var size store.TaskGraphSize
	err := s.tx.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM tasks WHERE project_id = $1 AND deleted_at IS NULL),
		(SELECT count(*) FROM task_dependencies d JOIN tasks t ON t.project_id = d.project_id AND t.id = d.task_id
			WHERE d.project_id = $1 AND t.deleted_at IS NULL)`, projectID).
		Scan(&size.NodeCount, &size.EdgeCount)
	if err != nil {
		return store.TaskGraphSize{}, pg.QueryError("count task graph", err)
	}
	return size, nil
}

const taskGraphSelection = `WITH RECURSIVE chain(id) AS (
 SELECT id FROM tasks WHERE project_id = $1 AND id = $2 AND (NOT $6::boolean OR deleted_at IS NULL)
 UNION
 SELECT neighbor.id FROM chain member
 CROSS JOIN LATERAL (
  SELECT depends_on_task_id AS id FROM task_dependencies
   WHERE project_id = $1 AND task_id = member.id AND NOT external AND $3::boolean
  UNION
  SELECT task_id AS id FROM task_dependencies
   WHERE project_id = $1 AND depends_on_task_id = member.id AND NOT external AND $4::boolean
 ) neighbor
 JOIN tasks live ON live.project_id = $1 AND live.id = neighbor.id AND (NOT $6::boolean OR live.deleted_at IS NULL)
), selected(id) AS (
 SELECT id FROM chain
 UNION
 SELECT dependency.depends_on_task_id FROM task_dependencies dependency
 JOIN chain member ON member.id = dependency.task_id
 JOIN tasks live ON live.project_id = $1 AND live.id = dependency.depends_on_task_id AND (NOT $6::boolean OR live.deleted_at IS NULL)
 WHERE dependency.project_id = $1 AND dependency.external AND $5::boolean
) `

func (s *Reader) TaskGraphProjectionSize(ctx context.Context, projectID, taskID string, selection store.TaskGraphSelection) (store.TaskGraphSize, error) {
	var size store.TaskGraphSize
	err := s.tx.QueryRow(ctx, taskGraphSelection+`SELECT
  (SELECT count(*) FROM selected),
  (SELECT count(*) FROM task_dependencies dependency JOIN selected source ON source.id = dependency.task_id
   WHERE dependency.project_id = $1 AND ($7::boolean OR EXISTS (SELECT 1 FROM chain WHERE chain.id = source.id)))`, projectID, taskID, selection.OrdinaryPrerequisites, selection.OrdinaryDependents, selection.DirectExternal, selection.LiveOnly, selection.IncludeExternalEdges).Scan(&size.NodeCount, &size.EdgeCount)
	if err != nil {
		return store.TaskGraphSize{}, pg.QueryError("count task graph projection", err)
	}
	return size, nil
}

func (s *Reader) TaskGraphTasks(ctx context.Context, projectID, taskID string, selection store.TaskGraphSelection, previewCharacters int) ([]model.GraphTask, error) {
	rows, err := s.tx.Query(ctx, taskGraphSelection+`SELECT t.id::text, left(t.title, $7), char_length(t.title) > $7,
		t.status, t.created_at, t.updated_at, t.started_at, t.completed_at, t.cancelled_at, t.allow_agents, t.required_platform, t.assigned_to::text, `+pg.TaskDependsOn+`, `+pg.TaskExternalDependsOn+`, `+pg.TaskBlockedBy+`, `+pg.TaskReady+`
		FROM tasks t JOIN selected ON selected.id = t.id WHERE t.project_id = $1 AND (NOT $6::boolean OR t.deleted_at IS NULL) ORDER BY t.created_at, t.id`, projectID, taskID, selection.OrdinaryPrerequisites, selection.OrdinaryDependents, selection.DirectExternal, selection.LiveOnly, previewCharacters)
	if err != nil {
		return nil, pg.QueryError("read task graph", err)
	}
	defer rows.Close()
	tasks := make([]model.GraphTask, 0)
	for rows.Next() {
		var task model.GraphTask
		if err := rows.Scan(&task.ID, &task.TitlePreview, &task.TitleTruncated, &task.Status,
			&task.CreatedAt, &task.UpdatedAt, &task.StartedAt, &task.CompletedAt, &task.CancelledAt, &task.AllowAgents, &task.RequiredPlatform, &task.AssignedTo, &task.DependsOn, &task.ExternalDependsOn, &task.BlockedBy, &task.Ready); err != nil {
			return nil, pg.QueryError("read task graph", err)
		}
		if !task.Status.Valid() {
			return nil, pg.QueryError("read task graph", fmt.Errorf("stored task status is invalid"))
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
