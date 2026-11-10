package server

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"testing"
)

type operationRejectedBotDeletions struct{ t *testing.T }

func (r *operationRejectedBotDeletions) DeleteBot(context.Context, model.Principal, string, store.DeleteBot) (model.Bot, error) {
	r.t.Errorf("unexpected BotDeletions.DeleteBot call")
	var result0 model.Bot
	return result0, errors.New("unexpected BotDeletions.DeleteBot")
}

func (r *operationRejectedBotDeletions) CompleteBotDeletion(context.Context, model.Principal, string, string, bot.BotDeletionReceipt) (model.Bot, error) {
	r.t.Errorf("unexpected BotDeletions.CompleteBotDeletion call")
	var result0 model.Bot
	return result0, errors.New("unexpected BotDeletions.CompleteBotDeletion")
}
