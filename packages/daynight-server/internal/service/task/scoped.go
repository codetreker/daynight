package task

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

// Scoped copies retain request-local authorization without mutating shared services.
func NewScopedTasks(app *Tasks, a model.CredentialAuthorization) *Tasks {
	copy := *app
	copy.authorization = &a
	return &copy
}

func NewScopedObservations(app *Observations, a model.CredentialAuthorization) *Observations {
	copy := *app
	copy.authorization = &a
	return &copy
}

func NewScopedTaskSync(app *TaskSync, a model.CredentialAuthorization) *TaskSync {
	copy := *app
	copy.authorization = &a
	return &copy
}

func requireTaskScope(a *model.CredentialAuthorization, principal model.Principal, operations ...scopepolicy.Operation) error {
	if a == nil {
		return nil
	}
	return taskcore.RequireReadAuthorization(*a, principal, operations...)
}

func sessionProjectionAllowed(a *model.CredentialAuthorization) bool {
	return a == nil || scopeadmission.Require(*a, scopepolicy.SessionRead) == nil
}

func (s *Tasks) requireRead(ctx context.Context, reader projectcore.ProjectAccessReader, principal model.Principal, id string) (model.ProjectAccess, error) {
	access, err := s.listOperations.requireProjectRead(ctx, reader, principal, id)
	if err != nil {
		return access, err
	}
	return access, requireTaskScope(s.authorization, principal)
}

func (s *Tasks) projectTask(task model.Task) model.Task {
	if !sessionProjectionAllowed(s.authorization) {
		return taskcore.WithoutSessionProperties(task)
	}
	return task
}

func (s *Observations) loadSources(ctx context.Context, snapshot store.SnapshotScope, id string, tasks []model.Task) (store.SnapshotScope, error) {
	return s.loadExecutionSources(ctx, snapshot, id, taskExecutionIdentities(tasks))
}

func (s *Observations) loadExecutionSources(ctx context.Context, snapshot store.SnapshotScope, id string, tasks []executionIdentity) (store.SnapshotScope, error) {
	if !sessionProjectionAllowed(s.authorization) {
		return nil, nil
	}
	return loadSelectedExecutionSources(ctx, snapshot, id, tasks)
}

func (s *Observations) projectTask(task model.Task) model.Task {
	if !sessionProjectionAllowed(s.authorization) {
		return taskcore.WithoutSessionProperties(task)
	}
	return task
}

// CurrentReadAuthorization binds delayed response rechecks to their fresh snapshot.
type CurrentReadAuthorization func(context.Context, store.SnapshotScope, model.Principal) (model.CredentialAuthorization, error)

func WithCurrentObservationAuthorization(app *Observations, current CurrentReadAuthorization) *Observations {
	if current == nil {
		panic("current observation authorization is required")
	}
	copy := *app
	copy.currentAuthorization = current
	return &copy
}
func WithCurrentSyncAuthorization(app *TaskSync, current CurrentReadAuthorization) *TaskSync {
	if current == nil {
		panic("current sync authorization is required")
	}
	copy := *app
	copy.currentAuthorization = current
	return &copy
}
func requireCurrentReadScope(ctx context.Context, snapshot store.SnapshotScope, p model.Principal, original *model.CredentialAuthorization, current CurrentReadAuthorization, operations ...scopepolicy.Operation) error {
	if original == nil || current == nil {
		return requireTaskScope(original, p, operations...)
	}
	a, err := current(ctx, snapshot, p)
	if err != nil {
		return err
	}
	if a.Principal != p || a.Profile != original.Profile {
		return model.Unauthenticated(nil)
	}
	if sessionProjectionAllowed(original) {
		operations = append(operations, scopepolicy.SessionRead)
	}
	return requireTaskScope(&a, p, operations...)
}
