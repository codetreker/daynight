package bot

import (
	"context"
	"errors"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func (s *Bots) DeletionRecovery(ctx context.Context, p model.Principal, id string) (botcore.DeletionRecovery, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return botcore.DeletionRecovery{}, err
	}
	id, err := model.CanonicalID(id)
	if err != nil {
		return botcore.DeletionRecovery{}, err
	}
	var result botcore.DeletionRecovery
	err = s.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		bot, err := s.operations.get(ctx, scope, p, id)
		if err != nil {
			return err
		}
		if err = s.readAdmission(ctx, scope, p, scopepolicy.BotRead); err != nil {
			return err
		}
		if bot.Deletion == nil {
			_, err = botcore.ProjectDeletionRecovery(bot, nil)
			return err
		}
		var binding *model.BotDeletionBinding
		if bot.Deletion.Recovery == nil && bot.SessionID != nil {
			reader, ok := scope.BotDAO().(store.BotDeletionBindingReader)
			if !ok {
				return errors.New("Bot deletion binding reader is unavailable")
			}
			snapshot, err := reader.BotDeletionBinding(ctx, p.UserID, id)
			if err != nil {
				return err
			}
			binding, err = botcore.DeletionBinding(bot, &snapshot)
			if err != nil {
				return err
			}
		}
		result, err = botcore.ProjectDeletionRecovery(bot, binding)
		return err
	})
	if err != nil {
		return botcore.DeletionRecovery{}, definitionResultError("deletion-recovery", err)
	}
	return result, nil
}

// ResolveDeletion commits the owner decision and original binding before any
// physical cleanup. A lost response is reconciled through DeletionRecovery.
func (s *Deletions) ResolveDeletion(ctx context.Context, p model.Principal, id string, input botcore.ResolveDeletion) (botcore.DeletionRecovery, error) {
	if !deletionID(id) {
		return botcore.DeletionRecovery{}, deletionFault("invalid_input", "Invalid Bot ID.")
	}
	if err := botcore.ValidateDeletionResolution(input); err != nil {
		return botcore.DeletionRecovery{}, err
	}
	var out model.Bot
	var replay bool
	completion, err := s.writer.WriteSession(ctx, func(scope store.SessionScope) error {
		var authorization model.CredentialAuthorization
		var authorizationErr error
		if s.authorization != nil {
			authorization, authorizationErr = s.authorization.SessionWrite(ctx, scope, p)
		}
		bot, err := s.lockBot(ctx, scope, p, id)
		if err != nil {
			return err
		}
		if s.authorization != nil {
			if err = requireDefinition(p, authorization, authorizationErr, scopepolicy.BotDelete, scopepolicy.BotRead); err != nil {
				return err
			}
		}
		replay, err = botcore.CheckDeletionResolution(bot, input)
		if err != nil {
			return err
		}
		if replay {
			out = bot
			return s.credential(ctx, scope.SessionDAO(), p)
		}
		var binding *model.BotDeletionBinding
		if input.Action == "accept_unverified" {
			var snapshot *sp.Snapshot
			if bot.SessionID != nil {
				proof, err := scope.SessionDAO().LockBotSessionStop(ctx, *bot.SessionID, bot.ID, bot.OwnerUserID)
				if err != nil {
					return err
				}
				snapshot = &proof.Snapshot
			}
			binding, err = botcore.DeletionBinding(bot, snapshot)
			if err != nil {
				return err
			}
		}
		botcore.ApplyDeletionResolution(&bot, input, binding, s.now())
		out, err = s.operations.save(ctx, scope.BotDAO(), bot)
		if err != nil {
			return err
		}
		return s.credential(ctx, scope.SessionDAO(), p)
	})
	if err != nil {
		return botcore.DeletionRecovery{}, deletionResultError(err)
	}
	if completion.Outcome != store.TransactionCommitted {
		return botcore.DeletionRecovery{}, errors.New("Bot deletion recovery commit was not confirmed")
	}
	if !replay {
		out, err = s.clean(ctx, p, id, input.DeletionID)
		if err != nil {
			return botcore.DeletionRecovery{}, &DeletionCleanupError{Cause: err}
		}
	}
	return botcore.ProjectDeletionRecovery(out, nil)
}
