package session

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func (s *Service) taskQuery(ctx context.Context, principal model.Principal, project, taskID string, work func(*sessioncore.Operation, store.SessionScope, *sessioncore.TaskAccess, func(string) (*sessioncore.Access, error)) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op.Finish, func(scope store.SessionScope) error {
		task, err := op.LockTask(ctx, scope, project, taskID)
		if err != nil {
			return err
		}
		if err = op.LockCredential(ctx, scope, principal); err != nil {
			return err
		}
		if err = op.CheckProjectAccess(ctx, scope, principal, project); err != nil {
			return err
		}
		load := func(id string) (*sessioncore.Access, error) { return loadSession(ctx, op, scope, id) }
		return work(op, scope, task, load)
	})
}

func (s *Service) credential(ctx context.Context, principal model.Principal, work func(*sessioncore.Operation, store.SessionScope) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op.Finish, func(scope store.SessionScope) error {
		if err := op.LockCredential(ctx, scope, principal); err != nil {
			return err
		}
		return work(op, scope)
	})
}

func (s *Service) authorize(ctx context.Context, op *sessioncore.Operation, scope store.SessionScope, p model.Principal, authority sessioncore.Authority) error {
	if err := op.LockPurposeCredential(ctx, scope, p, authority.Purpose); err != nil {
		return err
	}
	if !authority.Test {
		return op.CheckProjectAccess(ctx, scope, p, authority.ProjectID)
	}
	if p.UserID != authority.OwnerID {
		return &model.Fault{Code: "forbidden", Message: "Session access is not available."}
	}
	if authority.ParentCredentialID != "" {
		parent := model.Principal{Kind: model.PATCredential, UserID: authority.OwnerID, CredentialID: authority.ParentCredentialID}
		if err := op.LockCredential(ctx, scope, parent); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) registerTerminal(ctx context.Context, principal model.Principal, project, taskID string, work func(*sessioncore.Operation, store.SessionScope, *sessioncore.TaskAccess) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op.Finish, func(scope store.SessionScope) error {
		task, err := op.LockRegistrationTask(ctx, scope, project, taskID)
		if err != nil {
			return err
		}
		if err = op.LockCredential(ctx, scope, principal); err != nil {
			return err
		}
		if err = op.CheckProjectAccess(ctx, scope, principal, project); err != nil {
			return err
		}
		return work(op, scope, task)
	})
}
