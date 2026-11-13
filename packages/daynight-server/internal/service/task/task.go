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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/google/uuid"
)

type taskStore interface {
	store.SnapshotReader
	store.ProjectWriter
}

type taskListOperations struct {
	requireProjectRead func(context.Context, projectcore.ProjectAccessReader, model.Principal, string) (model.ProjectAccess, error)
	readList           func(context.Context, taskcore.ReadDAO, string, taskcore.ListSelection) (store.TaskPage, *model.Fault, error)
}

type taskWriteOperations struct {
	requireProjectWrite func(context.Context, store.ProjectWriteDAO, model.Principal) (model.ProjectAccess, error)
	prepareCreate       func(context.Context, store.TaskWriteDAO, string, store.TaskWrite) (taskcore.Mutation, error)
	prepareUpdate       func(context.Context, store.TaskWriteDAO, string, taskcore.UpdateTask) (taskcore.Mutation, error)
	prepareStatus       func(context.Context, store.TaskWriteDAO, model.Principal, string, taskcore.SetTaskStatus) (taskcore.Mutation, error)
}

type Tasks struct {
	store           taskStore
	capturer        Capturer
	listOperations  taskListOperations
	writeOperations taskWriteOperations
}

func NewTasks(database taskStore, capture ...Capturer) *Tasks {
	return &Tasks{
		store: database, capturer: capturer(capture),
		listOperations:  taskListOperations{requireProjectRead: projectcore.RequireProjectRead, readList: taskcore.ReadList},
		writeOperations: taskWriteOperations{requireProjectWrite: projectcore.RequireProjectWrite, prepareCreate: taskcore.PrepareCreate, prepareUpdate: taskcore.PrepareUpdate, prepareStatus: taskcore.PrepareStatus},
	}
}

type TaskListRequest struct {
	TagFilter  store.TagFilter
	Type       model.TaskType
	Parent     *string
	AssignedTo *string
	model.PageRequest
	Status             *model.TaskStatus
	Ready              *bool
	AllowAgents        *bool
	CompatiblePlatform *model.TaskPlatform
	PlatformSpecific   *bool
	AutomaticCandidate bool
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
	if input.Type == model.TaskTypeGoal && !input.AssignedToPresent {
		input.AssignedTo = &principal.UserID
	}
	values, err := taskcore.CreateCandidate(id.String(), input)
	if err != nil {
		return model.Task{}, err
	}
	return s.writeTagged(ctx, principal, projectID, input.TagIDs, func(tx store.ProjectWriteScope) (taskcore.Mutation, error) {
		mutation, err := s.writeOperations.prepareCreate(ctx, tx.TaskDAO(), id.String(), values)
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
	return s.writeTagged(ctx, principal, projectID, input.TagIDs, func(tx store.ProjectWriteScope) (taskcore.Mutation, error) {
		mutation, err := s.writeOperations.prepareUpdate(ctx, tx.TaskDAO(), id, input)
		return mutation, err
	})
}

// UpdatePartitionedDependencies accepts the MCP partition of ordinary and
// external dependencies. Version admission precedes allocation of the union.
func (s *Tasks) UpdatePartitionedDependencies(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.UpdateTask, ordinary, external *[]string) (model.Task, error) {
	if ordinary == nil && external == nil {
		return s.Update(ctx, principal, projectID, id, input)
	}
	projectID, id, err := taskWriteIdentity(principal, projectID, id, input.Version)
	if err != nil {
		return model.Task{}, err
	}
	return s.versionedWriteTagged(ctx, principal, projectID, id, input.Version, input.TagIDs, func(tx store.ProjectWriteScope, _ model.Task) (taskcore.Mutation, error) {
		all, ext, err := PartitionDependencies(ordinary, external)
		if err != nil {
			return taskcore.Mutation{}, err
		}
		input.DependsOn, input.ExternalDependsOn = all, ext
		return s.writeOperations.prepareUpdate(ctx, tx.TaskDAO(), id, input)
	})
}

func (s *Tasks) write(ctx context.Context, principal model.Principal, projectID string, prepare func(store.ProjectWriteScope) (taskcore.Mutation, error)) (model.Task, error) {
	return s.writeTagged(ctx, principal, projectID, nil, prepare)
}

func (s *Tasks) writeTagged(ctx context.Context, principal model.Principal, projectID string, requested *[]string, prepare func(store.ProjectWriteScope) (taskcore.Mutation, error)) (model.Task, error) {
	var result model.Task
	var refusal *model.Fault
	completion, err := s.store.WriteProject(ctx, projectID, func(tx store.ProjectWriteScope) error {
		if _, err := s.writeOperations.requireProjectWrite(ctx, tx.ProjectDAO(), principal); err != nil {
			if errors.As(err, &refusal) {
				return nil
			}
			return err
		}
		mutation, err := prepare(tx)
		if err != nil {
			if requested != nil {
				return err
			}
			if refusal = taskWriteFault(err); refusal != nil {
				return nil
			}
			return err
		}
		var ids []string
		var tagsChanged bool
		if requested != nil {
			if mutation.Create {
				ids, err = prepareCreateTags(ctx, tx, *requested)
				tagsChanged = len(ids) != 0
			} else {
				ids, tagsChanged, err = prepareTagReplacement(ctx, tx, mutation.Current, mutation.Current.Version, requested)
			}
			if err != nil {
				return err
			}
		}
		recordTaskWriteMetadata(ctx, mutation)
		if !mutation.Changed {
			if tagsChanged {
				observed, err := tx.TaskDAO().ObservedAt(ctx)
				if err != nil {
					return err
				}
				if err := tx.TaskTagDAO().ReplaceTaskTags(ctx, mutation.ID, ids); err != nil {
					return err
				}
				if err := tx.TaskDAO().TouchTask(ctx, mutation.ID, observed); err != nil {
					return err
				}
				result, err = tx.TaskDAO().Task(ctx, mutation.ID)
				if err != nil {
					return err
				}
			} else {
				applied, err := taskcore.ApplyMutation(ctx, tx.TaskDAO(), mutation)
				result = applied.Task
				if err != nil {
					return err
				}
			}
			values := []model.Task{result}
			if err := decorateGoalProgress(ctx, tx.TaskDAO(), projectID, values); err != nil {
				return err
			}
			result = values[0]
			return admitTaskResponse(ctx, result, tagsChanged)
		}
		if mutation.Delete {
			applied, err := taskcore.ApplyMutation(ctx, tx.TaskDAO(), mutation)
			if err != nil {
				return err
			}
			if mutation.Current.Type != model.TaskTypeGoal {
				if err := sessioncore.FreezeTaskSessions(ctx, tx.SessionDAO(), mutation.ID, model.TaskTodo, nil); err != nil {
					return err
				}
			}
			if err := tx.ProjectDAO().InvalidateTaskCache(ctx); err != nil {
				return err
			}
			if mutation.Current.Type == model.TaskTypeGoal {
				return nil
			}
			tombstone := applied.Tombstone
			f := protocol.Fact{Type: protocol.Deleted, ProjectID: tombstone.ProjectID, TaskID: tombstone.ID, TaskVersion: tombstone.Version, OccurredAt: tombstone.DeletedAt, DeletedAt: &tombstone.DeletedAt}
			return s.capturer.CaptureBatch(ctx, tx.CaptureDAO(), []protocol.Fact{f})
		}
		mutation, err = enforceAssignmentTransition(ctx, tx, mutation)
		if err != nil {
			if requested != nil {
				return err
			}
			if refusal = taskWriteFault(err); refusal != nil {
				return nil
			}
			return err
		}
		if tagsChanged && !mutation.Create {
			if err := tx.TaskTagDAO().ReplaceTaskTags(ctx, mutation.ID, ids); err != nil {
				return err
			}
		}
		applied, err := taskcore.ApplyMutation(ctx, tx.TaskDAO(), mutation)
		result = applied.Task
		if err == nil && mutation.Create && tagsChanged {
			if err = tx.TaskTagDAO().ReplaceTaskTags(ctx, mutation.ID, ids); err == nil {
				result, err = tx.TaskDAO().Task(ctx, mutation.ID)
			}
		}
		if err == nil && mutation.Create && !taskcore.MatchesTagIDs(result.Tags, ids) {
			return errors.New("created task tag references do not match requested identities")
		}
		if err == nil {
			var parent taskcore.Mutation
			parent, err = taskcore.PrepareParentStart(ctx, tx.TaskDAO(), mutation)
			if err == nil && parent.Changed {
				_, err = taskcore.ApplyMutation(ctx, tx.TaskDAO(), parent)
			}
		}
		if err == nil {
			values := []model.Task{result}
			err = decorateGoalProgress(ctx, tx.TaskDAO(), projectID, values)
			result = values[0]
		}
		if err == nil {
			err = admitTaskResponse(ctx, result, true)
		}
		if err == nil && !mutation.Create && result.Type != model.TaskTypeGoal {
			err = sessioncore.FreezeTaskSessions(ctx, tx.SessionDAO(), mutation.ID, mutation.Values.Status, mutation.Values.Properties)
		}
		if err != nil {
			return err
		}
		facts, err := taskFacts(mutation.Create, mutation.Current, result)
		if err != nil {
			return err
		}
		if len(facts) == 0 {
			return nil
		}
		return s.capturer.CaptureBatch(ctx, tx.CaptureDAO(), facts)
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
	return s.versionedWriteTagged(ctx, principal, projectID, id, version, nil, prepare)
}

func (s *Tasks) versionedWriteTagged(ctx context.Context, principal model.Principal, projectID, id string, version int64, requested *[]string, prepare func(store.ProjectWriteScope, model.Task) (taskcore.Mutation, error)) (model.Task, error) {
	projectID, id, err := taskWriteIdentity(principal, projectID, id, version)
	if err != nil {
		return model.Task{}, err
	}
	return s.writeTagged(ctx, principal, projectID, requested, func(tx store.ProjectWriteScope) (taskcore.Mutation, error) {
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
