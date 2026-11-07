package session

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// archive retains Task-before-Session locking and the original owner's ability
// to finish an archive after Task deletion.
func (s *Service) archive(ctx context.Context, principal model.Principal, project, taskID, id string, finalize bool, work func(*sessioncore.Access) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		task, deleted, err := op.LockArchiveTask(ctx, scope, project, taskID, finalize)
		if err != nil {
			return err
		}
		if project != "" {
			if err = op.LockCredential(ctx, scope, principal); err != nil {
				return err
			}
			if err = op.CheckProjectAccess(ctx, scope, principal, project); err != nil {
				return err
			}
		}
		access, err := loadSession(ctx, op, scope, id)
		if err != nil {
			return err
		}
		if err = op.BindArchive(access, task, principal, project, taskID, deleted); err != nil {
			return err
		}
		if project == "" {
			if err = authorizeTest(ctx, op, scope, principal, access); err != nil {
				return err
			}
		}
		return work(access)
	})
}

func (s *Service) terminal(ctx context.Context, principal model.Principal, project, taskID, id string, finalize bool, work func(*sessioncore.TerminalAccess) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		task, deleted, err := op.LockArchiveTask(ctx, scope, project, taskID, finalize)
		if err != nil {
			return err
		}
		if err = op.LockCredential(ctx, scope, principal); err != nil {
			return err
		}
		if err = op.CheckProjectAccess(ctx, scope, principal, project); err != nil {
			return err
		}
		access, err := op.LoadTerminal(ctx, scope, id)
		if err != nil {
			return err
		}
		if err = op.BindTerminal(access, task, principal, project, taskID, deleted); err != nil {
			return err
		}
		return work(access)
	})
}
