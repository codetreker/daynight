package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	storageconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
)

type StorageMigrationEvent struct {
	RunID       string           `json:"runId"`
	Kind        string           `json:"kind"`
	Status      string           `json:"status"`
	SessionID   string           `json:"sessionId,omitempty"`
	FileID      string           `json:"fileId,omitempty"`
	Bucket      string           `json:"bucket,omitempty"`
	Path        string           `json:"path,omitempty"`
	SHA256      string           `json:"sha256,omitempty"`
	ByteLength  int64            `json:"byteLength,omitempty"`
	Publication string           `json:"publication,omitempty"`
	Detail      string           `json:"detail,omitempty"`
	Observer    string           `json:"observer,omitempty"`
	Counts      map[string]int64 `json:"counts,omitempty"`
}

type migrationDatabase interface {
	ReadOfflineStorageState(context.Context) (store.OfflineStorageState, error)
	VerifyStorageInventory(context.Context, func(store.StorageInventory) error) error
	VerifyOfflineAttachments(context.Context, func(model.Attachment) error) error
	ApplyOfflineStorageTransition(context.Context, store.OfflineStorageState, []store.SessionUploadRecord, []model.PrivateTransfer, []store.OfflineArchiveRevocation) (store.Completion, error)
}

type migrationTarget interface {
	migrationObjectTarget
	Delete(context.Context, string, string) error
	DeleteSessionUpload(context.Context, sessionresource.Namespace, string) error
	DeleteTransferNamespace(context.Context, filestorage.TransferNamespace) error
}

// MigrateStorage operates on a restored offline destination and an immutable
// paired local volume. It never starts services or updates the source volume.
func MigrateStorage(ctx context.Context, databaseURL, sourceRoot string, target storageconfig.Config, report func(StorageMigrationEvent) error) (result error) {
	if target.BackendName() != "azure-blob" {
		return errors.New("offline migration requires an explicit Azure destination")
	}
	if err := validateMigrationRoots(sourceRoot, target.Root); err != nil {
		return err
	}
	if report == nil {
		return errors.New("migration requires an operation report")
	}
	database, err := postgres.OpenOfflineStorageMigration(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer database.Close()
	source, err := local.OpenReadOnly(sourceRoot)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, source.Close()) }()
	startup, cancel := context.WithTimeout(ctx, 30*time.Second)
	files, err := openAzureFileStorage(startup, target, nil, nil)
	cancel()
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, files.Close()) }()
	return migrateStorage(ctx, database, source, files.(*azureFileStorage), report)
}

func validateMigrationRoots(source, scratch string) error {
	resolve := func(path string) (string, error) {
		if !filepath.IsAbs(path) {
			return "", errors.New("migration roots must be absolute")
		}
		path = filepath.Clean(path)
		var suffix []string
		for {
			resolved, err := filepath.EvalSymlinks(path)
			if err == nil {
				for i := len(suffix) - 1; i >= 0; i-- {
					resolved = filepath.Join(resolved, suffix[i])
				}
				if runtime.GOOS == "windows" {
					resolved = strings.ToLower(resolved)
				}
				return resolved, nil
			}
			if !os.IsNotExist(err) || filepath.Dir(path) == path {
				return "", err
			}
			suffix = append(suffix, filepath.Base(path))
			path = filepath.Dir(path)
		}
	}
	a, err := resolve(source)
	if err != nil {
		return err
	}
	b, err := resolve(scratch)
	if err != nil {
		return err
	}
	contains := func(parent, child string) bool {
		rel, err := filepath.Rel(parent, child)
		return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
	}
	if contains(a, b) || contains(b, a) {
		return errors.New("migration source and scratch directories must not overlap")
	}
	return nil
}

func migrateStorage(ctx context.Context, database migrationDatabase, source migrationObjectReader, target migrationTarget, report func(StorageMigrationEvent) error) (result error) {
	runID := uuid.NewString()
	counts := map[string]int64{"verified": 0, "reused": 0, "skipped": 0, "missing": 0, "conflict": 0, "read_failed": 0, "copy_failed": 0, "pending": 0}
	emit := func(event StorageMigrationEvent) error {
		event.RunID = runID
		switch event.Status {
		case "target_verified":
			counts["verified"]++
		case "reused":
			counts["reused"]++
		case "skipped":
			counts["skipped"]++
		case "source_missing":
			counts["missing"]++
		case "target_conflict":
			counts["conflict"]++
		case "read_failed":
			counts["read_failed"]++
		case "copy_failed":
			counts["copy_failed"]++
		case "publication_observed":
			counts["pending"]++
		case "unknown":
			if event.Kind == "state" {
				counts["pending"]++
			}
		}
		return report(event)
	}
	defer func() {
		status := "verified"
		if result != nil {
			status = "failed"
		}
		result = errors.Join(result, emit(StorageMigrationEvent{Kind: "summary", Status: status, Counts: counts}))
	}()
	if err := emit(StorageMigrationEvent{Kind: "migration", Status: "started"}); err != nil {
		return err
	}
	state, err := database.ReadOfflineStorageState(ctx)
	if err != nil {
		return err
	}
	if err = sessioncore.ValidateOfflineStorageState(state); err != nil {
		return err
	}
	revocations, err := sessioncore.PlanOfflineArchiveRevocations(state)
	if err != nil {
		return err
	}
	if err = verifyOfflinePublicationAbsence(ctx, source, target, state, emit); err != nil {
		return err
	}
	recorder := &migrationRecordingReader{source: source, objects: map[string]store.StorageObject{}, report: emit}
	verify := func(reader migrationObjectReader, project bool, stage string) error {
		return database.VerifyStorageInventory(ctx, func(inventory store.StorageInventory) error {
			if project {
				var err error
				inventory, err = sessioncore.ProjectOfflineStorageInventory(inventory, state)
				if err != nil {
					return err
				}
			}
			if stage == "source" {
				objects := make([]store.StorageObject, 0, len(inventory.Objects))
				for _, object := range inventory.Objects {
					if object.Optional {
						value, err := source.Open(ctx, object.Bucket, object.Path)
						if migrationMissingOnly(err) {
							if err = emit(StorageMigrationEvent{Kind: "object", Status: "skipped", Bucket: object.Bucket, Path: object.Path, Detail: "unconfirmed optional source object absent"}); err != nil {
								return err
							}
							continue
						}
						if err != nil {
							return err
						}
						if err = value.Body.Close(); err != nil {
							return err
						}
					}
					objects = append(objects, object)
				}
				inventory.Objects = objects
			}
			if err := sessioncore.VerifyStorageBackup(ctx, reader, inventory); err != nil {
				return errors.Join(err, emit(StorageMigrationEvent{Kind: "session", Status: stage + "_mismatch", SessionID: inventory.SessionID}))
			}
			return nil
		})
	}
	if err = verify(recorder, true, "source"); err != nil {
		return err
	}
	if err = database.VerifyOfflineAttachments(ctx, func(a model.Attachment) error {
		address, err := attachment.NewAddress(a.ProjectID, a.TaskID, a.Path)
		if err != nil {
			return err
		}
		object, err := recorder.Open(ctx, attachment.Bucket, address.StoragePath)
		if err != nil {
			return err
		}
		if closeErr := object.Body.Close(); closeErr != nil {
			return closeErr
		}
		if object.Info.Size != a.SizeBytes {
			return errors.Join(errors.New("attachment source length differs from metadata"), emit(StorageMigrationEvent{Kind: "object", Status: "source_mismatch", Bucket: attachment.Bucket, Path: address.StoragePath}))
		}
		return nil
	}); err != nil {
		return err
	}
	for _, object := range migrationObjects(recorder.objects) {
		if err = copyMigrationObject(ctx, source, target, object, emit); err != nil {
			return err
		}
	}
	if err = verify(target, true, "target"); err != nil {
		return err
	}
	uploads, transfers, err := cleanupOfflineStorage(ctx, target, state, emit)
	if err != nil {
		return err
	}
	completion, err := database.ApplyOfflineStorageTransition(ctx, state, uploads, transfers, revocations)
	if reportErr := emit(StorageMigrationEvent{Kind: "state", Status: string(completion.Outcome)}); err != nil || reportErr != nil {
		return errors.Join(err, reportErr)
	}
	if completion.Outcome != store.TransactionCommitted {
		return fmt.Errorf("offline state transition outcome %s", completion.Outcome)
	}
	remaining, err := database.ReadOfflineStorageState(ctx)
	if err != nil {
		return err
	}
	if len(remaining.ArchiveFiles)+len(remaining.Uploads)+len(remaining.Transfers) != 0 {
		return errors.New("offline transition readback still contains unfinished work")
	}
	if err = verify(target, false, "target"); err != nil {
		return err
	}
	return emit(StorageMigrationEvent{Kind: "migration", Status: "verified"})
}
