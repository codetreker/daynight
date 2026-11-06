package service

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/maintenance"
)

// Persistence owns the shared database resources used by the application.
type Persistence struct {
	Transactions store.Transactions
	Ready        func(context.Context) error
	Close        func()
}

func OpenPersistence(ctx context.Context, databaseURL string) (*Persistence, error) {
	database, err := postgres.Open(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	return &Persistence{Transactions: database, Ready: database.Ready, Close: database.Close}, nil
}

// OpenAttachmentMaintenance assembles the dedicated offline maintenance session.
func OpenAttachmentMaintenance(ctx context.Context, databaseURL string) (store.AttachmentMaintenance, error) {
	return maintenance.OpenAttachmentMaintenance(ctx, databaseURL)
}
