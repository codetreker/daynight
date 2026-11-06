package task

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// Mutation is a Task candidate prepared while its Project write lock is held.
type Mutation struct {
	ID            string
	Current       model.Task
	Values        store.TaskWrite
	Create        bool
	Changed       bool
	Delete        bool
	RemoveDepends bool
}

func PrepareCreate(ctx context.Context, dao store.TaskWriteDAO, id string, values store.TaskWrite) (Mutation, error) {
	if err := ValidateCandidate(ctx, dao, id, values); err != nil {
		return Mutation{}, err
	}
	return Mutation{ID: id, Values: values, Create: true, Changed: true}, nil
}

func PrepareUpdate(ctx context.Context, dao store.TaskWriteDAO, id string, input UpdateTask) (Mutation, error) {
	current, err := dao.Task(ctx, id)
	if errors.Is(err, model.ErrNotFound) {
		return Mutation{}, NotFound(err)
	}
	if err != nil {
		return Mutation{}, err
	}
	if err := RequireVersion(current.Version, input.Version); err != nil {
		return Mutation{}, err
	}
	worker, err := taskproperty.Worker(current.Properties)
	if err != nil {
		return Mutation{}, err
	}
	if err := RequireCompatibleWorker(ctx, worker); err != nil {
		return Mutation{}, err
	}
	values, err := UpdateCandidate(current, input)
	if err != nil {
		return Mutation{}, err
	}
	if err := ValidateUpdate(current, values); err != nil {
		return Mutation{}, err
	}
	if err := ValidateCandidate(ctx, dao, id, values); err != nil {
		return Mutation{}, err
	}
	return Mutation{ID: id, Current: current, Values: values, Changed: Changed(current, values)}, nil
}

func PrepareStatus(ctx context.Context, dao store.TaskWriteDAO, principal model.Principal, id string, input SetTaskStatus) (Mutation, error) {
	current, err := dao.Task(ctx, id)
	if errors.Is(err, model.ErrNotFound) {
		return Mutation{}, NotFound(err)
	}
	if err != nil {
		return Mutation{}, err
	}
	if err := RequireVersion(current.Version, input.Version); err != nil {
		return Mutation{}, err
	}
	worker, err := taskproperty.Worker(current.Properties)
	if err != nil {
		return Mutation{}, err
	}
	if err := RequireCompatibleWorker(ctx, worker); err != nil {
		return Mutation{}, err
	}
	values, changed, err := StatusCandidate(ctx, dao, principal, current, input, worker)
	if err != nil {
		return Mutation{}, err
	}
	return Mutation{ID: id, Current: current, Values: values, Changed: changed}, nil
}

func PrepareDelete(ctx context.Context, dao store.TaskWriteDAO, current model.Task, removeDepends bool) (Mutation, error) {
	if err := ValidateDelete(ctx, dao, current, removeDepends); err != nil {
		return Mutation{}, err
	}
	return Mutation{ID: current.ID, Current: current, Changed: true, Delete: true, RemoveDepends: removeDepends}, nil
}

// ApplyMutation performs only the Task write; callers coordinate other domain
// effects in the same scope before its transaction completes.
func ApplyMutation(ctx context.Context, dao store.TaskWriteDAO, mutation Mutation) (model.Task, error) {
	if !mutation.Changed {
		return mutation.Current, nil
	}
	if mutation.Delete {
		return model.Task{}, dao.DeleteTask(ctx, mutation.ID, mutation.RemoveDepends)
	}
	if mutation.Create {
		return dao.CreateTask(ctx, mutation.ID, mutation.Values)
	}
	return dao.UpdateTask(ctx, mutation.ID, mutation.Values)
}
