package service

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/prometheus/client_golang/prometheus"
)

// Persistence owns the shared database resources used by the application.
type Persistence struct {
	Transactions     store.Transactions
	Ready            func(context.Context) error
	Close            func()
	MetricsCollector prometheus.Collector
}

type persistenceBackend interface {
	store.Transactions
	Ready(context.Context) error
	Close()
	MetricsCollector() prometheus.Collector
}

func openPostgres(ctx context.Context, databaseURL string) (persistenceBackend, error) {
	return postgres.Open(ctx, databaseURL)
}

func OpenPersistence(ctx context.Context, databaseURL string) (*Persistence, error) {
	return openPersistence(ctx, databaseURL, openPostgres)
}

func openPersistence(ctx context.Context, databaseURL string, open func(context.Context, string) (persistenceBackend, error)) (*Persistence, error) {
	database, err := open(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	collector := database.MetricsCollector()
	if collector == nil {
		database.Close()
		return nil, errors.New("persistence metrics collector is unavailable")
	}
	return &Persistence{Transactions: database, Ready: database.Ready, Close: database.Close, MetricsCollector: collector}, nil
}
