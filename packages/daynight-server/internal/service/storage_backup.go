package service

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

type backupInventoryReader interface {
	Close()
	VerifyStorageInventory(context.Context, func(store.StorageInventory) error) error
}
type backupVolumeReader interface {
	Open(context.Context, string, string) (filestorage.Object, error)
	Close() error
}
type backupReaderDependencies struct {
	openDatabase func(context.Context, string) (backupInventoryReader, error)
	openFiles    func(string) (backupVolumeReader, error)
	verify       func(context.Context, backupVolumeReader, store.StorageInventory) error
}

var readOnlyBackupReaders = backupReaderDependencies{
	openDatabase: func(ctx context.Context, url string) (backupInventoryReader, error) {
		return postgres.OpenReadOnly(ctx, url)
	},
	openFiles: func(root string) (backupVolumeReader, error) { return local.OpenReadOnly(root) },
	verify: func(ctx context.Context, files backupVolumeReader, inventory store.StorageInventory) error {
		return sessioncore.VerifyStorageBackup(ctx, files, inventory)
	},
}

// VerifyStorageBackup reads a restored stopped-writer database and file volume.
// Opening this command never applies migrations or starts application services.
func VerifyStorageBackup(ctx context.Context, databaseURL, storageRoot string) (result error) {
	return verifyStorageBackup(ctx, databaseURL, storageRoot, readOnlyBackupReaders)
}

func verifyStorageBackup(ctx context.Context, databaseURL, storageRoot string, readers backupReaderDependencies) (result error) {
	database, err := readers.openDatabase(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer database.Close()
	files, err := readers.openFiles(storageRoot)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, files.Close()) }()
	return database.VerifyStorageInventory(ctx, func(inventory store.StorageInventory) error {
		return readers.verify(ctx, files, inventory)
	})
}
