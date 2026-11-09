package session

import (
	"context"
	"errors"
	"io"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func readBackupMigrationObject(ctx context.Context, files backupStorageReader, path, digest string, limit int64) (data []byte, result error) {
	object, err := files.Open(ctx, archiveBucket, path)
	if err != nil {
		return nil, err
	}
	defer func() { result = archiveCleanupFailure(result, object.Body.Close()) }()
	if object.Info.Size < 1 || object.Info.Size > limit {
		return nil, errors.New("migration object exceeds its reader budget")
	}
	data, err = io.ReadAll(io.LimitReader(object.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != object.Info.Size || archiveDigest(data) != digest {
		return nil, errors.New("migration object integrity check failed")
	}
	return data, nil
}

func verifyBackupMigration(ctx context.Context, files backupStorageReader, inventory store.StorageInventory) error {
	m := inventory.Migration
	namespace, err := archiveNamespace(inventory.ProjectID, inventory.OwnerID, inventory.SessionID)
	if err != nil {
		return err
	}
	sourcePath, err := namespace.ObjectPath(m.SourceHash)
	if err != nil {
		return err
	}
	targetPath, err := namespace.ObjectPath(m.TargetHash)
	if err != nil {
		return err
	}
	id, err := uuid.Parse(inventory.SessionID)
	if err != nil {
		return err
	}
	migrationID := uuid.NewSHA1(id, []byte(m.SourceHash))
	if m.SessionID != inventory.SessionID || m.SourcePath != sourcePath || m.TargetPath != targetPath || m.MigrationID != migrationID.String() {
		return archiveConflict()
	}
	source, err := readBackupMigrationObject(ctx, files, m.SourcePath, m.SourceHash, sp.MaxArchiveBytes)
	if err != nil {
		return err
	}
	if int64(len(source)) != m.SourceLength {
		return archiveConflict()
	}
	plan, err := convertLegacyArchive(source, migrationID)
	if err != nil {
		return err
	}
	if plan.Original.SessionID != inventory.SessionID {
		return archiveConflict()
	}
	switch m.Phase {
	case "prepared":
		return nil
	case "files_durable":
	case "committed", "verified":
		if inventory.Archive == nil || inventory.Archive.SchemaVersion != 3 || inventory.Archive.Path != m.TargetPath || inventory.Archive.SHA256 != m.TargetHash {
			return archiveConflict()
		}
	default:
		return errors.New("unsupported archive migration phase")
	}
	target, err := readBackupMigrationObject(ctx, files, m.TargetPath, m.TargetHash, sp.MaxArchiveManifestBytes)
	if err != nil {
		return err
	}
	manifest, err := sp.DecodeArchiveManifest(target)
	if err != nil {
		return err
	}
	if len(plan.Manifest.Resources) != len(manifest.Resources) {
		return archiveConflict()
	}
	for i, ref := range manifest.Resources {
		expected := &plan.Manifest.Resources[i]
		if !jsonEqual(encode(ref.Resource), encode(expected.Resource)) {
			return archiveConflict()
		}
		if ref.Resource.Status != "available" {
			continue
		}
		if ref.BlobID == nil {
			return archiveConflict()
		}
		if expected.BlobID == nil || *expected.BlobID != *ref.BlobID {
			reused := false
			for _, record := range inventory.Resources {
				if record.Resource.ResourceID == ref.Resource.ResourceID && record.BlobID == *ref.BlobID && jsonEqual(encode(record.Resource), encode(ref.Resource)) {
					reused = true
					break
				}
			}
			if !reused {
				return archiveConflict()
			}
		}
		expected.BlobID = ref.BlobID
	}
	if !jsonEqual(encode(plan.Manifest), encode(manifest)) {
		return archiveConflict()
	}
	timeline, err := readStorageObject(ctx, files, store.StorageObject{Bucket: archiveBucket, Path: namespace.Directory() + "/files/" + manifest.Timeline.FileID + "/content", SHA256: manifest.Timeline.SHA256, ByteLength: number(manifest.Timeline.ByteLength)})
	if err != nil {
		return err
	}
	for _, resource := range plan.Resources {
		if resource.Resource.Status != "available" {
			continue
		}
		for _, saved := range inventory.Resources {
			if saved.Resource.ResourceID == resource.Resource.ResourceID && jsonEqual(encode(saved.Resource), encode(resource.Resource)) && saved.BlobID != "" {
				resource = saved
				break
			}
		}
		path, e := BlobAddress(inventory.ProjectID, inventory.OwnerID, inventory.SessionID, resource.BlobID)
		if e != nil {
			return e
		}
		if e = verifyStorageObject(ctx, files, store.StorageObject{Bucket: sessionresource.Bucket, Path: path, SHA256: *resource.Resource.SHA256, ByteLength: number(*resource.Resource.ByteLength)}); e != nil {
			return e
		}
	}
	_, err = sp.VerifyArchiveClosure(manifest, timeline, func(ref sp.ArchiveResourceReference) ([]byte, error) {
		path, e := BlobAddress(inventory.ProjectID, inventory.OwnerID, inventory.SessionID, *ref.BlobID)
		if e != nil {
			return nil, e
		}
		return readStorageObject(ctx, files, store.StorageObject{Bucket: sessionresource.Bucket, Path: path, SHA256: *ref.Resource.SHA256, ByteLength: number(*ref.Resource.ByteLength)})
	})
	return err
}
