package service

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func verifyOfflinePublicationAbsence(ctx context.Context, source, target migrationObjectReader, state store.OfflineStorageState, report func(StorageMigrationEvent) error) error {
	check := func(bucket, path, sessionID, fileID string) error {
		for i, reader := range []migrationObjectReader{source, target} {
			object, err := reader.Open(ctx, bucket, path)
			if err == nil {
				observer := "source"
				if i == 1 {
					observer = "target"
				}
				return errors.Join(errors.New("unfinished upload has observable formal publication"), object.Body.Close(), report(StorageMigrationEvent{Kind: "state", Status: "publication_observed", Observer: observer, SessionID: sessionID, FileID: fileID, Bucket: bucket, Path: path}))
			}
			if !migrationMissingOnly(err) {
				return err
			}
		}
		return nil
	}
	for _, item := range state.ArchiveFiles {
		bucket, path := sessionarchive.Bucket, item.File.Path+"/content"
		if item.File.Purpose == "resource" {
			bucket, path = sessionresource.Bucket, item.File.Path
		}
		if err := check(bucket, path, item.File.SessionID, item.File.FileID); err != nil {
			return err
		}
	}
	for _, item := range state.Uploads {
		path, err := sessioncore.BlobAddress(item.ProjectID, item.OwnerID, item.Upload.SessionID, item.Upload.BlobID)
		if err != nil {
			return err
		}
		if err = check(sessionresource.Bucket, path, item.Upload.SessionID, item.Upload.Spec.UploadID); err != nil {
			return err
		}
	}
	for _, record := range state.Transfers {
		unknown := record.State == "committing" || record.State == "unknown" || record.CleanupFromState != nil && (*record.CleanupFromState == "committing" || *record.CleanupFromState == "unknown")
		if record.Direction != "upload" || !unknown {
			continue
		}
		address, err := filestorage.NewTransferAttachmentTarget(record.ProjectID, record.TaskID, record.Path)
		if err != nil {
			return err
		}
		if err = check("task-attachments", address.Path(), "", record.ID); err != nil {
			return err
		}
	}
	return nil
}

func cleanupOfflineStorage(ctx context.Context, target migrationTarget, state store.OfflineStorageState, report func(StorageMigrationEvent) error) ([]store.SessionUploadRecord, []model.PrivateTransfer, error) {
	for _, item := range state.ArchiveFiles {
		for _, chunk := range item.Chunks {
			if err := target.Delete(ctx, chunk.Bucket, chunk.Path); err != nil {
				return nil, nil, err
			}
		}
		n, err := archiveMigrationNamespace(item.ProjectID, item.OwnerID, item.File.SessionID)
		if err != nil {
			return nil, nil, err
		}
		path, err := filestorage.ArchiveStagingPath(n, item.File.FileID)
		if err != nil {
			return nil, nil, err
		}
		if err = target.Delete(ctx, sessionarchive.Bucket, path); err != nil {
			return nil, nil, err
		}
		if err = report(StorageMigrationEvent{Kind: "state", Status: "archive_revocation_ready", SessionID: item.File.SessionID, FileID: item.File.FileID}); err != nil {
			return nil, nil, err
		}
	}
	uploads := make([]store.SessionUploadRecord, 0, len(state.Uploads))
	for _, item := range state.Uploads {
		n, err := sessionresource.NewNamespace(item.ProjectID, item.OwnerID, item.Upload.SessionID)
		if err != nil {
			return nil, nil, err
		}
		if err = target.DeleteSessionUpload(ctx, n, item.Upload.Spec.UploadID); err != nil {
			return nil, nil, err
		}
		upload, err := sessioncore.ReleaseOfflineImageUpload(item.Upload)
		if err != nil {
			return nil, nil, err
		}
		uploads = append(uploads, upload)
		if err = report(StorageMigrationEvent{Kind: "state", Status: "image_release_ready", SessionID: upload.SessionID, FileID: upload.Spec.UploadID}); err != nil {
			return nil, nil, err
		}
	}
	transfers := make([]model.PrivateTransfer, 0, len(state.Transfers))
	for _, record := range state.Transfers {
		n, err := filestorage.NewTransferNamespace(record.ID)
		if err != nil {
			return nil, nil, err
		}
		if err = target.DeleteTransferNamespace(ctx, n); err != nil {
			return nil, nil, err
		}
		closed, err := mcptransfer.CloseOfflineTransfer(record, time.Now().UTC())
		if err != nil {
			return nil, nil, err
		}
		transfers = append(transfers, closed)
		if err = report(StorageMigrationEvent{Kind: "state", Status: "transfer_close_ready", FileID: record.ID}); err != nil {
			return nil, nil, err
		}
	}
	return uploads, transfers, nil
}

func archiveMigrationNamespace(project, owner, id string) (sessionarchive.Namespace, error) {
	if project != "" {
		return sessionarchive.NewNamespace(sessionarchive.Projects, project, id)
	}
	return sessionarchive.NewNamespace(sessionarchive.Users, owner, id)
}
