package service

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type backupReaderFixture struct {
	t                      *testing.T
	calls                  []string
	inventory              store.StorageInventory
	inventoryErr, closeErr error
}

func (f *backupReaderFixture) Close() { f.calls = append(f.calls, "database-close") }
func (f *backupReaderFixture) VerifyStorageInventory(_ context.Context, verify func(store.StorageInventory) error) error {
	f.calls = append(f.calls, "inventory")
	if f.inventoryErr != nil {
		return f.inventoryErr
	}
	return verify(f.inventory)
}

type backupVolumeFixture struct{ owner *backupReaderFixture }

func (f *backupVolumeFixture) Open(context.Context, string, string) (filestorage.Object, error) {
	f.owner.t.Fatal("orchestration executed the mocked core verifier's storage reads")
	return filestorage.Object{}, nil
}
func (f *backupVolumeFixture) Close() error {
	f.owner.calls = append(f.owner.calls, "files-close")
	return f.owner.closeErr
}

func TestBackupReaderOrchestrationPreservesInputsCleanupAndCauses(t *testing.T) {
	for _, kind := range []string{"original", "database-open", "files-open", "inventory", "verify", "close", "verify-and-close"} {
		t.Run(kind, func(t *testing.T) {
			failure, cleanup := errors.New("backup read failed"), errors.New("volume close failed")
			f := &backupReaderFixture{t: t, inventory: store.StorageInventory{SessionID: "original-session", OwnerID: "original-owner"}}
			files := &backupVolumeFixture{owner: f}
			ctx := t.Context()
			if kind == "inventory" {
				f.inventoryErr = failure
			}
			if kind == "close" || kind == "verify-and-close" {
				f.closeErr = cleanup
			}
			readers := backupReaderDependencies{
				openDatabase: func(got context.Context, url string) (backupInventoryReader, error) {
					f.calls = append(f.calls, "database-open")
					if got != ctx || url != "restored-database" {
						t.Fatal("database open input changed")
					}
					if kind == "database-open" {
						return nil, failure
					}
					return f, nil
				},
				openFiles: func(root string) (backupVolumeReader, error) {
					f.calls = append(f.calls, "files-open")
					if root != "restored-volume" {
						t.Fatal("volume input changed")
					}
					if kind == "files-open" {
						return nil, failure
					}
					return files, nil
				},
				verify: func(got context.Context, volume backupVolumeReader, inventory store.StorageInventory) error {
					f.calls = append(f.calls, "verify")
					if got != ctx || volume != files || !reflect.DeepEqual(inventory, f.inventory) {
						t.Fatal("core operation input changed")
					}
					if kind == "verify" || kind == "verify-and-close" {
						return failure
					}
					return nil
				},
			}
			e := verifyStorageBackup(ctx, "restored-database", "restored-volume", readers)
			want := []string{"database-open", "files-open", "inventory", "verify", "files-close", "database-close"}
			if kind == "database-open" {
				want = []string{"database-open"}
			}
			if kind == "files-open" {
				want = []string{"database-open", "files-open", "database-close"}
			}
			if kind == "inventory" {
				want = []string{"database-open", "files-open", "inventory", "files-close", "database-close"}
			}
			if !reflect.DeepEqual(f.calls, want) {
				t.Fatal("backup lifetime order changed", f.calls, want)
			}
			if kind == "original" {
				if e != nil {
					t.Fatal(e)
				}
			} else if kind != "close" && !errors.Is(e, failure) {
				t.Fatal("original read error lost", e)
			}
			if f.closeErr != nil && !errors.Is(e, cleanup) {
				t.Fatal("volume cleanup error lost", e)
			}
		})
	}
}

func TestBackupReaderPublicEntryRejectsInvalidDatabaseBeforeVolume(t *testing.T) {
	if e := VerifyStorageBackup(t.Context(), "postgres://private-user:private-password@bad%host/db", "must-not-open"); e == nil {
		t.Fatal("invalid backup database accepted")
	}
}
