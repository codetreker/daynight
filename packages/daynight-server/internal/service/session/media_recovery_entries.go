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
type botRecoveryGrantOperation func(context.Context, model.Principal, string, string, sessioncore.BotRecoveryGrant) (sessioncore.BotRecoveryResult, error)

func (s *Service) Grant(ctx context.Context, p model.Principal, project, taskID, id string, g sp.Grant) (sessioncore.GrantResult, error) {
	return s.grantWithMediaRecovery(ctx, p, project, taskID, id, g, s.recoverMediaLeases, s.Execution.Grant)
}
func (s *Service) GrantBot(ctx context.Context, p model.Principal, workerID, id string, g sessioncore.BotGrant) (sessioncore.GrantResult, error) {
	return s.botGrantWithMediaRecovery(ctx, p, workerID, id, g, s.recoverMediaLeases, s.Execution.GrantBot)
}
func (s *Service) TakeoverBot(ctx context.Context, p model.Principal, workerID, id string, g sessioncore.BotRecoveryGrant) (sessioncore.BotRecoveryResult, error) {
	return s.botRecoveryGrantWithMediaRecovery(ctx, p, workerID, id, g, s.recoverMediaLeases, s.Recovery.TakeoverBot)
}
func (s *Service) GrantBotRecovery(ctx context.Context, p model.Principal, workerID, id string, g sessioncore.BotRecoveryGrant) (sessioncore.BotRecoveryResult, error) {
	return s.botRecoveryGrantWithMediaRecovery(ctx, p, workerID, id, g, s.recoverMediaLeases, s.Recovery.GrantBotRecovery)
}

func (s *Service) botRecoveryGrantWithMediaRecovery(ctx context.Context, p model.Principal, workerID, id string, g sessioncore.BotRecoveryGrant, recover func(context.Context) error, run botRecoveryGrantOperation) (out sessioncore.BotRecoveryResult, err error) {
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

func (s *Service) grantWithMediaRecovery(ctx context.Context, p model.Principal, project, taskID, id string, g sp.Grant, recover func(context.Context) error, run grantOperation) (out sessioncore.GrantResult, err error) {
	if g.PreviousGeneration == nil {
		return run(ctx, p, project, taskID, id, g)
	}
	if s.producerAuthorization != nil && project != "" && taskID != "" {
		ctx = context.WithValue(ctx, taskRecoveryAdmissionKey{}, true)
		// Media lease recovery acts outside the grant transaction. Refuse an
		// unauthorized caller before it can trigger recovery, then recheck in
		// the grant's own transaction after the external work finishes.
		if err = s.browserFor(ctx, p, project, taskID, id, sessioncore.ProducerAccess, func(access *sessioncore.Access) error {
			if access.Authority().OwnerID != p.UserID {
				return &model.Fault{Code: "session_conflict", Message: "Session identity or state no longer matches."}
			}
			return nil
		}); err != nil {
			return out, err
		}
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
