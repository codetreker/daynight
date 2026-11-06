package appsupport

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func NewHandler(c config.Config, database store.Transactions, ready func(context.Context) error, files filestorage.Storage, logger *slog.Logger) (http.Handler, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	client, err := service.NewIdentityClient(c)
	if err != nil {
		return nil, err
	}
	return server.New(service.NewModules(c, database, ready, files, client), c, logger)
}
