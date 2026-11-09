package service

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

// VerifyStorageBackup reads a restored stopped-writer database and file volume.
// Opening this command never applies migrations or starts application services.
func VerifyStorageBackup(ctx context.Context, databaseURL, storageRoot string) (result error) {
	database, err := postgres.OpenReadOnly(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer database.Close()
	files, err := local.OpenReadOnly(storageRoot)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, files.Close()) }()
	return database.VerifyStorageInventory(ctx, func(inventory store.StorageInventory) error {
		return sessioncore.VerifyStorageBackup(ctx, files, inventory)
	})
}
