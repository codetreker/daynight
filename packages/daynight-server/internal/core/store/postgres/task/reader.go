package task

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type Reader struct{ tx pgx.Tx }

func NewReader(tx pgx.Tx) store.TaskReader { return &Reader{tx: tx} }

var _ store.TaskReader = (*Reader)(nil)

func (s *Reader) Task(ctx context.Context, projectID, id string) (model.Task, error) {
	return pg.ReadTaskWithLock(ctx, s.tx, projectID, id, "")
}

// taskResourceFilter applies typed selection before pagination. A nil parent
// selects all parents; none selects unassigned tasks.
func taskResourceFilter(taskType model.TaskType, parent *string, args *[]any) (string, error) {
	if taskType == "" {
		taskType = model.TaskTypeTask
	}
	if taskType != model.TaskTypeTask && taskType != model.TaskTypeGoal {
		return "", fmt.Errorf("invalid task type")
	}
	*args = append(*args, taskType)
	filter := fmt.Sprintf(" AND t.type=$%d::text", len(*args))
	if parent != nil {
		if *parent == "none" {
			return filter + " AND t.parent_id IS NULL", nil
		}
		id, err := model.CanonicalID(*parent)
		if err != nil || id != *parent {
			return "", fmt.Errorf("invalid parent ID")
		}
		*args = append(*args, id)
		filter += fmt.Sprintf(" AND t.parent_id=$%d::uuid", len(*args))
	}
	return filter, nil
}

func (s *Reader) Tasks(ctx context.Context, projectID string, query store.TaskQuery) (store.TaskPage, error) {
	afterTime, afterID := pg.PageValues(query.Page)
	arguments := []any{projectID, afterTime, afterID, query.Status, query.Ready, query.AllowAgents, query.CompatiblePlatform, query.Page.Limit + 1, query.PlatformSpecific}
	assignmentCondition := ""
	switch query.AssignedTo.Mode {
	case model.TaskAssignmentAll:
		if query.AssignedTo.UserID != "" {
			return store.TaskPage{}, pg.QueryError("list tasks", fmt.Errorf("task assignment filter is invalid"))
		}
	case model.TaskAssignmentUnassigned:
		if query.AssignedTo.UserID != "" {
			return store.TaskPage{}, pg.QueryError("list tasks", fmt.Errorf("task assignment filter is invalid"))
		}
		assignmentCondition = " AND t.assigned_to IS NULL"
	case model.TaskAssignmentUser:
		assignmentCondition = " AND t.assigned_to = $10::uuid"
		arguments = append(arguments, query.AssignedTo.UserID)
	default:
		return store.TaskPage{}, pg.QueryError("list tasks", fmt.Errorf("task assignment filter is invalid"))
	}
	resourceFilter, err := taskResourceFilter(query.Type, query.Parent, &arguments)
	if err != nil {
		return store.TaskPage{}, pg.QueryError("list tasks", err)
	}
	tagFilter, err := taskTagFilter(query.TagFilter, &arguments)
	if err != nil {
		return store.TaskPage{}, pg.QueryError("list tasks", err)
	}
	nameFilter, err := candidateTagNameFilter(query.CandidateTagFilter, &arguments)
	if err != nil {
		return store.TaskPage{}, pg.QueryError("list tasks", err)
	}
	candidateFilter := ""
	if query.AutomaticCandidate {
		candidateFilter = ` AND t.type = 'task' AND (t.parent_id IS NULL OR EXISTS (
			SELECT 1 FROM tasks parent WHERE parent.id=t.parent_id AND parent.project_id=t.project_id
			AND parent.type='goal' AND parent.deleted_at IS NULL AND parent.status NOT IN ('done', 'cancelled')))`
	}
	workerJoin := ""
	if query.Worker != nil {
		arguments = append(arguments, query.Worker.UserID, query.Worker.WorkerID)
		workerJoin = fmt.Sprintf(` JOIN task_properties worker_property ON worker_property.task_id=t.id
  AND worker_property.name='worker'
  AND ((CASE WHEN worker_property.name='worker' THEN worker_property.value::jsonb END)->>'state') COLLATE "C" = 'active'
  AND ((CASE WHEN worker_property.name='worker' THEN worker_property.value::jsonb END)->>'userId') COLLATE "C" = $%d::text COLLATE "C"
  AND ((CASE WHEN worker_property.name='worker' THEN worker_property.value::jsonb END)->>'workerId') COLLATE "C" = $%d::text COLLATE "C"`, len(arguments)-1, len(arguments))
	}
	selection := ` FROM task_resource_rows t` + workerJoin + `
  WHERE t.project_id = $1 AND t.effective_deleted_at IS NULL
  AND ($2::timestamptz IS NULL OR (t.created_at, t.id) > ($2, $3::uuid))
  AND ($4::text IS NULL OR t.status = $4)
  AND ($5::boolean IS NULL OR ` + pg.TaskReady + ` = $5)
  AND ($6::boolean IS NULL OR t.allow_agents = $6)
  AND ($7::text IS NULL OR t.required_platform IS NULL OR t.required_platform = $7)
  AND ($9::boolean IS NULL OR (t.required_platform IS NOT NULL) = $9)
  ` + assignmentCondition + resourceFilter + tagFilter + candidateFilter + nameFilter + ` ORDER BY t.created_at, t.id LIMIT $8`
	statement := `SELECT ` + pg.TaskProjection + selection
	if query.Worker != nil {
		// Materialize the narrow page before expanding dependency arrays and task bodies.
		statement = `WITH page AS MATERIALIZED (SELECT t.id, t.created_at` + selection + `)
 SELECT ` + pg.TaskProjection + `, worker_property.value FROM page
 JOIN task_resource_rows t ON t.id=page.id
 JOIN task_properties worker_property ON worker_property.task_id=t.id AND worker_property.name='worker'
 ORDER BY page.created_at, page.id`
	}
	rows, err := s.tx.Query(ctx, statement, arguments...)
	if err != nil {
		return store.TaskPage{}, pg.QueryError("list tasks", err)
	}
	defer rows.Close()
	items := make([]model.Task, 0, query.Page.Limit+1)
	for rows.Next() {
		var workerValue *string
		var trailing []any
		if query.Worker != nil {
			trailing = append(trailing, &workerValue)
		}
		task, err := pg.ScanTask(rows, trailing...)
		if err != nil {
			return store.TaskPage{}, pg.QueryError("list tasks", err)
		}
		if query.Worker != nil {
			var worker model.WorkerClaim
			if err := json.Unmarshal([]byte(*workerValue), &worker); err != nil {
				return store.TaskPage{}, pg.QueryError("decode worker inventory", err)
			}
		}
		items = append(items, task)
		if len(items) > query.Page.Limit {
			break
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return store.TaskPage{}, pg.QueryError("list tasks", err)
	}
	hasMore := len(items) > query.Page.Limit
	if hasMore {
		items = items[:query.Page.Limit]
	}
	if err := pg.AttachTaskProperties(ctx, s.tx, items); err != nil {
		return store.TaskPage{}, err
	}
	if err := pg.AttachTaskTags(ctx, s.tx, projectID, items); err != nil {
		return store.TaskPage{}, err
	}
	return store.TaskPage{Items: items, HasMore: hasMore}, nil
}
