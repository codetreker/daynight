package task

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

func (s *Reader) TaskCacheEpoch(ctx context.Context, projectID string) (string, error) {
	var epoch string
	if err := s.tx.QueryRow(ctx, "SELECT task_cache_epoch::text FROM projects WHERE id = $1", projectID).Scan(&epoch); err != nil {
		return "", pg.QueryError("read task cache epoch", err)
	}
	return epoch, nil
}

func (s *Reader) TaskSyncTasks(ctx context.Context, projectID string, lower *time.Time, previewCharacters int) ([]model.TaskViewRecord, error) {
	if lower != nil {
		// PostgreSQL stores microseconds; rounding upward preserves the exact >=
		// selection when pgx would otherwise truncate a nanosecond lower bound.
		// https://github.com/jackc/pgx/blob/5e583fa7aabfa88b796292f849fc9d7d75ac159d/pgtype/timestamptz.go#L173
		boundary := lower.Truncate(time.Microsecond)
		if boundary.Before(*lower) {
			boundary = boundary.Add(time.Microsecond)
		}
		lower = &boundary
	}
	rows, err := s.tx.Query(ctx, `SELECT t.id::text, t.type, t.parent_id::text, left(t.title, $2), char_length(t.title) > $2,
		t.status, t.version, t.created_at, t.updated_at, t.started_at, t.completed_at, t.cancelled_at, t.allow_agents, t.required_platform, t.assigned_to::text, `+pg.TaskDependsOn+`, `+pg.TaskExternalDependsOn+`
		FROM tasks t WHERE t.project_id = $1 AND t.deleted_at IS NULL AND ($3::timestamptz IS NULL OR t.updated_at >= $3)
		ORDER BY t.created_at, t.id`, projectID, previewCharacters, lower)
	if err != nil {
		return nil, pg.QueryError("read task sync", err)
	}
	defer rows.Close()
	tasks := make([]model.TaskViewRecord, 0)
	for rows.Next() {
		var task model.TaskViewRecord
		if err := rows.Scan(&task.ID, &task.Type, &task.ParentID, &task.TitlePreview, &task.TitleTruncated, &task.Status, &task.Version,
			&task.CreatedAt, &task.UpdatedAt, &task.StartedAt, &task.CompletedAt, &task.CancelledAt, &task.AllowAgents, &task.RequiredPlatform, &task.AssignedTo, &task.DependsOn, &task.ExternalDependsOn); err != nil {
			return nil, pg.QueryError("read task sync", err)
		}
		task.CreatedAt = task.CreatedAt.UTC()
		task.UpdatedAt = task.UpdatedAt.UTC()
		task.StartedAt = pg.UTCTime(task.StartedAt)
		task.CompletedAt = pg.UTCTime(task.CompletedAt)
		task.CancelledAt = pg.UTCTime(task.CancelledAt)
		tasks = append(tasks, task)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read task sync", err)
	}
	rows.Close()
	ids := make([]string, len(tasks))
	for index := range tasks {
		ids[index] = tasks[index].ID
	}
	properties, err := pg.LoadTaskProperties(ctx, s.tx, ids)
	if err != nil {
		return nil, err
	}
	for index := range tasks {
		tasks[index].Properties = properties[tasks[index].ID]
	}
	return tasks, nil
}
