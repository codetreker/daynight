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
// authorize it. OAuth credentials act for delegated third-party clients and
// cannot speak as the user's Bots, matching assistant tasks, so they are
// refused before the barrier is taken. The barrier stays held until the
// caller's transaction ends.
func AdmitDeclaredBot(ctx context.Context, dao store.BotBarrierDAO, principal model.Principal, botID string) error {
	if principal.Kind == model.OAuthCredential {
		return unavailableBot()
	}
	return RequireOwnedBot(ctx, dao, principal.UserID, botID)
}

// RequireOwnedBot verifies that botID names a live Bot owned by ownerUserID.
// An absent, foreign or deleted Bot is refused alike, so the response does not
// reveal other users' Bots.
func RequireOwnedBot(ctx context.Context, dao store.BotBarrierDAO, ownerUserID, botID string) error {
	if id, err := model.CanonicalID(botID); err != nil || id != botID || id == nilID {
		return &model.Fault{Code: "invalid_input", Message: "Bot ID must be a canonical nonzero UUID."}
	}
	bot, err := dao.Bot(ctx, botID)
	if errors.Is(err, model.ErrNotFound) {
		return unavailableBot()
	}
	if err != nil {
		return err
	}
	if bot.OwnerUserID != ownerUserID || bot.Deletion != nil {
		return unavailableBot()
	}
	return nil
}

func unavailableBot() error {
	return &model.Fault{Code: "forbidden", Message: "The Bot is not available to this credential."}
}
