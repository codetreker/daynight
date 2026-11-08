package store

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type BotPage struct {
	Items          []model.Bot
	HasMore        bool
	OversizedBotID string
}
