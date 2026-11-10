package server

import (
	"context"
	"errors"
	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"testing"
)

type operationRejectedBots struct{ t *testing.T }

func (r *operationRejectedBots) CreateResolved(context.Context, model.Principal, botcore.CreateBot) (model.Bot, error) {
	r.t.Errorf("unexpected Bots.CreateResolved call")
	var result0 model.Bot
	return result0, errors.New("unexpected Bots.CreateResolved")
}

func (r *operationRejectedBots) Defaults(context.Context, model.Principal, *string) (botcore.BotDefaults, error) {
	r.t.Errorf("unexpected Bots.Defaults call")
	var result0 botcore.BotDefaults
	return result0, errors.New("unexpected Bots.Defaults")
}

func (r *operationRejectedBots) List(context.Context, model.Principal, model.PageRequest) (botcore.BotPage, error) {
	r.t.Errorf("unexpected Bots.List call")
	var result0 botcore.BotPage
	return result0, errors.New("unexpected Bots.List")
}

func (r *operationRejectedBots) ListWorker(context.Context, model.Principal, string, model.PageRequest) (botcore.BotPage, error) {
	r.t.Errorf("unexpected Bots.ListWorker call")
	var result0 botcore.BotPage
	return result0, errors.New("unexpected Bots.ListWorker")
}

func (r *operationRejectedBots) Get(context.Context, model.Principal, string) (model.Bot, error) {
	r.t.Errorf("unexpected Bots.Get call")
	var result0 model.Bot
	return result0, errors.New("unexpected Bots.Get")
}
