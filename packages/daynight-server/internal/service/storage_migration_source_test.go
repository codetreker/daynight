package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestStorageMigrationSourceIntegrityPrecedesPublicationAndTransition(t *testing.T) {
	for _, scenario := range []string{"missing", "mismatch", "read_failed", "attachment_mismatch"} {
		t.Run(scenario, func(t *testing.T) {
			project, owner, id, blob := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			path, err := sessioncore.BlobAddress(project, owner, id, blob)
			if err != nil {
				t.Fatal(err)
			}
			hash := sha256.Sum256([]byte("original"))
			digest, length, mediaType := hex.EncodeToString(hash[:]), "8", "text/plain"
			inventory := store.StorageInventory{ProjectID: project, OwnerID: owner, SessionID: id, Resources: []store.SessionResourceRecord{{SessionID: id, BlobID: blob, BlobPath: path, Resource: sp.Resource{ResourceID: blob, Status: "available", Name: "original", MediaType: &mediaType, ByteLength: &length, SHA256: &digest}}}}
			failure := errors.New("unavailable disk")
			source := migrationReadFunc(func(context.Context, string, string) (filestorage.Object, error) {
				switch scenario {
				case "missing":
					return filestorage.Object{}, fs.ErrNotExist
				case "read_failed":
					return filestorage.Object{}, failure
				case "mismatch":
					return migrationStringObject("damaged!"), nil
				default:
					return migrationStringObject("original"), nil
				}
			})
			database := migrationDatabaseFixture{
				state:     func(context.Context) (store.OfflineStorageState, error) { return store.OfflineStorageState{}, nil },
				inventory: func(ctx context.Context, verify func(store.StorageInventory) error) error { return verify(inventory) },
				attachments: func(ctx context.Context, verify func(model.Attachment) error) error {
					return verify(model.Attachment{ProjectID: project, TaskID: uuid.NewString(), Path: "file", SizeBytes: 9})
				},
				apply: func(context.Context, store.OfflineStorageState, []store.SessionUploadRecord, []model.PrivateTransfer) (store.Completion, error) {
					t.Fatal("failed source reset metadata")
					return store.Completion{}, nil
				},
			}
			target := migrationTargetFixture{migrationCopyTarget: migrationCopyTarget{migrationReadFunc: func(context.Context, string, string) (filestorage.Object, error) {
				t.Fatal("failed source touched target")
				return filestorage.Object{}, nil
			}}}
			var events []StorageMigrationEvent
			err = migrateStorage(t.Context(), database, source, target, func(e StorageMigrationEvent) error { events = append(events, e); return nil })
			if err == nil {
				t.Fatal("invalid source accepted")
			}
			want := map[string]string{"missing": "source_missing", "mismatch": "source_mismatch", "read_failed": "read_failed", "attachment_mismatch": "source_mismatch"}[scenario]
			found := false
			for _, event := range events {
				if event.Status == want {
					found = true
				}
			}
			if !found {
				t.Fatalf("missing %s event: %+v", want, events)
			}
			if scenario == "read_failed" && !errors.Is(err, failure) {
				t.Fatal("disk failure lost", err)
			}
		})
	}
}

func TestStorageMigrationOptionalMissingChunkReportsSkipped(t *testing.T) {
	project, owner, id := uuid.NewString(), uuid.NewString(), uuid.NewString()
	namespace := "projects/" + project + "/" + id[:2] + "/" + id
	inventory := store.StorageInventory{ProjectID: project, OwnerID: owner, SessionID: id, Objects: []store.StorageObject{{Bucket: "session-resources", Path: namespace + "/optional", Optional: true}}}
	database := migrationDatabaseFixture{
		state:       func(context.Context) (store.OfflineStorageState, error) { return store.OfflineStorageState{}, nil },
		inventory:   func(ctx context.Context, verify func(store.StorageInventory) error) error { return verify(inventory) },
		attachments: func(context.Context, func(model.Attachment) error) error { return nil },
		apply: func(context.Context, store.OfflineStorageState, []store.SessionUploadRecord, []model.PrivateTransfer) (store.Completion, error) {
			return store.Completion{Outcome: store.TransactionCommitted}, nil
		},
	}
	reader := migrationReadFunc(func(context.Context, string, string) (filestorage.Object, error) {
		return filestorage.Object{}, fs.ErrNotExist
	})
	target := migrationTargetFixture{migrationCopyTarget: migrationCopyTarget{migrationReadFunc: reader}}
	var events []StorageMigrationEvent
	if err := migrateStorage(t.Context(), database, reader, target, func(e StorageMigrationEvent) error { events = append(events, e); return nil }); err != nil {
		t.Fatal(err)
	}
	summary := events[len(events)-1]
	if summary.Counts["skipped"] != 1 || summary.Counts["missing"] != 0 {
		t.Fatal(summary)
	}
}
