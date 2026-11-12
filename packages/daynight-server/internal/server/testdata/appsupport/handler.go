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
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/credentialusage"
)

type handlerWithRecorder struct {
	server.Handler
	recorder *credentialusage.Recorder
}

func (h *handlerWithRecorder) Shutdown(ctx context.Context) error {
	if err := h.Handler.Shutdown(ctx); err != nil {
		return err
	}
	return h.recorder.Drain(ctx)
}

func NewHandler(c config.Config, database store.Transactions, ready func(context.Context) error, files filestorage.Storage, logger *slog.Logger) (http.Handler, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	client, err := service.NewIdentityClient(c.UniAuth)
	if err != nil {
		return nil, err
	}
	app := service.NewModules(c, database, ready, files, client)
	recorder, err := credentialusage.New(database, logger, nil)
	if err != nil {
		return nil, err
	}
	app.CredentialUsage = recorder
	handler, err := server.New(app, c, logger)
	if err != nil {
		return nil, err
	}
	if err := recorder.Start(context.Background()); err != nil {
		return nil, err
	}
	return &handlerWithRecorder{Handler: handler, recorder: recorder}, nil
}
