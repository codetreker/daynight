package session

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func (s *Service) taskQuery(ctx context.Context, principal model.Principal, project, taskID string, work func(*sessioncore.Operation, store.SessionScope, *sessioncore.TaskAccess, bool, func(string) (*sessioncore.Access, error)) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		task, err := op.LockTask(ctx, scope, project, taskID)
		if err != nil {
			return err
		}
		if err = op.LockCredential(ctx, scope, principal); err != nil {
			return err
		}
		admin, err := op.ProjectAdmin(ctx, scope, principal, project)
		if err != nil {
			return err
		}
		load := func(id string) (*sessioncore.Access, error) { return loadSession(ctx, op, scope, id) }
		return work(op, scope, task, admin, load)
	})
}

func (s *Service) credential(ctx context.Context, principal model.Principal, work func(*sessioncore.Operation, store.SessionScope) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		if err := op.LockCredential(ctx, scope, principal); err != nil {
			return err
		}
		return work(op, scope)
	})
}

func (s *Service) authorize(ctx context.Context, op *sessioncore.Operation, scope store.SessionScope, p model.Principal, authority sessioncore.Authority) (bool, error) {
	if err := op.LockCredential(ctx, scope, p); err != nil {
		return false, err
	}
	if !authority.Test {
		return op.ProjectAdmin(ctx, scope, p, authority.ProjectID)
	}
	if p.UserID != authority.OwnerID {
		return false, &model.Fault{Code: "forbidden", Message: "Session access is not available."}
	}
	if authority.ParentCredentialID != "" {
		parent := model.Principal{Kind: model.PATCredential, UserID: authority.OwnerID, CredentialID: authority.ParentCredentialID}
		if err := op.LockCredential(ctx, scope, parent); err != nil {
			return false, err
		}
	}
	return true, nil
}

func (s *Service) registerTerminal(ctx context.Context, principal model.Principal, project, taskID string, work func(*sessioncore.Operation, store.SessionScope, *sessioncore.TaskAccess) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		if err := scope.SessionDAO().LockTaskRegistration(ctx, project, taskID); err != nil {
			return err
		}
		task, err := op.LockTask(ctx, scope, project, taskID)
		if err != nil {
			return err
		}
		if err = op.LockCredential(ctx, scope, principal); err != nil {
			return err
		}
		if _, err = op.ProjectAdmin(ctx, scope, principal, project); err != nil {
			return err
		}
		return work(op, scope, task)
	})
}
