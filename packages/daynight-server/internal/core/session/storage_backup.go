package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type backupStorageReader interface {
	Open(context.Context, string, string) (filestorage.Object, error)
}

func backupMissingOnly(err error) bool {
	if err == nil || !errors.Is(err, fs.ErrNotExist) {
		return false
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		causes := joined.Unwrap()
		if len(causes) == 0 {
			return false
		}
		for _, cause := range causes {
			if !backupMissingOnly(cause) {
				return false
			}
		}
	} else if wrapped, ok := err.(interface{ Unwrap() error }); ok && wrapped.Unwrap() != nil {
		return backupMissingOnly(wrapped.Unwrap())
	}
	return true
}

func verifyStorageObject(ctx context.Context, files backupStorageReader, object store.StorageObject) (result error) {
	if object.ByteLength < 0 {
		return errors.New("invalid storage object length")
	}
	value, err := files.Open(ctx, object.Bucket, object.Path)
	if err != nil {
		if object.Optional && backupMissingOnly(err) {
			return nil
		}
		return err
	}
	defer func() { result = archiveCleanupFailure(result, value.Body.Close()) }()
	hash := sha256.New()
	length, err := io.Copy(hash, io.LimitReader(value.Body, object.ByteLength+1))
	if err != nil {
		return err
	}
	if length != object.ByteLength || hex.EncodeToString(hash.Sum(nil)) != object.SHA256 {
		return errors.New("storage object integrity check failed")
	}
	return nil
}
func readStorageObject(ctx context.Context, files backupStorageReader, object store.StorageObject) (data []byte, result error) {
	value, err := files.Open(ctx, object.Bucket, object.Path)
	if err != nil {
		return nil, err
	}
	defer func() { result = archiveCleanupFailure(result, value.Body.Close()) }()
	data, err = io.ReadAll(io.LimitReader(value.Body, object.ByteLength+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != object.ByteLength || archiveDigest(data) != object.SHA256 {
		return nil, errors.New("storage object integrity check failed")
	}
	return data, nil
}

// VerifyStorageBackup checks only the restored original bytes. Missing objects
// and corrupt known-available resources remain failures, never partial success.
func VerifyStorageBackup(ctx context.Context, files backupStorageReader, inventory store.StorageInventory) error {
	namespace, err := archiveNamespace(inventory.ProjectID, inventory.OwnerID, inventory.SessionID)
	if err != nil {
		return err
	}
	resources := map[string]store.SessionResourceRecord{}
	inline := map[string]bool{}
	for _, resource := range inventory.InlineResources {
		if resource.Resource.ByteLength == nil || resource.Resource.SHA256 == nil || decimal(int64(len(resource.Content))) != *resource.Resource.ByteLength || archiveDigest(resource.Content) != *resource.Resource.SHA256 {
			return errors.New("legacy database resource integrity check failed")
		}
		inline[resource.Resource.ResourceID] = true
	}
	for _, resource := range inventory.Resources {
		resources[resource.Resource.ResourceID] = resource
		if resource.Resource.Status != "available" || inline[resource.Resource.ResourceID] {
			continue
		}
		expected, err := BlobAddress(inventory.ProjectID, inventory.OwnerID, inventory.SessionID, resource.BlobID)
		if err != nil {
			return err
		}
		if expected != resource.BlobPath || resource.Resource.ByteLength == nil || resource.Resource.SHA256 == nil {
			return errors.New("saved resource has an invalid blob identity")
		}
		if err = verifyStorageObject(ctx, files, store.StorageObject{Bucket: sessionresource.Bucket, Path: expected, ByteLength: number(*resource.Resource.ByteLength), SHA256: *resource.Resource.SHA256}); err != nil {
			return err
		}
	}
	for _, object := range inventory.Objects {
		prefix := namespace.Directory() + "/"
		if object.Bucket != archiveBucket && object.Bucket != sessionresource.Bucket {
			return errors.New("unknown backup storage namespace")
		}
		if !strings.HasPrefix(object.Path, prefix) {
			return errors.New("backup object belongs to a different owner")
		}
		if err = verifyStorageObject(ctx, files, object); err != nil {
			return err
		}
	}
	if inventory.Migration != nil {
		if err = verifyBackupMigration(ctx, files, inventory); err != nil {
			return err
		}
	}
	if inventory.Archive == nil {
		return nil
	}
	archive := inventory.Archive
	expected, err := namespace.ObjectPath(archive.SHA256)
	if err != nil {
		return err
	}
	if expected != archive.Path {
		return errors.New("archive namespace does not match its owner")
	}
	limit := int64(sp.MaxArchiveBytes)
	if archive.SchemaVersion == 3 {
		limit = sp.MaxArchiveManifestBytes
	}
	if archive.ByteLength < 1 || archive.ByteLength > limit {
		return errors.New("archive length exceeds reader limits")
	}
	data, err := readStorageObject(ctx, files, store.StorageObject{Bucket: archiveBucket, Path: archive.Path, SHA256: archive.SHA256, ByteLength: archive.ByteLength})
	if err != nil {
		return err
	}
	switch archive.SchemaVersion {
	case 1:
		_, err = sp.DecodeArchive(data)
		return err
	case 2:
		_, err = v2.DecodeArchive(data)
		return err
	case 3:
		manifest, err := sp.DecodeArchiveManifest(data)
		if err != nil {
			return err
		}
		if manifest.RecordID != inventory.SessionID {
			return archiveConflict()
		}
		timeline, err := readStorageObject(ctx, files, store.StorageObject{Bucket: archiveBucket, Path: namespace.Directory() + "/files/" + manifest.Timeline.FileID + "/content", SHA256: manifest.Timeline.SHA256, ByteLength: number(manifest.Timeline.ByteLength)})
		if err != nil {
			return err
		}
		_, err = sp.VerifyArchiveClosure(manifest, timeline, func(ref sp.ArchiveResourceReference) ([]byte, error) {
			resource, ok := resources[ref.Resource.ResourceID]
			if !ok || ref.BlobID == nil || resource.BlobID != *ref.BlobID || !jsonEqual(encode(resource.Resource), encode(ref.Resource)) {
				return nil, archiveConflict()
			}
			return readStorageObject(ctx, files, store.StorageObject{Bucket: sessionresource.Bucket, Path: resource.BlobPath, SHA256: *ref.Resource.SHA256, ByteLength: number(*ref.Resource.ByteLength)})
		})
		return err
	default:
		return errors.New("unsupported archive reader version")
	}
}
