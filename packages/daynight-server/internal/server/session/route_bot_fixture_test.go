package session_test

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type routeUnavailableBotDAO struct{ scope *routeCallScope }

func (d routeUnavailableBotDAO) BotPreferredWorker(a0 context.Context, a1 string) (*string, error) {
	d.scope.invoke(a0, "BotPreferredWorker", false)
	panic("unreachable unconfigured Bot DAO")
}
func (d routeUnavailableBotDAO) BotCreationCandidate(a0 context.Context, a1 string, a2 string) (model.BotDefaultsInput, error) {
	d.scope.invoke(a0, "BotCreationCandidate", false)
	panic("unreachable unconfigured Bot DAO")
}
func (d routeUnavailableBotDAO) BotCreationCandidates(a0 context.Context, a1 string) (model.BotDefaultsInput, error) {
	d.scope.invoke(a0, "BotCreationCandidates", false)
	panic("unreachable unconfigured Bot DAO")
}
func (d routeUnavailableBotDAO) BotCreationWorker(a0 context.Context, a1 string, a2 string) (model.BotDefaultsInput, error) {
	d.scope.invoke(a0, "BotCreationWorker", false)
	panic("unreachable unconfigured Bot DAO")
}
func (d routeUnavailableBotDAO) Credential(a0 context.Context, a1 model.Principal) error {
	d.scope.invoke(a0, "Credential", false)
	panic("unreachable unconfigured Bot DAO")
}
func (d routeUnavailableBotDAO) Worker(a0 context.Context, a1 string, a2 string) error {
	d.scope.invoke(a0, "Worker", false)
	panic("unreachable unconfigured Bot DAO")
}
func (d routeUnavailableBotDAO) LockCreation(a0 context.Context, a1 string) error {
	d.scope.invoke(a0, "LockCreation", false)
	panic("unreachable unconfigured Bot DAO")
}
func (d routeUnavailableBotDAO) Bot(a0 context.Context, a1 string) (model.Bot, error) {
	d.scope.invoke(a0, "Bot", false)
	panic("unreachable unconfigured Bot DAO")
}
func (d routeUnavailableBotDAO) BotDefaults(a0 context.Context, a1 string) (model.BotDefaultsInput, error) {
	d.scope.invoke(a0, "BotDefaults", false)
	panic("unreachable unconfigured Bot DAO")
}
func (d routeUnavailableBotDAO) InsertBot(a0 context.Context, a1 model.Bot) error {
	d.scope.invoke(a0, "InsertBot", false)
	panic("unreachable unconfigured Bot DAO")
}
func (d routeUnavailableBotDAO) SaveBotDeletion(a0 context.Context, a1 string, a2 *model.BotDeletion) (model.Bot, error) {
	d.scope.invoke(a0, "SaveBotDeletion", false)
	panic("unreachable unconfigured Bot DAO")
}
func (d routeUnavailableBotDAO) BindBotSession(a0 context.Context, a1 string, a2 int64, a3 string, a4 model.BotRoleConfiguration) (model.Bot, error) {
	d.scope.invoke(a0, "BindBotSession", false)
	panic("unreachable unconfigured Bot DAO")
}
func (d routeUnavailableBotDAO) SetBotStartup(a0 context.Context, a1 string, a2 int64, a3 model.BotStartupResult) (model.Bot, error) {
	d.scope.invoke(a0, "SetBotStartup", false)
	panic("unreachable unconfigured Bot DAO")
}
func (d routeUnavailableBotDAO) CommitBotPreferences(a0 context.Context, a1 string) error {
	d.scope.invoke(a0, "CommitBotPreferences", false)
	panic("unreachable unconfigured Bot DAO")
}
