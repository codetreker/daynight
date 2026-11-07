package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type BotReader interface {
	BotCreationReader
	Bot(context.Context, string) (model.Bot, error)
	Bots(context.Context, string, *string, Page) (BotPage, error)
	BotsBounded(context.Context, string, *string, Page) (BotPage, error)
	BotWorker(context.Context, string, string) error
	BotDefaults(context.Context, string) (model.BotDefaultsInput, error)
}

// BotCreationReader supplies bounded inputs for selecting one creation target.
// Candidate reads include only the fields needed to determine availability;
// the selected Worker's native configuration is read separately.
type BotCreationReader interface {
	BotPreferredWorker(context.Context, string) (*string, error)
	BotCreationCandidate(context.Context, string, string) (model.BotDefaultsInput, error)
	BotCreationCandidates(context.Context, string) (model.BotDefaultsInput, error)
	BotCreationWorker(context.Context, string, string) (model.BotDefaultsInput, error)
}
