package session

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type archivePreflightOperation func(*sessioncore.Operation, context.Context, store.SessionScope, model.Principal, string, string, string, sessioncore.ArchiveMode) (string, error)

type grantOperation func(context.Context, model.Principal, string, string, string, sp.Grant) (sessioncore.GrantResult, error)
type botGrantOperation func(context.Context, model.Principal, string, string, sessioncore.BotGrant) (sessioncore.GrantResult, error)

func (s *Service) Grant(ctx context.Context, p model.Principal, project, taskID, id string, g sp.Grant) (sessioncore.GrantResult, error) {
	return s.grantWithMediaRecovery(ctx, p, project, taskID, id, g, s.recoverMediaLeases, s.Execution.Grant)
}
func (s *Service) GrantBot(ctx context.Context, p model.Principal, workerID, id string, g sessioncore.BotGrant) (sessioncore.GrantResult, error) {
	return s.botGrantWithMediaRecovery(ctx, p, workerID, id, g, s.recoverMediaLeases, s.Execution.GrantBot)
}

func (s *Service) grantWithMediaRecovery(ctx context.Context, p model.Principal, project, taskID, id string, g sp.Grant, recover func(context.Context) error, run grantOperation) (out sessioncore.GrantResult, err error) {
	if g.PreviousGeneration == nil {
		return run(ctx, p, project, taskID, id, g)
	}
	err = s.afterMediaRecovery(ctx, recover, func(ctx context.Context) error {
		var e error
		out, e = run(ctx, p, project, taskID, id, g)
		return e
	})
	return out, err
}
func (s *Service) botGrantWithMediaRecovery(ctx context.Context, p model.Principal, workerID, id string, g sessioncore.BotGrant, recover func(context.Context) error, run botGrantOperation) (out sessioncore.GrantResult, err error) {
	if g.Grant.PreviousGeneration == nil {
		return run(ctx, p, workerID, id, g)
	}
	err = s.afterMediaRecovery(ctx, recover, func(ctx context.Context) error {
		var e error
		out, e = run(ctx, p, workerID, id, g)
		return e
	})
	return out, err
}

// Recovery must finish outside the grant/archive transaction while retaining an
// admitted operation, so shutdown cancels it before shared resources can close.
func (s *Service) afterMediaRecovery(ctx context.Context, recover func(context.Context) error, run func(context.Context) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	ctx, cancel := mediaRecoveryContext(ctx, op)
	defer cancel()
	if err = recover(ctx); err != nil {
		return err
	}
	return run(ctx)
}
func mediaRecoveryContext(parent context.Context, op *sessioncore.Operation) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	go func() {
		select {
		case <-op.Stopping():
			cancel()
		case <-ctx.Done():
		}
	}()
	return ctx, cancel
}
