package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// BotWriter supplies a ReadCommitted transaction. The scope and DAO are valid
// only during the callback; a Bot lock precedes any related Session lock.
type BotWriter interface {
	WriteBot(context.Context, func(BotScope) error) (Completion, error)
}

type BotScope interface {
	BotDAO() BotWriteDAO
}

type DeleteBot struct {
	Version    int64
	DeletionID string
}

type BotWriteDAO interface {
	Credential(context.Context, model.Principal) error
	Worker(context.Context, string, string) error
	LockCreation(context.Context, string) error
	// Bot locks the definition before any related Session or archive row.
	Bot(context.Context, string) (model.Bot, error)
	BotDefaults(context.Context, string) (model.BotDefaultsInput, error)
	InsertBot(context.Context, model.Bot) error
	DeleteBot(context.Context, string, int64, model.BotDeletion) (model.Bot, error)
	SaveBotDeletion(context.Context, string, *model.BotDeletion) (model.Bot, error)
	BindBotSession(context.Context, string, int64, string, model.BotRoleConfiguration) (model.Bot, error)
	SetBotStartup(context.Context, string, int64, model.BotStartupResult) (model.Bot, error)
	CommitBotPreferences(context.Context, string) error
}

var _ BotWriter = (*Store)(nil)
var _ BotScope = (*botTx)(nil)
var _ BotWriteDAO = (*botTx)(nil)
