package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
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

func TestStorageMigrationObjectOutcomesGateStateTransition(t *testing.T) {
	for _, scenario := range []string{"copied", "reused", "conflict", "copy_failed", "optional_read", "target_mismatch", "final_mismatch", "attachment_address", "attachment_missing"} {
		t.Run(scenario, func(t *testing.T) {
			project, owner, id := uuid.NewString(), uuid.NewString(), uuid.NewString()
			path := "projects/" + project + "/" + id[:2] + "/" + id + "/retained"
			hash := sha256.Sum256([]byte("original"))
			inventory := store.StorageInventory{ProjectID: project, OwnerID: owner, SessionID: id, Objects: []store.StorageObject{{Bucket: "session-resources", Path: path, ByteLength: 8, SHA256: hex.EncodeToString(hash[:]), Optional: true}}}
			failure := errors.New("unavailable migration dependency")
			source := migrationReadFunc(func(ctx context.Context, bucket, got string) (filestorage.Object, error) {
				if ctx != t.Context() {
					t.Fatal("migration lost caller context")
				}
				if scenario == "optional_read" && got == path || scenario == "attachment_missing" && bucket == "task-attachments" {
					return filestorage.Object{}, failure
				}
				return migrationStringObject("original"), nil
			})
			stored := map[string]string{}
			if scenario == "reused" {
				stored[path] = "original"
			}
			if scenario == "conflict" {
				stored[path] = "different"
			}
			puts, applied, inventories := 0, 0, 0
			target := migrationTargetFixture{migrationCopyTarget: migrationCopyTarget{
				migrationReadFunc: func(ctx context.Context, bucket, got string) (filestorage.Object, error) {
					value, ok := stored[got]
					if !ok {
						return filestorage.Object{}, fs.ErrNotExist
					}
					return migrationStringObject(value), nil
				},
				put: func(ctx context.Context, bucket, got string, body io.Reader) (filestorage.FileInfo, error) {
					puts++
					if scenario == "copy_failed" {
						return filestorage.FileInfo{}, &filestorage.PublicationError{Outcome: filestorage.NotPublished, Cause: failure}
					}
					data, err := io.ReadAll(body)
					if err != nil {
						return filestorage.FileInfo{}, err
					}
					stored[got] = string(data)
					return filestorage.FileInfo{Size: int64(len(data))}, nil
				},
			}}
			database := migrationDatabaseFixture{
				state: func(context.Context) (store.OfflineStorageState, error) { return store.OfflineStorageState{}, nil },
				inventory: func(ctx context.Context, verify func(store.StorageInventory) error) error {
					inventories++
					if scenario == "target_mismatch" && inventories == 2 || scenario == "final_mismatch" && inventories == 3 {
						stored[path] = "damaged!"
					}
					return verify(inventory)
				},
				attachments: func(ctx context.Context, verify func(model.Attachment) error) error {
					attachment := model.Attachment{ProjectID: project, TaskID: uuid.NewString(), Path: "retained.txt", SizeBytes: 8}
					if scenario == "attachment_address" {
						attachment.Path = "../outside"
					}
					return verify(attachment)
				},
				apply: func(context.Context, store.OfflineStorageState, []store.SessionUploadRecord, []model.PrivateTransfer) (store.Completion, error) {
					applied++
					return store.Completion{Outcome: store.TransactionCommitted}, nil
				},
			}
			var events []StorageMigrationEvent
			err := migrateStorage(t.Context(), database, source, target, func(e StorageMigrationEvent) error { events = append(events, e); return nil })
			wantSuccess := scenario == "copied" || scenario == "reused"
			if (err == nil) != wantSuccess {
				t.Fatalf("scenario=%s err=%v", scenario, err)
			}
			if (applied == 1) != (wantSuccess || scenario == "final_mismatch") {
				t.Fatalf("unverified objects changed metadata: applied=%d", applied)
			}
			if scenario == "conflict" && (puts != 0 || stored[path] != "different") {
				t.Fatal("conflicting destination was overwritten", stored, puts)
			}
			if (scenario == "copy_failed" || scenario == "optional_read" || scenario == "attachment_missing") && !errors.Is(err, failure) {
				t.Fatal("lost dependency failure", err)
			}
			summary := events[len(events)-1]
			if (summary.Status == "verified") != wantSuccess {
				t.Fatal("incorrect migration summary", summary)
			}
			wantCount := map[string]string{"copied": "verified", "reused": "reused", "conflict": "conflict", "copy_failed": "copy_failed", "attachment_missing": "read_failed"}[scenario]
			if wantCount != "" && summary.Counts[wantCount] < 1 {
				t.Fatalf("missing %s outcome: %+v", wantCount, summary)
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

func TestStorageMigrationOptionalAzureAbsenceAcrossTargetVerification(t *testing.T) {
	for _, scenario := range []string{"absent", "mixed_before_commit", "mixed_after_commit", "other_404", "required_absent", "present_verified", "corrupt_before_commit", "corrupt_after_commit"} {
		t.Run(scenario, func(t *testing.T) {
			project, owner, id := uuid.NewString(), uuid.NewString(), uuid.NewString()
			path := "projects/" + project + "/" + id[:2] + "/" + id + "/uploads/" + uuid.NewString() + "/0"
			hash := sha256.Sum256([]byte("original"))
			inventory := store.StorageInventory{ProjectID: project, OwnerID: owner, SessionID: id, Objects: []store.StorageObject{{Bucket: "session-resources", Path: path, ByteLength: 8, SHA256: hex.EncodeToString(hash[:]), Optional: scenario != "required_absent"}}}
			missing := &azcore.ResponseError{StatusCode: 404, ErrorCode: "BlobNotFound"}
			transportFailure := errors.New("Azure transport unavailable")
			present := scenario == "required_absent" || scenario == "present_verified" || scenario == "corrupt_before_commit" || scenario == "corrupt_after_commit"
			source := migrationReadFunc(func(context.Context, string, string) (filestorage.Object, error) {
				if present {
					return migrationStringObject("original"), nil
				}
				return filestorage.Object{}, fs.ErrNotExist
			})
			inventories, applied, targetPasses := 0, 0, 0
			database := migrationDatabaseFixture{
				state: func(context.Context) (store.OfflineStorageState, error) { return store.OfflineStorageState{}, nil },
				inventory: func(ctx context.Context, verify func(store.StorageInventory) error) error {
					inventories++
					if inventories > 1 {
						targetPasses++
					}
					return verify(inventory)
				},
				attachments: func(context.Context, func(model.Attachment) error) error { return nil },
				apply: func(context.Context, store.OfflineStorageState, []store.SessionUploadRecord, []model.PrivateTransfer) (store.Completion, error) {
					applied++
					return store.Completion{Outcome: store.TransactionCommitted}, nil
				},
			}
			target := migrationTargetFixture{migrationCopyTarget: migrationCopyTarget{migrationReadFunc: func(context.Context, string, string) (filestorage.Object, error) {
				if inventories == 1 && present || scenario == "present_verified" || scenario == "corrupt_after_commit" && inventories == 2 {
					return migrationStringObject("original"), nil
				}
				if scenario == "corrupt_before_commit" || scenario == "corrupt_after_commit" {
					return migrationStringObject("damaged!"), nil
				}
				if scenario == "other_404" {
					return filestorage.Object{}, errors.Join(fs.ErrNotExist, &azcore.ResponseError{StatusCode: 404, ErrorCode: "ContainerNotFound"})
				}
				if scenario == "mixed_before_commit" || scenario == "mixed_after_commit" && inventories == 3 {
					return filestorage.Object{}, errors.Join(fs.ErrNotExist, missing, transportFailure)
				}
				return filestorage.Object{}, errors.Join(fs.ErrNotExist, missing)
			}}}
			var events []StorageMigrationEvent
			err := migrateStorage(t.Context(), database, source, target, func(e StorageMigrationEvent) error { events = append(events, e); return nil })
			wantSuccess := scenario == "absent" || scenario == "present_verified"
			if (err == nil) != wantSuccess {
				t.Fatalf("scenario=%s err=%v", scenario, err)
			}
			wantApplied := wantSuccess || scenario == "mixed_after_commit" || scenario == "corrupt_after_commit"
			if (applied == 1) != wantApplied || targetPasses != 1+applied {
				t.Fatalf("incorrect target verification boundary: applied=%d passes=%d", applied, targetPasses)
			}
			if scenario == "mixed_before_commit" || scenario == "mixed_after_commit" {
				if !errors.Is(err, missing) || !errors.Is(err, transportFailure) {
					t.Fatal("mixed Azure failure chain lost", err)
				}
			}
			if scenario == "required_absent" && !errors.Is(err, missing) {
				t.Fatal("required object absence hidden", err)
			}
			summary := events[len(events)-1]
			if (summary.Status == "verified") != wantSuccess || scenario == "absent" && (summary.Counts["skipped"] != 1 || summary.Counts["missing"] != 0) {
				t.Fatal("incorrect optional object summary", summary)
			}
			if !wantSuccess {
				found := false
				for _, event := range events {
					if event.Status == "target_mismatch" && event.SessionID == id {
						found = true
					}
				}
				if !found {
					t.Fatal("target verification failure not reported", events)
				}
			}
		})
	}
}
