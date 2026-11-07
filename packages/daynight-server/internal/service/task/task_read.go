package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
)

// TaskObservation binds a complete task to the project history observed with it.
type TaskObservation struct {
	Task  model.Task
	Epoch string
}

func (s *Tasks) Get(ctx context.Context, principal model.Principal, projectID, id string) (model.Task, error) {
	observation, err := s.read(ctx, principal, projectID, id, false, false, false)
	return observation.Task, err
}

func (s *Tasks) Observe(ctx context.Context, principal model.Principal, projectID, id string) (TaskObservation, error) {
	return s.read(ctx, principal, projectID, id, true, false, false)
}

func (s *Tasks) ObserveREST(ctx context.Context, principal model.Principal, projectID, id string, extended bool) (TaskObservation, error) {
	return s.read(ctx, principal, projectID, id, true, true, !extended)
}

func (s *Tasks) read(ctx context.Context, principal model.Principal, projectID, id string, withEpoch, boundedRead, legacy bool) (TaskObservation, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return TaskObservation{}, err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return TaskObservation{}, err
	}
	id, err = model.CanonicalID(id)
	if err != nil {
		return TaskObservation{}, err
	}
	var result TaskObservation
	var missing *model.Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if _, err := projectcore.RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID); err != nil {
			if errors.As(err, &missing) {
				return nil
			}
			return err
		}
		var err error
		reader := snapshot.TaskDAO()
		if bounded, ok := reader.(interface {
			TaskBounded(context.Context, string, string, bool) (model.Task, error)
		}); boundedRead && ok {
			result.Task, err = bounded.TaskBounded(ctx, projectID, id, legacy)
			var fault *model.Fault
			if errors.As(err, &fault) && fault.Code == "resource_limit_exceeded" {
				missing, err = fault, nil
			} else if fault := taskcore.ReadFault(err); fault != nil {
				missing, err = fault, nil
			}
		} else {
			result.Task, missing, err = taskcore.ReadTask(ctx, reader, projectID, id)
		}
		if err != nil || missing != nil || !withEpoch {
			return err
		}
		result.Epoch, err = snapshot.TaskDAO().TaskCacheEpoch(ctx, projectID)
		return err
	})
	if err != nil {
		return TaskObservation{}, fmt.Errorf("get task: %w", err)
	}
	if missing != nil {
		return TaskObservation{}, missing
	}
	return result, nil
}

func (s *Tasks) List(ctx context.Context, principal model.Principal, projectID string, request TaskListRequest) (TaskPage, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return TaskPage{}, err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return TaskPage{}, err
	}
	selection, err := taskcore.SelectList(projectID, principal.UserID, taskcore.ListRequest{
		PageRequest: request.PageRequest, AssignedTo: request.AssignedTo, Status: request.Status, Ready: request.Ready,
		AllowAgents: request.AllowAgents, CompatiblePlatform: request.CompatiblePlatform, WorkerID: request.WorkerID,
	})
	if err != nil {
		return TaskPage{}, err
	}
	var result store.TaskPage
	var missing *model.Fault
	var pageEncodingErr error
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if _, err := projectcore.RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID); err != nil {
			if errors.As(err, &missing) {
				return nil
			}
			return err
		}
		var err error
		result, missing, err = readBoundedTaskPage(ctx, snapshot.TaskDAO(), projectID, selection, request.ExtendedWorker)
		var local *taskPageEncodingError
		if errors.As(err, &local) {
			pageEncodingErr = local.err
			return nil
		}
		return err
	})
	if err != nil {
		return TaskPage{}, fmt.Errorf("list tasks: %w", err)
	}
	if missing != nil {
		return TaskPage{}, missing
	}
	if pageEncodingErr != nil {
		return TaskPage{}, pageEncodingErr
	}
	page, err := taskcore.ProjectList(selection, result)
	if err != nil {
		return TaskPage{}, err
	}
	return TaskPage{Items: page.Items, NextCursor: page.NextCursor}, nil
}

type taskPageEncodingError struct{ err error }

func (e *taskPageEncodingError) Error() string { return e.err.Error() }
func (e *taskPageEncodingError) Unwrap() error { return e.err }

// readBoundedTaskPage consumes a single candidate at a time in the same
// snapshot. A candidate that does not fit remains reachable after the cursor
// generated from the last item actually returned.
func readBoundedTaskPage(ctx context.Context, reader taskcore.ReadDAO, projectID string, selection taskcore.ListSelection, extended bool) (store.TaskPage, *model.Fault, error) {
	limit := selection.Query.Page.Limit
	selection.Query.Page.Limit = 1
	selection.Query.BoundedText = true
	selection.Query.LegacyProjection = !extended
	result := store.TaskPage{Items: make([]model.Task, 0, limit)}
	var itemBytes int64
	for len(result.Items) < limit {
		if err := ctx.Err(); err != nil {
			return store.TaskPage{}, nil, err
		}
		page, refusal, err := taskcore.ReadList(ctx, reader, projectID, selection)
		if err != nil || refusal != nil {
			return store.TaskPage{}, refusal, err
		}
		if len(page.Items) == 0 {
			return result, nil, nil
		}
		if page.Oversized {
			if len(result.Items) == 0 {
				return store.TaskPage{}, &model.Fault{Code: "resource_limit_exceeded", Message: "Task does not fit in the encoded page limit."}, nil
			}
			result.HasMore = true
			return result, nil, nil
		}
		candidate := page.Items[0]
		var cursor *string
		if page.HasMore {
			value, err := query.EncodeListCursor(selection.Scope, candidate.CreatedAt, candidate.ID)
			if err != nil {
				return store.TaskPage{}, nil, &taskPageEncodingError{err: fmt.Errorf("encode task cursor: %w", err)}
			}
			cursor = &value
		}
		size, err := taskprotocol.EncodeREST(io.Discard, candidate, extended, taskcore.MaxPageResponseJSONBytes)
		if err != nil {
			classified := taskResponseError(err)
			var fault *model.Fault
			if errors.As(classified, &fault) && fault.Code == "resource_limit_exceeded" && len(result.Items) > 0 {
				result.HasMore = true
				return result, nil, nil
			}
			if fault != nil {
				return store.TaskPage{}, fault, nil
			}
			return store.TaskPage{}, nil, &taskPageEncodingError{err: classified}
		}
		// Encode the actual empty envelope including its newline; item encoders
		// each include a newline, replaced by commas inside the array.
		envelope, err := json.Marshal(struct {
			Items      []json.RawMessage `json:"items"`
			NextCursor *string           `json:"nextCursor"`
		}{Items: []json.RawMessage{}, NextCursor: cursor})
		if err != nil {
			return store.TaskPage{}, nil, &taskPageEncodingError{err: err}
		}
		candidateBytes := itemBytes + size - 1
		if len(result.Items) > 0 {
			candidateBytes++
		}
		if int64(len(envelope)+1)+candidateBytes > taskcore.MaxPageResponseJSONBytes {
			if len(result.Items) == 0 {
				return store.TaskPage{}, &model.Fault{Code: "resource_limit_exceeded", Message: "Task does not fit in the encoded page limit."}, nil
			}
			result.HasMore = true
			return result, nil, nil
		}
		itemBytes = candidateBytes
		result.Items = append(result.Items, candidate)
		result.HasMore = page.HasMore
		if !page.HasMore {
			return result, nil, nil
		}
		selection.Query.Page.After = &store.Position{CreatedAt: candidate.CreatedAt, ID: candidate.ID}
	}
	return result, nil, nil
}
