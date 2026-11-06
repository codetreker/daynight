package server

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

type Dependencies struct {
	Store store.Transactions
	Ready func(context.Context) error
	Files filestorage.Storage
}

// routeOnlyStore allows server composition in routing tests. Any unexpected
// database access fails via the unimplemented embedded interface.
type routeOnlyStore struct{ store.Transactions }

func newTestHandler(d Dependencies, c config.Config, logger *slog.Logger) (http.Handler, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	client, err := service.NewIdentityClient(c)
	if err != nil {
		return nil, err
	}
	return New(service.NewModules(c, d.Store, d.Ready, d.Files, client), c, logger)
}
