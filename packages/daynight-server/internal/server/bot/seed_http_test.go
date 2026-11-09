package bot_test

import (
	"context"
	"testing"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"github.com/google/uuid"
)

func seedHTTPBot(t *testing.T, database *postgres.Store, handler *resourceTestHandler, workerID string) model.Bot {
	t.Helper()
	bot, err := botservice.New(database).Create(context.Background(), handler.principal, botcore.CreateBot{
		ID: uuid.NewString(), Name: "  长期助手  ", ResolvedConfiguration: model.BotConfiguration{
			WorkerID: workerID, Cwd: "/private/bot-work", Provider: "codex", Args: []string{},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return bot
}
