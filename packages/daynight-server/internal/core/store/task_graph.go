package store

import (
	"context"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

type TaskGraphSize struct {
	NodeCount int64
	EdgeCount int64
}

func (s *Snapshot) TaskGraphSize(ctx context.Context, projectID string) (TaskGraphSize, error) {
	var size TaskGraphSize
	err := s.tx.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM tasks WHERE project_id = $1 AND deleted_at IS NULL),
		(SELECT count(*) FROM task_dependencies d JOIN tasks t ON t.project_id = d.project_id AND t.id = d.task_id
			WHERE d.project_id = $1 AND t.deleted_at IS NULL)`, projectID).
		Scan(&size.NodeCount, &size.EdgeCount)
	if err != nil {
		return TaskGraphSize{}, queryError("count task graph", err)
	}
	return size, nil
}

const taskGraphSelection = `WITH RECURSIVE chain(id) AS (
 SELECT id FROM tasks WHERE project_id = $1 AND id = $2 AND deleted_at IS NULL
 UNION
 SELECT neighbor.id FROM chain member
 CROSS JOIN LATERAL (
  SELECT depends_on_task_id AS id FROM task_dependencies
   WHERE project_id = $1 AND task_id = member.id AND NOT external
  UNION
  SELECT task_id AS id FROM task_dependencies
   WHERE project_id = $1 AND depends_on_task_id = member.id AND NOT external
 ) neighbor
 JOIN tasks live ON live.project_id = $1 AND live.id = neighbor.id AND live.deleted_at IS NULL
), selected(id) AS (
 SELECT id FROM chain
 UNION
 SELECT dependency.depends_on_task_id FROM task_dependencies dependency
 JOIN chain member ON member.id = dependency.task_id
 JOIN tasks live ON live.project_id = $1 AND live.id = dependency.depends_on_task_id AND live.deleted_at IS NULL
 WHERE dependency.project_id = $1 AND dependency.external
) `

func (s *Snapshot) TaskGraphRoot(ctx context.Context, projectID, taskID string) error {
	var deletedAt *time.Time
	if err := s.tx.QueryRow(ctx, `SELECT deleted_at FROM tasks WHERE project_id = $1 AND id = $2`, projectID, taskID).Scan(&deletedAt); err != nil {
		return queryError("read task graph root", err)
	}
	if deletedAt != nil {
		return core.ErrTaskDeleted
	}
	return nil
}

func (s *Snapshot) TaskGraphProjectionSize(ctx context.Context, projectID, taskID string) (TaskGraphSize, error) {
	var size TaskGraphSize
	err := s.tx.QueryRow(ctx, taskGraphSelection+`SELECT
  (SELECT count(*) FROM selected),
  (SELECT count(*) FROM task_dependencies dependency JOIN selected source ON source.id = dependency.task_id
   WHERE dependency.project_id = $1)`, projectID, taskID).Scan(&size.NodeCount, &size.EdgeCount)
	if err != nil {
		return TaskGraphSize{}, queryError("count task graph projection", err)
	}
	return size, nil
}

func (s *Snapshot) TaskGraphTasks(ctx context.Context, projectID, taskID string, previewCharacters int) ([]core.GraphTask, error) {
	rows, err := s.tx.Query(ctx, taskGraphSelection+`SELECT t.id::text, left(t.title, $3), char_length(t.title) > $3,
		t.status, t.created_at, t.updated_at, t.started_at, t.completed_at, t.allow_agents, t.required_platform, t.worker_needs_attention, `+taskDependsOn+`, `+taskExternalDependsOn+`, `+taskBlockedBy+`, `+taskReady+`
		FROM tasks t JOIN selected ON selected.id = t.id WHERE t.project_id = $1 AND t.deleted_at IS NULL ORDER BY t.created_at, t.id`, projectID, taskID, previewCharacters)
	if err != nil {
		return nil, queryError("read task graph", err)
	}
	defer rows.Close()
	tasks := make([]core.GraphTask, 0)
	for rows.Next() {
		var task core.GraphTask
		if err := rows.Scan(&task.ID, &task.TitlePreview, &task.TitleTruncated, &task.Status,
			&task.CreatedAt, &task.UpdatedAt, &task.StartedAt, &task.CompletedAt, &task.AllowAgents, &task.RequiredPlatform, &task.WorkerNeedsAttention, &task.DependsOn, &task.ExternalDependsOn, &task.BlockedBy, &task.Ready); err != nil {
			return nil, queryError("read task graph", err)
		}
		if !task.Status.Valid() {
			return nil, queryError("read task graph", fmt.Errorf("stored task status is invalid"))
		}
		task.CreatedAt = task.CreatedAt.UTC()
		task.UpdatedAt = task.UpdatedAt.UTC()
		task.StartedAt = utcTime(task.StartedAt)
		task.CompletedAt = utcTime(task.CompletedAt)
		tasks = append(tasks, task)
	}
	if err := rows.Err(); err != nil {
		return nil, queryError("read task graph", err)
	}
	return tasks, nil
}

func (s *Snapshot) ObservedAt(ctx context.Context) (time.Time, error) {
	var observed time.Time
	if err := s.tx.QueryRow(ctx, "SELECT statement_timestamp()").Scan(&observed); err != nil {
		return time.Time{}, queryError("read snapshot clock", err)
	}
	return observed.UTC(), nil
}
