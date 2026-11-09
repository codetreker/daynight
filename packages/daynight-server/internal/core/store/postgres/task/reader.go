package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
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

// TaskBounded withholds text which alone exceeds the single Task budget.
func (s *Reader) TaskBounded(ctx context.Context, projectID, id string, legacy bool) (model.Task, error) {
	projection := strings.Replace(pg.TaskProjection, "t.title, t.description,", "CASE WHEN octet_length(t.title)::bigint + octet_length(t.description)::bigint > 524288 THEN '' ELSE t.title END, CASE WHEN octet_length(t.title)::bigint + octet_length(t.description)::bigint > 524288 THEN '' ELSE t.description END,", 1)
	var oversized bool
	task, err := pg.ScanTask(pg.LiveTaskRow{Row: s.tx.QueryRow(ctx, `SELECT `+projection+`, (octet_length(t.title)::bigint + octet_length(t.description)::bigint > 524288), t.deleted_at FROM tasks t WHERE t.project_id=$1 AND t.id=$2`, projectID, id)}, &oversized)
	if err != nil {
		return model.Task{}, pg.QueryError("read task", err)
	}
	if oversized {
		return model.Task{}, &model.Fault{Code: "resource_limit_exceeded", Message: "Task exceeds the encoded resource limit."}
	}
	values, err := pg.LoadTaskPropertiesBounded(ctx, s.tx, task.ID, 512<<10, legacy)
	if err != nil {
		return model.Task{}, err
	}
	task.Properties = values
	return task, nil
}

func (s *Reader) Tasks(ctx context.Context, projectID string, query store.TaskQuery) (store.TaskPage, error) {
	if query.BoundedText && query.Page.Limit != 1 {
		return store.TaskPage{}, pg.QueryError("list tasks", fmt.Errorf("bounded task list requires one candidate"))
	}
	if query.BoundedText && query.Worker != nil {
		return s.boundedWorkerTasks(ctx, projectID, query)
	}
	afterTime, afterID := pg.PageValues(query.Page)
	var limit any = query.Page.Limit + 1
	projection := pg.TaskProjection
	if query.BoundedText {
		projection = strings.Replace(projection, "t.title, t.description,", "CASE WHEN octet_length(t.title)::bigint + octet_length(t.description)::bigint > 4194304 THEN '' ELSE t.title END, CASE WHEN octet_length(t.title)::bigint + octet_length(t.description)::bigint > 4194304 THEN '' ELSE t.description END,", 1)
		projection += ", (octet_length(t.title)::bigint + octet_length(t.description)::bigint > 4194304)"
	}
	join := ""
	if query.Worker != nil {
		limit = nil
		projection += ", worker_property.value"
		join = " LEFT JOIN task_properties worker_property ON worker_property.task_id=t.id AND worker_property.name='worker'"
	}
	arguments := []any{projectID, afterTime, afterID, query.Status, query.Ready, query.AllowAgents, query.CompatiblePlatform, limit, query.PlatformSpecific}
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
	rows, err := s.tx.Query(ctx, `SELECT `+projection+` FROM tasks t`+join+`
  WHERE t.project_id = $1 AND t.deleted_at IS NULL
  AND ($2::timestamptz IS NULL OR (t.created_at, t.id) > ($2, $3::uuid))
  AND ($4::text IS NULL OR t.status = $4)
  AND ($5::boolean IS NULL OR `+pg.TaskReady+` = $5)
  AND ($6::boolean IS NULL OR t.allow_agents = $6)
  AND ($7::text IS NULL OR t.required_platform IS NULL OR t.required_platform = $7)
  AND ($9::boolean IS NULL OR (t.required_platform IS NOT NULL) = $9)
  `+assignmentCondition+` ORDER BY t.created_at, t.id LIMIT $8`, arguments...)
	if err != nil {
		return store.TaskPage{}, pg.QueryError("list tasks", err)
	}
	defer rows.Close()
	items := make([]model.Task, 0, query.Page.Limit+1)
	oversized := false
	for rows.Next() {
		var workerValue *string
		var withheld bool
		var trailing []any
		if query.BoundedText {
			trailing = append(trailing, &withheld)
		}
		if query.Worker != nil {
			trailing = append(trailing, &workerValue)
		}
		task, err := pg.ScanTask(rows, trailing...)
		if err != nil {
			return store.TaskPage{}, pg.QueryError("list tasks", err)
		}
		if query.Worker != nil {
			if workerValue == nil {
				continue
			}
			value, err := taskproperties.NormalizeValue("worker", json.RawMessage(*workerValue))
			if err != nil {
				return store.TaskPage{}, pg.QueryError("decode worker inventory", err)
			}
			worker, err := taskproperties.Worker(model.TaskProperties{"worker": value})
			if err != nil {
				return store.TaskPage{}, pg.QueryError("decode worker inventory", err)
			}
			if worker.State != model.WorkerActive || worker.UserID != query.Worker.UserID || worker.WorkerID != query.Worker.WorkerID {
				continue
			}
		}
		items = append(items, task)
		if len(items) == 1 {
			oversized = withheld
		}
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
	if oversized || query.CandidateOnly {
		return store.TaskPage{Items: items, HasMore: hasMore, Oversized: oversized}, nil
	}
	if query.BoundedText && len(items) != 0 {
		properties, err := pg.LoadTaskPropertiesBounded(ctx, s.tx, items[0].ID, 4<<20, query.LegacyProjection)
		var fault *model.Fault
		if errors.As(err, &fault) && fault.Code == "resource_limit_exceeded" {
			return store.TaskPage{Items: items, HasMore: hasMore, Oversized: true}, nil
		}
		if err != nil {
			return store.TaskPage{}, err
		}
		items[0].Properties = properties
	} else if err := pg.AttachTaskProperties(ctx, s.tx, items); err != nil {
		return store.TaskPage{}, err
	}
	return store.TaskPage{Items: items, HasMore: hasMore, Oversized: oversized}, nil
}

// boundedWorkerTasks filters on a streaming Worker summary before loading the
// candidate's properties. Its cursor stays in the original ordered scope.
func (s *Reader) boundedWorkerTasks(ctx context.Context, projectID string, query store.TaskQuery) (store.TaskPage, error) {
	worker := query.Worker
	query.Worker = nil
	query.CandidateOnly = true
	var result store.TaskPage
	for {
		candidate, err := s.Tasks(ctx, projectID, query)
		if err != nil {
			return store.TaskPage{}, err
		}
		if len(candidate.Items) == 0 {
			return result, nil
		}
		item := candidate.Items[0]
		claim, err := pg.ReadTaskWorkerSummary(ctx, s.tx, item.ID)
		if err != nil {
			return store.TaskPage{}, pg.QueryError("decode worker inventory", err)
		}
		if claim != nil && claim.State == model.WorkerActive && claim.UserID == worker.UserID && claim.WorkerID == worker.WorkerID {
			if len(result.Items) > 0 {
				result.HasMore = true
				return result, nil
			}
			result.Items = []model.Task{item}
			result.Oversized = candidate.Oversized
			if result.Oversized {
				return result, nil
			}
			properties, err := pg.LoadTaskPropertiesBounded(ctx, s.tx, item.ID, 4<<20, query.LegacyProjection)
			var fault *model.Fault
			if errors.As(err, &fault) && fault.Code == "resource_limit_exceeded" {
				result.Oversized = true
				return result, nil
			}
			if err != nil {
				return store.TaskPage{}, err
			}
			result.Items[0].Properties = properties
		}
		if !candidate.HasMore {
			return result, nil
		}
		query.Page.After = &store.Position{CreatedAt: item.CreatedAt, ID: item.ID}
	}
}
