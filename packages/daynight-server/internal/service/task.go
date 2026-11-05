package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
	"github.com/google/uuid"
)

type Tasks struct {
	store *store.Store
}

func NewTasks(database *store.Store) *Tasks {
	return &Tasks{store: database}
}

type CreateTask struct {
	AssignedTo        *string
	RequiredPlatform  *model.TaskPlatform
	ExternalDependsOn []string
	Title             string
	Description       string
	Properties        model.TaskProperties
	DependsOn         []string
}

type UpdateTask struct {
	AssignedTo        **string
	RequiredPlatform  **model.TaskPlatform
	ExternalDependsOn *[]string
	AllowAgents       *bool
	Version           int64
	Title             *string
	Description       *string
	DependsOn         *[]string
	Properties        model.TaskPropertiesPatch
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

type taskMutation struct {
	id            string
	current       model.Task
	values        store.TaskWrite
	create        bool
	changed       bool
	deleted       bool
	removeDepends bool
}

func (s *Tasks) Create(ctx context.Context, principal model.Principal, projectID string, input CreateTask) (model.Task, error) {
	if err := requirePrincipal(principal); err != nil {
		return model.Task{}, err
	}
	properties, err := taskproperties.Normalize(input.Properties, true)
	if err != nil {
		return model.Task{}, propertyInputFault(err)
	}
	projectID, err = CanonicalID(projectID)
	if err != nil {
		return model.Task{}, err
	}
	id, err := uuid.NewRandom()
	if err != nil {
		return model.Task{}, fmt.Errorf("generate task ID: %w", err)
	}
	assignedTo, err := canonicalAssignedTo(input.AssignedTo)
	if err != nil {
		return model.Task{}, err
	}
	values := store.TaskWrite{AssignedTo: assignedTo, RequiredPlatform: input.RequiredPlatform, AllowAgents: false, Title: input.Title, Description: input.Description, Status: model.TaskTodo, Properties: properties}
	values.DependsOn, err = canonicalDependencies(input.DependsOn, id.String())
	if err != nil {
		return model.Task{}, err
	}
	values.ExternalDependsOn, err = canonicalExternalDependencies(input.ExternalDependsOn, id.String(), values.DependsOn)
	if err != nil {
		return model.Task{}, err
	}
	if err := validateTaskValues(values); err != nil {
		return model.Task{}, err
	}
	return s.write(ctx, principal, projectID, func(tx *store.ProjectTx) (taskMutation, error) {
		if err := validateCandidate(ctx, tx, id.String(), values); err != nil {
			return taskMutation{}, err
		}
		return taskMutation{id: id.String(), values: values, create: true, changed: true}, nil
	})
}

func (s *Tasks) Update(ctx context.Context, principal model.Principal, projectID, id string, input UpdateTask) (model.Task, error) {
	projectID, id, err := taskWriteIdentity(principal, projectID, id, input.Version)
	if err != nil {
		return model.Task{}, err
	}
	if input.Title == nil && input.Description == nil && input.DependsOn == nil && input.ExternalDependsOn == nil && len(input.Properties) == 0 && input.AllowAgents == nil && input.RequiredPlatform == nil && input.AssignedTo == nil {
		return model.Task{}, invalidInput("At least one task field must be provided.")
	}
	return s.write(ctx, principal, projectID, func(tx *store.ProjectTx) (taskMutation, error) {
		current, err := tx.Task(ctx, id)
		if errors.Is(err, model.ErrNotFound) {
			return taskMutation{}, taskNotFound(err)
		}
		if err != nil {
			return taskMutation{}, err
		}
		if err := requireTaskVersion(current.Version, input.Version); err != nil {
			return taskMutation{}, err
		}
		worker, err := taskproperties.Worker(current.Properties)
		if err != nil {
			return taskMutation{}, err
		}
		if err := requireCompatibleWorker(ctx, worker); err != nil {
			return taskMutation{}, err
		}
		values, err := taskCandidate(current, input)
		if err != nil {
			return taskMutation{}, err
		}
		if current.AllowAgents != values.AllowAgents && current.Status == model.TaskInProgress {
			return taskMutation{}, &model.Fault{Code: "invalid_transition", Message: "Automatic execution permission cannot change while the task is in progress."}
		}
		if !equalOptional(current.RequiredPlatform, values.RequiredPlatform) && current.Status == model.TaskInProgress {
			return taskMutation{}, &model.Fault{Code: "invalid_transition", Message: "Execution platform cannot change while the task is in progress."}
		}
		if err := validateCandidate(ctx, tx, id, values); err != nil {
			return taskMutation{}, err
		}
		changed := !equalOptional(current.AssignedTo, values.AssignedTo) || !equalOptional(current.RequiredPlatform, values.RequiredPlatform) || current.AllowAgents != values.AllowAgents || current.Title != values.Title || current.Description != values.Description ||
			!slices.Equal(current.DependsOn, values.DependsOn) || !slices.Equal(current.ExternalDependsOn, values.ExternalDependsOn) || !taskproperties.Equal(current.Properties, values.Properties)
		return taskMutation{id: id, current: current, values: values, changed: changed}, nil
	})
}

func (s *Tasks) write(ctx context.Context, principal model.Principal, projectID string, prepare func(*store.ProjectTx) (taskMutation, error)) (model.Task, error) {
	var result model.Task
	var refusal *model.Fault
	err := s.store.WriteProject(ctx, projectID, func(tx *store.ProjectTx) error {
		if _, err := RequireProjectWrite(ctx, tx, principal); err != nil {
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
		if !mutation.changed {
			result = mutation.current
			return nil
		}
		if mutation.deleted {
			return tx.DeleteTask(ctx, mutation.id, mutation.removeDepends)
		}
		mutation, err = enforceAssignmentTransition(ctx, tx, mutation)
		if err != nil {
			if refusal = taskWriteFault(err); refusal != nil {
				return nil
			}
			return err
		}
		if mutation.create {
			result, err = tx.CreateTask(ctx, mutation.id, mutation.values)
		} else {
			result, err = tx.UpdateTask(ctx, mutation.id, mutation.values)
		}
		return err
	})
	if errors.Is(err, model.ErrNotFound) {
		return model.Task{}, projectNotFound(err)
	}
	if err != nil {
		return model.Task{}, fmt.Errorf("write task: %w", err)
	}
	if refusal != nil {
		return model.Task{}, refusal
	}
	return result, nil
}

func (s *Tasks) versionedWrite(ctx context.Context, principal model.Principal, projectID, id string, version int64, prepare func(*store.ProjectTx, model.Task) (taskMutation, error)) (model.Task, error) {
	projectID, id, err := taskWriteIdentity(principal, projectID, id, version)
	if err != nil {
		return model.Task{}, err
	}
	return s.write(ctx, principal, projectID, func(tx *store.ProjectTx) (taskMutation, error) {
		current, err := tx.Task(ctx, id)
		if errors.Is(err, model.ErrNotFound) {
			return taskMutation{}, taskNotFound(err)
		}
		if err != nil {
			return taskMutation{}, err
		}
		if err := requireTaskVersion(current.Version, version); err != nil {
			return taskMutation{}, err
		}
		worker, err := taskproperties.Worker(current.Properties)
		if err != nil {
			return taskMutation{}, err
		}
		if err := requireCompatibleWorker(ctx, worker); err != nil {
			return taskMutation{}, err
		}
		return prepare(tx, current)
	})
}

func taskCandidate(current model.Task, input UpdateTask) (store.TaskWrite, error) {
	values := currentTaskWrite(current)
	if input.AssignedTo != nil {
		var err error
		values.AssignedTo, err = canonicalAssignedTo(*input.AssignedTo)
		if err != nil {
			return store.TaskWrite{}, err
		}
	}
	if input.RequiredPlatform != nil {
		values.RequiredPlatform = *input.RequiredPlatform
	}
	if input.AllowAgents != nil {
		values.AllowAgents = *input.AllowAgents
	}
	if input.Title != nil {
		values.Title = *input.Title
	}
	if input.Description != nil {
		values.Description = *input.Description
	}
	if input.DependsOn != nil {
		var err error
		values.DependsOn, err = canonicalDependencies(*input.DependsOn, current.ID)
		if err != nil {
			return store.TaskWrite{}, err
		}
		values.ExternalDependsOn = slices.DeleteFunc(slices.Clone(current.ExternalDependsOn), func(id string) bool {
			return !slices.Contains(values.DependsOn, id)
		})
	}
	if input.ExternalDependsOn != nil {
		var err error
		values.ExternalDependsOn, err = canonicalExternalDependencies(*input.ExternalDependsOn, current.ID, values.DependsOn)
		if err != nil {
			return store.TaskWrite{}, err
		}
	}
	properties, err := taskproperties.Normalize(input.Properties, true)
	if err != nil {
		return store.TaskWrite{}, propertyInputFault(err)
	}
	for name, value := range properties {
		values.Properties[name] = value
	}
	if err := validateTaskValues(values); err != nil {
		return store.TaskWrite{}, err
	}
	return values, nil
}

func validateTaskValues(values store.TaskWrite) error {
	if values.RequiredPlatform != nil && !values.RequiredPlatform.Valid() {
		return invalidInput("Execution platform must be windows, linux, macos or null.")
	}
	if strings.TrimSpace(values.Title) == "" || !utf8.ValidString(values.Title) || strings.ContainsRune(values.Title, 0) {
		return invalidInput("Task title must be nonempty UTF-8 text without NUL characters.")
	}
	if !utf8.ValidString(values.Description) || strings.ContainsRune(values.Description, 0) {
		return invalidInput("Task description must be UTF-8 text without NUL characters.")
	}
	return nil
}

func canonicalDependencies(ids []string, self string) ([]string, error) {
	canonical := make([]string, 0, len(ids))
	for _, id := range ids {
		id, err := CanonicalID(id)
		if err != nil {
			return nil, err
		}
		canonical = append(canonical, id)
	}
	slices.Sort(canonical)
	for index, id := range canonical {
		if id == self {
			return nil, &model.Fault{Code: "invalid_input", Message: "Task cannot depend on itself.", TaskIDs: []string{id}}
		}
		if index > 0 && id == canonical[index-1] {
			return nil, &model.Fault{Code: "invalid_input", Message: "Task dependencies must not repeat.", TaskIDs: []string{id}}
		}
	}
	return canonical, nil
}

func taskNotFound(cause error) *model.Fault {
	if errors.Is(cause, model.ErrTaskDeleted) {
		return &model.Fault{Code: "task_deleted", Message: "Task was deleted.", Cause: cause}
	}
	return &model.Fault{Code: "not_found", Message: "Task was not found.", Cause: cause}
}

func canonicalExternalDependencies(ids []string, self string, dependencies []string) ([]string, error) {
	canonical, err := canonicalDependencies(ids, self)
	if err != nil {
		return nil, err
	}
	outside := make([]string, 0)
	for _, id := range canonical {
		if !slices.Contains(dependencies, id) {
			outside = append(outside, id)
		}
	}
	if len(outside) > 0 {
		return nil, &model.Fault{Code: "invalid_input", Message: "External dependencies must belong to the complete dependency set.", TaskIDs: outside}
	}
	return canonical, nil
}
