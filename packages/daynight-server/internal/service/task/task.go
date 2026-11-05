package task

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/freeze"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskprops "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"
	"github.com/google/uuid"
)

type taskStore interface {
	store.SnapshotReader
	store.ProjectWriter
}

type Tasks struct {
	store taskStore
}

func NewTasks(database taskStore) *Tasks {
	return &Tasks{store: database}
}

type TaskListRequest struct {
	AssignedTo *string
	model.PageRequest
	Status             *model.TaskStatus
	Ready              *bool
	AllowAgents        *bool
	CompatiblePlatform *model.TaskPlatform
	WorkerID           *string
}

type TaskPage struct {
	Items      []model.Task
	NextCursor *string
}

func (s *Tasks) Create(ctx context.Context, principal model.Principal, projectID string, input taskcore.CreateTask) (model.Task, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.Task{}, err
	}
	properties, err := taskprops.Normalize(input.Properties)
	if err != nil {
		return model.Task{}, taskcore.PropertyInputError(err)
	}
	projectID, err = model.CanonicalID(projectID)
	if err != nil {
		return model.Task{}, err
	}
	id, err := uuid.NewRandom()
	if err != nil {
		return model.Task{}, fmt.Errorf("generate task ID: %w", err)
	}
	input.Properties = properties
	values, err := taskcore.CreateCandidate(id.String(), input)
	if err != nil {
		return model.Task{}, err
	}
	return s.write(ctx, principal, projectID, func(tx store.ProjectWriteScope) (taskcore.Mutation, error) {
		mutation, err := taskcore.PrepareCreate(ctx, tx.TaskDAO(), id.String(), values)
		return mutation, err
	})
}

func (s *Tasks) Update(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.UpdateTask) (model.Task, error) {
	projectID, id, err := taskWriteIdentity(principal, projectID, id, input.Version)
	if err != nil {
		return model.Task{}, err
	}
	if err := taskcore.ValidateUpdateFields(input); err != nil {
		return model.Task{}, err
	}
	return s.write(ctx, principal, projectID, func(tx store.ProjectWriteScope) (taskcore.Mutation, error) {
		mutation, err := taskcore.PrepareUpdate(ctx, tx.TaskDAO(), id, input)
		return mutation, err
	})
}

func (s *Tasks) write(ctx context.Context, principal model.Principal, projectID string, prepare func(store.ProjectWriteScope) (taskcore.Mutation, error)) (model.Task, error) {
	var result model.Task
	var refusal *model.Fault
	completion, err := s.store.WriteProject(ctx, projectID, func(tx store.ProjectWriteScope) error {
		if _, err := projectcore.RequireProjectWrite(ctx, tx.ProjectDAO(), principal); err != nil {
			if errors.As(err, &refusal) {
				return nil
			}
			return err
		}
		mutation, err := prepare(tx)
		if err != nil {
			if refusal = taskWriteFault(err); refusal != nil {
				return nil
			}
			return err
		}
		if !mutation.Changed {
			result, err = taskcore.ApplyMutation(ctx, tx.TaskDAO(), mutation)
			return err
		}
		if mutation.Delete {
			if _, err := taskcore.ApplyMutation(ctx, tx.TaskDAO(), mutation); err != nil {
				return err
			}
			if err := sessioncore.FreezeTaskSessions(ctx, tx.SessionDAO(), mutation.ID, model.TaskTodo, nil); err != nil {
				return err
			}
			return tx.ProjectDAO().InvalidateTaskCache(ctx)
		}
		mutation, err = enforceAssignmentTransition(ctx, tx, mutation)
		if err != nil {
			if refusal = taskWriteFault(err); refusal != nil {
				return nil
			}
			return err
		}
		result, err = taskcore.ApplyMutation(ctx, tx.TaskDAO(), mutation)
		if err == nil && !mutation.Create {
			err = sessioncore.FreezeTaskSessions(ctx, tx.SessionDAO(), mutation.ID, mutation.Values.Status, mutation.Values.Properties)
		}
		return err
	})
	if err != nil {
		err = projectcore.ProjectWriteError(err)
		if fault, ok := err.(*model.Fault); ok {
			return model.Task{}, fault
		}
		return model.Task{}, fmt.Errorf("write task: %w", err)
	}
	if completion.Outcome != store.TransactionCommitted {
		return model.Task{}, fmt.Errorf("write task: transaction did not confirm commit")
	}
	if refusal != nil {
		return model.Task{}, refusal
	}
	return result, nil
}

func (s *Tasks) versionedWrite(ctx context.Context, principal model.Principal, projectID, id string, version int64, prepare func(store.ProjectWriteScope, model.Task) (taskcore.Mutation, error)) (model.Task, error) {
	projectID, id, err := taskWriteIdentity(principal, projectID, id, version)
	if err != nil {
		return model.Task{}, err
	}
	return s.write(ctx, principal, projectID, func(tx store.ProjectWriteScope) (taskcore.Mutation, error) {
		current, err := tx.TaskDAO().Task(ctx, id)
		if errors.Is(err, model.ErrNotFound) {
			return taskcore.Mutation{}, taskcore.NotFound(err)
		}
		if err != nil {
			return taskcore.Mutation{}, err
		}
		if err := taskcore.RequireVersion(current.Version, version); err != nil {
			return taskcore.Mutation{}, err
		}
		worker, err := taskproperties.Worker(current.Properties)
		if err != nil {
			return taskcore.Mutation{}, err
		}
		if err := taskcore.RequireCompatibleWorker(ctx, worker); err != nil {
			return taskcore.Mutation{}, err
		}
		return prepare(tx, current)
	})
}
