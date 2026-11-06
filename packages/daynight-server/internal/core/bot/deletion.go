package bot

import (
	"math"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// RequireDeletionOwner checks the owner after the caller has locked the Bot.
func RequireDeletionOwner(bot model.Bot, principal model.Principal) error {
	if bot.OwnerUserID != principal.UserID {
		return &model.Fault{Code: "forbidden", Message: "Session access is not available."}
	}
	return nil
}

// DeletionRequest checks the original request against the locked Bot.
// A replay must not recreate or downgrade its cleanup obligations.
func DeletionRequest(bot model.Bot, input store.DeleteBot) (bool, error) {
	if bot.Deletion != nil {
		if bot.Deletion.DeletionID != input.DeletionID || bot.Deletion.RequestedVersion != input.Version {
			return false, botConflict("Bot deletion belongs to a different request.")
		}
		return true, nil
	}
	if bot.Version != input.Version {
		return false, &model.Fault{Code: "version_conflict", Message: "Bot version has changed."}
	}
	return false, nil
}

// CheckDeletionVersion runs at the write boundary after Session revocation.
func CheckDeletionVersion(bot model.Bot) error {
	if bot.Version == math.MaxInt64 {
		return &model.Fault{Code: "version_exhausted", Message: "Bot version cannot advance."}
	}
	return nil
}

func NewDeletion(input store.DeleteBot) *model.BotDeletion {
	return &model.BotDeletion{DeletionID: input.DeletionID, RequestedVersion: input.Version, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
}
