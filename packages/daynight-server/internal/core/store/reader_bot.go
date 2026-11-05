package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type BotReader interface {
	Bot(context.Context, string) (model.Bot, error)
	Bots(context.Context, string, *string, Page) (BotPage, error)
	BotWorker(context.Context, string, string) error
	BotDefaults(context.Context, string) (model.BotDefaultsInput, error)
}
