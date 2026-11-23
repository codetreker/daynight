package service

import (
	"context"
	"errors"
	"io/fs"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestStorageMigrationPreservesObservedUnconfirmedPublication(t *testing.T) {
	project, owner, id, fileID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, scenario := range []string{"archive_source", "archive_target", "image_source", "transfer_source", "missing", "joined_failure"} {
		t.Run(scenario, func(t *testing.T) {
			state := store.OfflineStorageState{ArchiveFiles: []store.OfflineArchiveFile{{ProjectID: project, OwnerID: owner, File: store.ArchiveBundleFile{SessionID: id, FileID: fileID, Purpose: "history", Path: "formal"}}}}
			if scenario == "image_source" {
				state = store.OfflineStorageState{Uploads: []store.OfflineImageUpload{{ProjectID: project, OwnerID: owner, Upload: store.SessionUploadRecord{SessionID: id, BlobID: fileID, Spec: sp.ImageUploadSpec{UploadID: fileID}}}}}
			}
			if scenario == "transfer_source" {
				state = store.OfflineStorageState{Transfers: []model.PrivateTransfer{{ID: fileID, ProjectID: project, TaskID: id, Direction: "upload", Path: "file", State: "unknown"}}}
			}
			failure := errors.New("disk close failed")
			reader := func(source bool) migrationReadFunc {
				return func(context.Context, string, string) (filestorage.Object, error) {
					if scenario == "joined_failure" {
						return filestorage.Object{}, errors.Join(fs.ErrNotExist, failure)
					}
					if scenario != "missing" && (source && strings.HasSuffix(scenario, "source") || !source && strings.HasSuffix(scenario, "target")) {
						return migrationStringObject("observable"), nil
					}
					return filestorage.Object{}, fs.ErrNotExist
				}
			}
			var event StorageMigrationEvent
			err := verifyOfflinePublicationAbsence(t.Context(), reader(true), reader(false), state, func(e StorageMigrationEvent) error { event = e; return nil })
			if scenario == "missing" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil {
				t.Fatal("observable publication dropped")
			}
			if scenario == "joined_failure" {
				if !errors.Is(err, failure) {
					t.Fatal(err)
				}
				return
			}
			observer := "source"
			if scenario == "archive_target" {
				observer = "target"
			}
			if event.Status != "publication_observed" || event.Observer != observer || event.FileID != fileID {
				t.Fatal(event)
			}
		})
	}
}

func TestStorageMigrationCleanupPreservesReceiptsAndReportsOperations(t *testing.T) {
	project, owner, id, fileID, uploadID, transferID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	state := store.OfflineStorageState{
		ArchiveFiles: []store.OfflineArchiveFile{{ProjectID: project, OwnerID: owner, File: store.ArchiveBundleFile{SessionID: id, FileID: fileID}, Chunks: []store.StorageObject{{Bucket: "session-archives", Path: "old-chunk"}}}},
		Uploads:      []store.OfflineImageUpload{{ProjectID: project, OwnerID: owner, Upload: store.SessionUploadRecord{SessionID: id, Spec: sp.ImageUploadSpec{UploadID: uploadID}, Receipt: sp.ImageUploadReceipt{UploadID: uploadID, State: "receiving", AcceptedOffset: "1048576"}}}},
		Transfers:    []model.PrivateTransfer{{ID: transferID, State: "committing", Data: []byte(`{"operation":"retained"}`)}},
	}
	for _, failAt := range []string{"none", "archive", "image", "transfer", "report"} {
		t.Run(failAt, func(t *testing.T) {
			failure := errors.New("cleanup failed")
			var deleted []string
			target := migrationTargetFixture{
				delete: func(ctx context.Context, bucket, path string) error {
					if failAt == "archive" {
						return failure
					}
					deleted = append(deleted, path)
					return nil
				},
				upload: func(ctx context.Context, n sessionresource.Namespace, got string) error {
					if got != uploadID {
						t.Fatal("wrong upload")
					}
					if failAt == "image" {
						return failure
					}
					return nil
				},
				transfer: func(ctx context.Context, n filestorage.TransferNamespace) error {
					if n.ID() != transferID {
						t.Fatal("wrong ticket")
					}
					if failAt == "transfer" {
						return failure
					}
					return nil
				},
			}
			var events []StorageMigrationEvent
			uploads, transfers, err := cleanupOfflineStorage(t.Context(), target, state, func(e StorageMigrationEvent) error {
				events = append(events, e)
				if failAt == "report" {
					return failure
				}
				return nil
			})
			if failAt != "none" {
				if !errors.Is(err, failure) {
					t.Fatal(err)
				}
				return
			}
			if err != nil || len(deleted) != 2 || len(events) != 3 || len(uploads) != 1 || uploads[0].Receipt.State != "released" || uploads[0].Receipt.AcceptedOffset != "1048576" || !uploads[0].StorageReleased || len(transfers) != 1 || transfers[0].State != "closed" || transfers[0].CleanupFromState == nil || *transfers[0].CleanupFromState != "unknown" || string(transfers[0].Data) != string(state.Transfers[0].Data) {
				t.Fatalf("uploads=%+v transfers=%+v err=%v", uploads, transfers, err)
			}
		})
	}
}
