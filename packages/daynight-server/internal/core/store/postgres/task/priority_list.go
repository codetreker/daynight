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

const priorityGroup = `(CASE WHEN t.status='in_progress' THEN 0 WHEN ` + pg.TaskReady + ` THEN 1 WHEN t.status='todo' THEN 2 WHEN t.status='proposed' THEN 3 ELSE 4 END)`

func (s *Reader) TaskPriorityList(ctx context.Context, projectID string, q store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
	if q.Limit < 1 || q.Limit > 100 {
		return store.TaskPriorityPage{}, pg.QueryError("list tasks", fmt.Errorf("invalid limit"))
	}
	limit := q.Limit
	var group, afterTime, afterID any
	if q.After != nil {
		group, afterTime, afterID = q.After.Group, q.After.CreatedAt, q.After.ID
	}
	args := []any{projectID, q.Status, q.ExcludeTerminal, q.Ready, q.AllowAgents, q.CompatiblePlatform, group, afterTime, afterID, limit + 1}
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
	resourceFilter, err := taskResourceFilter(q.Type, q.Parent, &args)
	if err != nil {
		return store.TaskPriorityPage{}, pg.QueryError("list priority tasks", err)
	}
	tagFilter, err := taskTagFilter(q.TagFilter, &args)
	if err != nil {
		return store.TaskPriorityPage{}, pg.QueryError("list priority tasks", err)
	}
	rows, err := s.tx.Query(ctx, `SELECT t.id::text, t.project_id::text, t.type, t.parent_id::text, left(t.title,513), octet_length(t.title)>512, t.status, t.version,
 t.created_at, t.allow_agents, t.required_platform, t.assigned_to::text, `+pg.TaskReady+`,
 `+pg.TaskBlockedCount+`
 FROM task_resource_rows t WHERE t.project_id=$1 AND t.effective_deleted_at IS NULL
 AND ($2::text IS NULL OR t.status=$2) AND (NOT $3::boolean OR t.status NOT IN ('done', 'cancelled'))
 AND ($4::boolean IS NULL OR `+pg.TaskReady+`=$4) AND ($5::boolean IS NULL OR t.allow_agents=$5)
 AND ($6::text IS NULL OR t.required_platform IS NULL OR t.required_platform=$6)`+assignment+resourceFilter+tagFilter+`
 AND ($7::int IS NULL OR (`+priorityGroup+`,t.created_at,t.id)>($7,$8::timestamptz,$9::uuid))
 ORDER BY `+priorityGroup+`,t.created_at,t.id LIMIT $10`, args...)
	if err != nil {
		return store.TaskPriorityPage{}, pg.QueryError("list priority tasks", err)
	}
	items := make([]store.TaskPriorityItem, 0, limit+1)
	for rows.Next() {
		var item store.TaskPriorityItem
		t := &item.Task
		if err := rows.Scan(&t.ID, &t.ProjectID, &t.Type, &t.ParentID, &t.Title, &item.TitleTruncated, &t.Status, &t.Version, &t.CreatedAt, &t.AllowAgents, &t.RequiredPlatform, &t.AssignedTo, &t.Ready, &item.BlockedByCount); err != nil {
			rows.Close()
			return store.TaskPriorityPage{}, pg.QueryError("list priority tasks", err)
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
	ids := make([]string, len(items))
	for i := range items {
		ids[i] = items[i].Task.ID
	}
	tags, err := pg.LoadTaskTagsBatch(ctx, s.tx, projectID, ids)
	if err != nil {
		return store.TaskPriorityPage{}, err
	}
	for i := range items {
		items[i].Task.Tags = tags[items[i].Task.ID]
	}
	return store.TaskPriorityPage{Items: items, HasMore: hasMore}, nil
}
