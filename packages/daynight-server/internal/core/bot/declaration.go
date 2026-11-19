package bot

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const nilID = "00000000-0000-0000-0000-000000000000"

// AdmitDeclaredBot verifies a Bot identity that an authenticated request
// declares for its own user. The declaration attributes the write; it does not
// authorize it. An absent, foreign or deleted Bot is refused alike, so the
// response does not reveal other users' Bots. The barrier stays held until the
// caller's transaction ends.
func AdmitDeclaredBot(ctx context.Context, dao store.BotBarrierDAO, ownerUserID, botID string) error {
	if id, err := model.CanonicalID(botID); err != nil || id != botID || id == nilID {
		return &model.Fault{Code: "invalid_input", Message: "Bot ID must be a canonical nonzero UUID."}
	}
	bot, err := dao.Bot(ctx, botID)
	if errors.Is(err, model.ErrNotFound) {
		return declaredBotForbidden()
	}
	if err != nil {
		return err
	}
	if bot.OwnerUserID != ownerUserID || bot.Deletion != nil {
		return declaredBotForbidden()
	}
	return nil
}

func declaredBotForbidden() error {
	return &model.Fault{Code: "forbidden", Message: "The declared Bot is not available to this credential."}
}
