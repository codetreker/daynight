package runtime

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// Runtime coordinates the Bot credential, definition and bound Session in a
// single transaction. Bot locks always precede the associated Session lock.
type Runtime struct {
	engine *sessioncore.Engine
	write  sessioncore.TransactionRunner
}

func NewRuntime(engine *sessioncore.Engine, write sessioncore.TransactionRunner) *Runtime {
	return &Runtime{engine: engine, write: write}
}

func (s *Runtime) Run(ctx context.Context, p model.Principal, workerID, id string, prepare func(model.Bot) error, check func(model.Bot, *sessioncore.Access) error, work func(*sessioncore.Operation, store.SessionScope, model.Bot, *sessioncore.Access, func(model.Principal) error) error) error {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	return s.write(ctx, op, func(scope store.SessionScope) error {
		if p.Kind != model.PATCredential {
			return &model.Fault{Code: "forbidden", Message: "Session access is not available."}
		}
		if err := op.LockCredential(ctx, scope, p); err != nil {
			return err
		}
		bot, err := scope.BotDAO().Bot(ctx, id)
		if errors.Is(err, model.ErrNotFound) {
			return &model.Fault{Code: "not_found", Message: "Bot was not found."}
		}
		if err != nil {
			return err
		}
		if bot.OwnerUserID != p.UserID || bot.WorkerID != workerID {
			return &model.Fault{Code: "forbidden", Message: "Session access is not available."}
		}
		if bot.Deletion != nil {
			return &model.Fault{Code: "resource_conflict", Message: "Bot is deleted."}
		}
		if prepare != nil {
			if err = prepare(bot); err != nil {
				return err
			}
		}
		var access *sessioncore.Access
		if bot.SessionID != nil {
			if err = op.CheckBot(*bot.SessionID, &bot); err != nil {
				return err
			}
			access, err = op.Load(ctx, scope, *bot.SessionID, &bot)
			if err != nil {
				return err
			}
			if check != nil {
				if err = check(bot, access); err != nil {
					return err
				}
			}
			if err = op.LockCredential(ctx, scope, p); err != nil {
				return err
			}
			if err = op.CheckTestOwner(access, p); err != nil {
				return err
			}
			authority := access.Authority()
			if authority.ParentCredentialID != "" {
				parent := model.Principal{Kind: model.PATCredential, UserID: authority.OwnerID, CredentialID: authority.ParentCredentialID}
				if err = op.LockCredential(ctx, scope, parent); err != nil {
					return err
				}
			}
		}
		return work(op, scope, bot, access, func(principal model.Principal) error { return op.LockCredential(ctx, scope, principal) })
	})
}
