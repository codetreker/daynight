package service

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	storageconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type migrationDatabaseFixture struct {
	state       func(context.Context) (store.OfflineStorageState, error)
	inventory   func(context.Context, func(store.StorageInventory) error) error
	attachments func(context.Context, func(model.Attachment) error) error
	apply       func(context.Context, store.OfflineStorageState, []store.SessionUploadRecord, []model.PrivateTransfer) (store.Completion, error)
}

func (f migrationDatabaseFixture) ReadOfflineStorageState(ctx context.Context) (store.OfflineStorageState, error) {
	return f.state(ctx)
}
func (f migrationDatabaseFixture) VerifyStorageInventory(ctx context.Context, fn func(store.StorageInventory) error) error {
	return f.inventory(ctx, fn)
}
func (f migrationDatabaseFixture) VerifyOfflineAttachments(ctx context.Context, fn func(model.Attachment) error) error {
	return f.attachments(ctx, fn)
}
func (f migrationDatabaseFixture) ApplyOfflineStorageTransition(ctx context.Context, s store.OfflineStorageState, u []store.SessionUploadRecord, t []model.PrivateTransfer, revocations []store.OfflineArchiveRevocation) (store.Completion, error) {
	return f.apply(ctx, s, u, t)
}

type migrationTargetFixture struct {
	migrationCopyTarget
	delete   func(context.Context, string, string) error
	upload   func(context.Context, sessionresource.Namespace, string) error
	transfer func(context.Context, filestorage.TransferNamespace) error
}

func (f migrationTargetFixture) Delete(ctx context.Context, bucket, path string) error {
	return f.delete(ctx, bucket, path)
}
func (f migrationTargetFixture) DeleteSessionUpload(ctx context.Context, n sessionresource.Namespace, id string) error {
	return f.upload(ctx, n, id)
}
func (f migrationTargetFixture) DeleteTransferNamespace(ctx context.Context, n filestorage.TransferNamespace) error {
	return f.transfer(ctx, n)
}

func TestStorageMigrationTransitionRequiresVerifiedCopy(t *testing.T) {
	for _, phase := range []string{"success", "state_read", "invalid_state", "inventory", "attachments", "commit", "unknown", "readback", "remaining", "target_inventory", "final_inventory", "state_report", "final_report", "report"} {
		t.Run(phase, func(t *testing.T) {
			failure := errors.New("injected failure")
			applied, reads, inventories := 0, 0, 0
			database := migrationDatabaseFixture{
				state: func(context.Context) (store.OfflineStorageState, error) {
					reads++
					if phase == "state_read" || phase == "readback" && reads > 1 {
						return store.OfflineStorageState{}, failure
					}
					if phase == "invalid_state" || phase == "remaining" && reads > 1 {
						return store.OfflineStorageState{Uploads: []store.OfflineImageUpload{{ProjectID: "invalid"}}}, nil
					}
					return store.OfflineStorageState{}, nil
				},
				inventory: func(context.Context, func(store.StorageInventory) error) error {
					inventories++
					if phase == "inventory" || phase == "target_inventory" && inventories == 2 || phase == "final_inventory" && inventories == 3 {
						return failure
					}
					return nil
				},
				attachments: func(context.Context, func(model.Attachment) error) error {
					if phase == "attachments" {
						return failure
					}
					return nil
				},
				apply: func(context.Context, store.OfflineStorageState, []store.SessionUploadRecord, []model.PrivateTransfer) (store.Completion, error) {
					applied++
					if phase == "commit" {
						return store.Completion{Outcome: store.TransactionUnknown}, failure
					}
					if phase == "unknown" {
						return store.Completion{Outcome: store.TransactionUnknown}, nil
					}
					return store.Completion{Outcome: store.TransactionCommitted}, nil
				},
			}
			reader := migrationReadFunc(func(context.Context, string, string) (filestorage.Object, error) {
				t.Fatal("unexpected object read")
				return filestorage.Object{}, fs.ErrNotExist
			})
			target := migrationTargetFixture{migrationCopyTarget: migrationCopyTarget{migrationReadFunc: reader, put: func(context.Context, string, string, io.Reader) (filestorage.FileInfo, error) {
				t.Fatal("unexpected publication")
				return filestorage.FileInfo{}, failure
			}}}
			var events []StorageMigrationEvent
			err := migrateStorage(t.Context(), database, reader, target, func(e StorageMigrationEvent) error {
				events = append(events, e)
				if phase == "report" || phase == "state_report" && e.Kind == "state" || phase == "final_report" && e.Kind == "migration" && e.Status == "verified" {
					return failure
				}
				return nil
			})
			if (err == nil) != (phase == "success") {
				t.Fatal(err)
			}
			if phase != "unknown" && phase != "success" && phase != "invalid_state" && phase != "remaining" && !errors.Is(err, failure) {
				t.Fatal("lost failure cause", err)
			}
			wantApply := phase == "success" || phase == "commit" || phase == "unknown" || phase == "readback" || phase == "remaining" || phase == "final_inventory" || phase == "state_report" || phase == "final_report"
			if (applied == 1) != wantApply {
				t.Fatalf("applied=%d", applied)
			}
			last := events[len(events)-1]
			if last.Kind != "summary" || last.RunID == "" || last.Counts == nil {
				t.Fatal("missing run summary", last)
			}
			if (last.Status == "verified") != (phase == "success") {
				t.Fatal("failed migration reported a verified summary", last)
			}
			if phase == "unknown" && last.Counts["pending"] != 1 {
				t.Fatal("unknown state outcome missing from summary", last)
			}
		})
	}
}

func TestStorageMigrationSourceScratchSeparation(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	if err := os.Mkdir(source, 0700); err != nil {
		t.Fatal(err)
	}
	for _, scratch := range []string{source, root, filepath.Join(source, "scratch"), "relative"} {
		if err := validateMigrationRoots(source, scratch); err == nil {
			t.Fatalf("overlap accepted %q", scratch)
		}
	}
	if err := validateMigrationRoots(source, filepath.Join(root, "scratch", "new")); err != nil {
		t.Fatal(err)
	}
	if err := validateMigrationRoots("relative", source); err == nil {
		t.Fatal("relative source accepted")
	}
	volumeRoot := filepath.VolumeName(source) + string(filepath.Separator)
	if err := validateMigrationRoots(volumeRoot, source); err == nil {
		t.Fatal("filesystem root overlap accepted")
	}
	link := filepath.Join(root, "alias")
	if err := os.Symlink(source, link); err == nil {
		if err = validateMigrationRoots(source, filepath.Join(link, "scratch")); err == nil {
			t.Fatal("symlink overlap accepted")
		}
	}
	if err := MigrateStorage(t.Context(), "not-used", source, storageconfig.DefaultConfig(), nil); err == nil {
		t.Fatal("local target accepted")
	}
	cfg := storageconfig.Config{Backend: "azure-blob", Root: filepath.Join(root, "scratch")}
	if err := MigrateStorage(t.Context(), "not-used", source, cfg, nil); err == nil {
		t.Fatal("missing report accepted")
	}
	if err := MigrateStorage(t.Context(), "postgres://bad%host/db", source, cfg, func(StorageMigrationEvent) error { return nil }); err == nil {
		t.Fatal("invalid destination accepted")
	}
}
