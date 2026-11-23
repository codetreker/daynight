package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"io"
	"io/fs"
	"sort"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/azure"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type migrationObjectReader interface {
	Open(context.Context, string, string) (filestorage.Object, error)
}
type migrationObjectTarget interface {
	migrationObjectReader
	PutIfAbsent(context.Context, string, string, io.Reader) (filestorage.FileInfo, error)
}

func migrationMissingOnly(err error) bool {
	if err == nil {
		return false
	}
	if response, ok := err.(*azcore.ResponseError); ok {
		return response.StatusCode == 404 && response.ErrorCode == "BlobNotFound"
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		if len(joined.Unwrap()) == 0 {
			return false
		}
		for _, cause := range joined.Unwrap() {
			if !migrationMissingOnly(cause) {
				return false
			}
		}
		return true
	}
	if wrapped, ok := err.(interface{ Unwrap() error }); ok && wrapped.Unwrap() != nil {
		return migrationMissingOnly(wrapped.Unwrap())
	}
	return errors.Is(err, fs.ErrNotExist)
}

type migrationRecordingReader struct {
	source  migrationObjectReader
	objects map[string]store.StorageObject
	report  func(StorageMigrationEvent) error
}

func digestMigrationObject(ctx context.Context, source migrationObjectReader, bucket, path string) (object store.StorageObject, result error) {
	value, err := source.Open(ctx, bucket, path)
	if err != nil {
		return object, err
	}
	defer func() { result = errors.Join(result, value.Body.Close()) }()
	hash := sha256.New()
	length, err := io.Copy(hash, value.Body)
	if err != nil {
		return object, err
	}
	if length != value.Info.Size {
		return object, errors.New("storage object differs from observed length")
	}
	return store.StorageObject{Bucket: bucket, Path: path, ByteLength: length, SHA256: hex.EncodeToString(hash.Sum(nil))}, nil
}

func (r *migrationRecordingReader) Open(ctx context.Context, bucket, path string) (filestorage.Object, error) {
	key := bucket + "\x00" + path
	if _, exists := r.objects[key]; !exists {
		object, err := digestMigrationObject(ctx, r.source, bucket, path)
		if err != nil {
			status := "read_failed"
			if migrationMissingOnly(err) {
				status = "source_missing"
			}
			return filestorage.Object{}, errors.Join(err, r.report(StorageMigrationEvent{Kind: "object", Status: status, Bucket: bucket, Path: path}))
		}
		r.objects[key] = object
	}
	return r.source.Open(ctx, bucket, path)
}

func migrationObjects(objects map[string]store.StorageObject) []store.StorageObject {
	keys := make([]string, 0, len(objects))
	for key := range objects {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]store.StorageObject, 0, len(keys))
	for _, key := range keys {
		result = append(result, objects[key])
	}
	return result
}

func copyMigrationObject(ctx context.Context, source migrationObjectReader, target migrationObjectTarget, object store.StorageObject, report func(StorageMigrationEvent) error) error {
	event := StorageMigrationEvent{Kind: "object", Bucket: object.Bucket, Path: object.Path, SHA256: object.SHA256, ByteLength: object.ByteLength}
	observed, err := digestMigrationObject(ctx, target, object.Bucket, object.Path)
	if err == nil {
		if observed.SHA256 != object.SHA256 || observed.ByteLength != object.ByteLength {
			event.Status = "target_conflict"
			return errors.Join(errors.New("migration target conflicts with source"), report(event))
		}
		event.Status = "reused"
		return report(event)
	}
	if !migrationMissingOnly(err) {
		event.Status = "read_failed"
		return errors.Join(err, report(event))
	}
	value, err := source.Open(ctx, object.Bucket, object.Path)
	if err != nil {
		event.Status = "read_failed"
		if migrationMissingOnly(err) {
			event.Status = "source_missing"
		}
		return errors.Join(err, report(event))
	}
	_, writeErr := target.PutIfAbsent(ctx, object.Bucket, object.Path, value.Body)
	closeErr := value.Body.Close()
	event.Publication = string(filestorage.PublicationOutcome(writeErr))
	if writeErr != nil && filestorage.PublicationOutcome(writeErr) == filestorage.NotPublished && !errors.Is(writeErr, azure.ErrTargetExists) {
		event.Status = "copy_failed"
		return errors.Join(writeErr, closeErr, report(event))
	}
	observed, err = digestMigrationObject(ctx, target, object.Bucket, object.Path)
	if err != nil {
		event.Status = "copy_failed"
		return errors.Join(writeErr, closeErr, err, report(event))
	}
	if observed.SHA256 != object.SHA256 || observed.ByteLength != object.ByteLength {
		event.Status = "target_conflict"
		return errors.Join(fmt.Errorf("migration target integrity mismatch"), writeErr, closeErr, report(event))
	}
	event.Status = "target_verified"
	if errors.Is(writeErr, azure.ErrTargetExists) {
		event.Status = "reused"
	}
	return errors.Join(closeErr, report(event))
}
