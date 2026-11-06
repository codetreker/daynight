package session

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func (s *Service) registerTask(ctx context.Context, p model.Principal, project, taskID string, input sp.Registration, work func(*sessioncore.Operation, store.SessionScope, *sessioncore.Access) error) error {
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
		if err = op.LockCredential(ctx, scope, p); err != nil {
			return err
		}
		if _, err = op.ProjectAdmin(ctx, scope, p, project); err != nil {
			return err
		}
		if err = op.CheckRegistration(task, p, input); err != nil {
			return err
		}
		id, err := scope.SessionDAO().FindTaskRegistration(ctx, project, input.RegistrationID, taskID, input.ClaimID)
		if errors.Is(err, model.ErrNotFound) {
			return work(op, scope, nil)
		}
		if err != nil {
			return err
		}
		access, err := loadSession(ctx, op, scope, id)
		if err != nil {
			return err
		}
		return work(op, scope, access)
	})
}

func (s *Service) registerTest(ctx context.Context, p model.Principal, input sp.TestRegistration, work func(*sessioncore.Operation, store.SessionScope, *sessioncore.Access) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		if err := op.LockCredential(ctx, scope, p); err != nil {
			return err
		}
		if err := scope.SessionDAO().LockTestOwner(ctx, p.UserID); err != nil {
			return err
		}
		id, botID, err := scope.SessionDAO().FindTestRegistration(ctx, p.UserID, input.RegistrationID, input.TestExecutionID)
		if errors.Is(err, model.ErrNotFound) {
			return work(op, scope, nil)
		}
		if err != nil {
			return err
		}
		if botID != nil {
			return &model.Fault{Code: "forbidden", Message: "Session access is not available."}
		}
		access, err := loadSession(ctx, op, scope, id)
		if err != nil {
			return err
		}
		if err = op.CheckTestRegistration(access, input); err != nil {
			return err
		}
		if err = authorizeTest(ctx, op, scope, p, access); err != nil {
			return err
		}
		return work(op, scope, access)
	})
}

func (s *Service) controllerGrant(ctx context.Context, hash []byte, work func(*sessioncore.Access) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		location, err := scope.SessionDAO().SessionLocationByGrant(ctx, hash)
		if errors.Is(err, model.ErrNotFound) {
			return &model.Fault{Code: "forbidden", Message: "Session access is not available."}
		}
		if err != nil {
			return err
		}
		task, err := op.LockTask(ctx, scope, location.ProjectID, location.TaskID)
		if err != nil {
			return err
		}
		access, err := loadSession(ctx, op, scope, location.SessionID)
		if err != nil {
			return err
		}
		authority := access.Authority()
		parent := model.Principal{Kind: model.PATCredential, UserID: authority.OwnerID, CredentialID: authority.ParentCredentialID}
		if authority.Test {
			if err = authorizeTest(ctx, op, scope, parent, access); err != nil {
				return err
			}
		} else {
			if err = op.LockCredential(ctx, scope, parent); err != nil {
				return err
			}
			if _, err = op.ProjectAdmin(ctx, scope, parent, authority.ProjectID); err != nil {
				return err
			}
		}
		if err = op.BindControllerGrant(access, task, hash); err != nil {
			return err
		}
		return work(access)
	})
}
