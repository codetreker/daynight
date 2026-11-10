package bot

import (
	"context"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
)

type botOperations struct {
	create           func(context.Context, store.BotWriteDAO, model.Principal, botcore.CreateBot, string, bool) (model.Bot, error)
	get              func(context.Context, store.SnapshotScope, model.Principal, string) (model.Bot, error)
	list             func(context.Context, store.SnapshotScope, model.Principal, *string, store.Page) (store.BotPage, error)
	creationDefaults func(context.Context, store.BotCreationReader, string, model.BotOverrides) (model.BotDefaultsInput, botcore.BotDefaults, error)
	defaults         func(model.BotDefaultsInput, model.BotOverrides) (botcore.BotDefaults, error)
	workerDefaults   func(model.BotDefaultsInput, model.BotOverrides, string) (model.BotConfiguration, error)
	nativeSelection  func(model.BotConfiguration, model.BotOverrides, model.BotNativePreference, ro.ModelResult, *string) (model.BotConfiguration, error)
}

func defaultBotOperations() botOperations {
	return botOperations{
		create: botcore.Create, get: botcore.Get, list: botcore.List,
		creationDefaults: botcore.CreationDefaults, defaults: botcore.ResolveBotDefaults,
		workerDefaults: botcore.WorkerNativeDefaults, nativeSelection: botcore.ResolveNativeSelection,
	}
}

type deletionOperations struct {
	owner   func(model.Bot, model.Principal) error
	request func(model.Bot, store.DeleteBot) (bool, error)
	save    func(context.Context, store.BotWriteDAO, model.Bot) (model.Bot, error)
	worker  func(model.Bot, string, string, model.BotCleanupResult, string) (bool, bool, error)
	server  func(model.Bot, string) (bool, error)
	fail    func(*model.Bot, string) (bool, error)
}

func defaultDeletionOperations() deletionOperations {
	return deletionOperations{owner: botcore.RequireDeletionOwner, request: botcore.DeletionRequest,
		save: botcore.SaveDeletion, worker: botcore.PrepareWorkerCleanup,
		server: botcore.PrepareServerCleanup, fail: botcore.FailServerCleanup}
}
