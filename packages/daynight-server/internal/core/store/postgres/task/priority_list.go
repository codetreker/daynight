package task

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

func (s *Reader) TaskListFence(ctx context.Context, projectID string) (store.TaskListFence, error) {
	var fence store.TaskListFence
	err := s.tx.QueryRow(ctx, `SELECT count(*)::text, COALESCE(sum(version::numeric), 0)::text FROM tasks WHERE project_id=$1`, projectID).Scan(&fence.Count, &fence.VersionSum)
	if err != nil {
		return store.TaskListFence{}, pg.QueryError("read task list fence", err)
	}
	return fence, nil
}

const priorityGroup = `(CASE WHEN t.status='in_progress' THEN 0 WHEN ` + pg.TaskReady + ` THEN 1 WHEN t.status='todo' THEN 2 ELSE 3 END)`

func (s *Reader) TaskPriorityList(ctx context.Context, projectID string, q store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
	if q.Limit < 1 || q.Limit > 100 {
		return store.TaskPriorityPage{}, pg.QueryError("list tasks", fmt.Errorf("invalid limit"))
	}
	limit := q.Limit
	var group, afterTime, afterID any
	if q.After != nil {
		group, afterTime, afterID = q.After.Group, q.After.CreatedAt, q.After.ID
	}
	args := []any{projectID, q.Status, q.ExcludeDone, q.Ready, q.AllowAgents, q.CompatiblePlatform, group, afterTime, afterID, limit + 1}
	assignment := ""
	switch q.AssignedTo.Mode {
	case model.TaskAssignmentAll:
		if q.AssignedTo.UserID != "" {
			return store.TaskPriorityPage{}, fmt.Errorf("invalid assignment")
		}
	case model.TaskAssignmentUnassigned:
		if q.AssignedTo.UserID != "" {
			return store.TaskPriorityPage{}, fmt.Errorf("invalid assignment")
		}
		assignment = " AND t.assigned_to IS NULL"
	case model.TaskAssignmentUser:
		assignment = " AND t.assigned_to=$11::uuid"
		args = append(args, q.AssignedTo.UserID)
	default:
		return store.TaskPriorityPage{}, fmt.Errorf("invalid assignment")
	}
	rows, err := s.tx.Query(ctx, `SELECT t.id::text, t.project_id::text, left(t.title,513), octet_length(t.title)>512, t.status, t.version,
 t.created_at, t.allow_agents, t.required_platform, t.assigned_to::text, `+pg.TaskReady+`,
 (SELECT count(*) FROM task_dependencies d WHERE d.project_id=t.project_id AND d.task_id=t.id
 AND NOT EXISTS (SELECT 1 FROM tasks p WHERE p.project_id=d.project_id AND p.id=d.depends_on_task_id AND p.status='done'))
 FROM tasks t WHERE t.project_id=$1 AND t.deleted_at IS NULL
 AND ($2::text IS NULL OR t.status=$2) AND (NOT $3::boolean OR t.status <> 'done')
 AND ($4::boolean IS NULL OR `+pg.TaskReady+`=$4) AND ($5::boolean IS NULL OR t.allow_agents=$5)
 AND ($6::text IS NULL OR t.required_platform IS NULL OR t.required_platform=$6)`+assignment+`
 AND ($7::int IS NULL OR (`+priorityGroup+`,t.created_at,t.id)>($7,$8::timestamptz,$9::uuid))
 ORDER BY `+priorityGroup+`,t.created_at,t.id LIMIT $10`, args...)
	if err != nil {
		return store.TaskPriorityPage{}, pg.QueryError("list priority tasks", err)
	}
	items := make([]store.TaskPriorityItem, 0, limit+1)
	for rows.Next() {
		var item store.TaskPriorityItem
		t := &item.Task
		if err := rows.Scan(&t.ID, &t.ProjectID, &t.Title, &item.TitleTruncated, &t.Status, &t.Version, &t.CreatedAt, &t.AllowAgents, &t.RequiredPlatform, &t.AssignedTo, &t.Ready, &item.BlockedByCount); err != nil {
			rows.Close()
			return store.TaskPriorityPage{}, pg.QueryError("list priority tasks", err)
		}
		if !t.Status.Valid() {
			rows.Close()
			return store.TaskPriorityPage{}, pg.QueryError("list priority tasks", fmt.Errorf("stored task status is invalid"))
		}
		t.CreatedAt = t.CreatedAt.UTC()
		items = append(items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return store.TaskPriorityPage{}, pg.QueryError("list priority tasks", err)
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	return store.TaskPriorityPage{Items: items, HasMore: hasMore}, nil
}
