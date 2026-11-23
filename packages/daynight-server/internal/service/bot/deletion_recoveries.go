package bot

import (
	"context"
	"errors"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func (s *Bots) DeletionRecoveries(ctx context.Context, p model.Principal, request model.PageRequest) (botcore.DeletionRecoveryPage, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return botcore.DeletionRecoveryPage{}, err
	}
	page, err := botcore.DeletionRecoveryListPage(p, request)
	if err != nil {
		return botcore.DeletionRecoveryPage{}, err
	}
	result := botcore.DeletionRecoveryPage{Items: []botcore.DeletionRecovery{}}
	err = s.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		records, err := botcore.ListDeletionRecoveries(ctx, scope, p, page, func() error { return s.readAdmission(ctx, scope, p, scopepolicy.BotRead) })
		if err != nil {
			return err
		}
		for _, bot := range records.Items {
			if err := botcore.RequireDeletionOwner(bot, p); err != nil {
				return err
			}
			var binding *model.BotDeletionBinding
			if bot.Deletion == nil {
				return errors.New("Bot deletion recovery list included an active Bot")
			}
			if bot.Deletion.Recovery == nil && bot.SessionID != nil {
				reader, ok := scope.BotDAO().(store.BotDeletionBindingReader)
				if !ok {
					return errors.New("Bot deletion binding reader is unavailable")
				}
				snapshot, err := reader.BotDeletionBinding(ctx, p.UserID, bot.ID)
				if err != nil {
					return err
				}
				binding, err = botcore.DeletionBinding(bot, &snapshot)
				if err != nil {
					return err
				}
			}
			item, err := botcore.ProjectDeletionRecovery(bot, binding)
			if err != nil {
				return err
			}
			result.Items = append(result.Items, item)
		}
		result.NextCursor, err = botcore.DeletionRecoveryListCursor(p, records)
		return err
	})
	if err != nil {
		return botcore.DeletionRecoveryPage{}, definitionResultError("deletion-recoveries", err)
	}
	return result, nil
}
