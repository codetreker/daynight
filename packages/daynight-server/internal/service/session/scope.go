package session

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// loadSession acquires the Bot before the Session when a binding exists.
func loadSession(ctx context.Context, op *sessioncore.Operation, scope store.SessionScope, id string) (*sessioncore.Access, error) {
	botID, err := scope.SessionDAO().SessionBotID(ctx, id)
	if err != nil {
		if errors.Is(err, model.ErrNotFound) {
			op.MissingSession(id)
		}
		return nil, err
	}
	var bot *model.Bot
	if botID != nil {
		value, err := scope.BotDAO().Bot(ctx, *botID)
		if err != nil {
			if errors.Is(err, model.ErrNotFound) {
				op.MissingSession(id)
				return nil, &model.Fault{Code: "not_found", Message: "Bot was not found."}
			}
			return nil, err
		}
		bot = &value
		if err := op.CheckBot(id, bot); err != nil {
			return nil, err
		}
	}
	return op.Load(ctx, scope, id, bot)
}

func authorizeTest(ctx context.Context, op *sessioncore.Operation, scope store.SessionScope, p model.Principal, access *sessioncore.Access) error {
	if err := op.LockCredential(ctx, scope, p); err != nil {
		return err
	}
	if err := op.CheckTestOwner(access, p); err != nil {
		return err
	}
	authority := access.Authority()
	if authority.ParentCredentialID != "" {
		parent := model.Principal{Kind: model.PATCredential, UserID: authority.OwnerID, CredentialID: authority.ParentCredentialID}
		if err := op.LockCredential(ctx, scope, parent); err != nil {
			return err
		}
	}
	return nil
}

// browser selects a Task or independent Test Session while retaining the
// original database lock order and one transaction for admission and work.
func (s *Service) browser(ctx context.Context, principal model.Principal, project, taskID, id string, work func(*sessioncore.Access) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		if project == "" && taskID == "" {
			access, err := loadSession(ctx, op, scope, id)
			if err != nil {
				return err
			}
			if err = op.CheckTestScope(access); err != nil {
				return err
			}
			if err = authorizeTest(ctx, op, scope, principal, access); err != nil {
				return err
			}
			if err = op.BindTestBrowser(ctx, access); err != nil {
				return err
			}
			return work(access)
		}
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
		access, err := loadSession(ctx, op, scope, id)
		if err != nil {
			return err
		}
		if err = op.BindTaskBrowser(ctx, access, task, principal, project, taskID); err != nil {
			return err
		}
		return work(access)
	})
}

// controller revalidates the current owner and connection fence in the same
// transaction as the requested operation.
func (s *Service) controller(ctx context.Context, fence sp.ControllerFence, work func(*sessioncore.Access) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		location, err := scope.SessionDAO().SessionLocation(ctx, fence.SessionID)
		if err != nil {
			if errors.Is(err, model.ErrNotFound) {
				op.MissingSession(fence.SessionID)
			}
			return err
		}
		task, err := op.LockTask(ctx, scope, location.ProjectID, location.TaskID)
		if err != nil {
			return err
		}
		access, err := loadSession(ctx, op, scope, fence.SessionID)
		if err != nil {
			return err
		}
		authority := access.Authority()
		owner := model.Principal{Kind: model.PATCredential, UserID: authority.OwnerID, CredentialID: authority.ConnectionCredentialID}
		if authority.Test {
			if err = authorizeTest(ctx, op, scope, owner, access); err != nil {
				return err
			}
		} else {
			if err = op.LockCredential(ctx, scope, owner); err != nil {
				return err
			}
			if err = op.CheckProjectAccess(ctx, scope, owner, authority.ProjectID); err != nil {
				return err
			}
		}
		if err = op.BindController(access, task, fence); err != nil {
			return err
		}
		return work(access)
	})
}
