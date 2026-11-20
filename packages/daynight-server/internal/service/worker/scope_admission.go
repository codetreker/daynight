package worker

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// AuthorizationSource reads current credential facts in the supplied scope.
// WorkerWrite holds the credential policy lock until the report/configuration
// transaction completes; OAuth locks the grant before its access credential.
type AuthorizationSource interface {
	Read(context.Context, store.SnapshotScope, model.Principal) (model.CredentialAuthorization, error)
	WorkerWrite(context.Context, store.WorkerScope, model.Principal) (model.CredentialAuthorization, error)
	PromptRead(context.Context, store.PromptSnapshot, model.Principal) (model.CredentialAuthorization, error)
}

// NewScopedWorkers installs current-policy admission without changing legacy assembly.
func NewScopedWorkers(database workerStore, authorization AuthorizationSource) (*Workers, error) {
	if authorization == nil {
		return nil, errors.New("worker authorization source is required")
	}
	workers := NewWorkers(database)
	workers.authorization = authorization
	return workers, nil
}

func (s *Workers) ScopesEnabled() bool { return s.authorization != nil }

func NewScopedWorkersWithPrompts(database workerStore, prompts store.PromptSnapshotReader, authorization AuthorizationSource) (*Workers, error) {
	workers, err := NewScopedWorkers(database, authorization)
	if err != nil {
		return nil, err
	}
	if prompts == nil {
		return nil, errors.New("worker prompt snapshot reader is required")
	}
	workers.prompts = prompts
	return workers, nil
}

func requireAuthorization(principal model.Principal, authorization model.CredentialAuthorization, err error, operations ...scopepolicy.Operation) error {
	if err != nil {
		return err
	}
	if authorization.Principal != principal {
		return errors.New("worker authorization principal mismatch")
	}
	return scopeadmission.Require(authorization, operations...)
}

func (s *Workers) readAdmission(ctx context.Context, scope store.SnapshotScope, principal model.Principal, operations ...scopepolicy.Operation) error {
	if s.authorization == nil {
		return nil
	}
	authorization, err := s.authorization.Read(ctx, scope, principal)
	return requireAuthorization(principal, authorization, err, operations...)
}

func (s *Workers) writeAdmission(ctx context.Context, scope store.WorkerScope, principal model.Principal, operations ...scopepolicy.Operation) error {
	if s.authorization == nil {
		return nil
	}
	authorization, err := s.authorization.WorkerWrite(ctx, scope, principal)
	return requireAuthorization(principal, authorization, err, operations...)
}

func (s *Workers) reportAdmission(ctx context.Context, scope store.WorkerScope, principal model.Principal, configuration bool) (*model.CredentialAuthorization, error) {
	if s.authorization == nil {
		return nil, nil
	}
	authorization, err := s.authorization.WorkerWrite(ctx, scope, principal)
	operations := []scopepolicy.Operation{scopepolicy.WorkerReport}
	if configuration {
		operations = append(operations, scopepolicy.WorkerRead)
	}
	if err := requireAuthorization(principal, authorization, err, operations...); err != nil {
		return nil, err
	}
	return &authorization, nil
}

type authorizedPromptReader struct {
	reader        store.PromptSnapshotReader
	authorization AuthorizationSource
	principal     model.Principal
}

func (r authorizedPromptReader) ReadPromptSnapshot(ctx context.Context, operation func(store.PromptSnapshot) error) error {
	return r.reader.ReadPromptSnapshot(ctx, func(snapshot store.PromptSnapshot) error {
		authorization, err := r.authorization.PromptRead(ctx, snapshot, r.principal)
		if err := requireAuthorization(r.principal, authorization, err, scopepolicy.PromptRead); err != nil {
			return err
		}
		return operation(snapshot)
	})
}
