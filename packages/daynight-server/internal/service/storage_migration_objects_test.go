package service

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"strings"
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/azure"
)

type migrationReadFunc func(context.Context, string, string) (filestorage.Object, error)

func (f migrationReadFunc) Open(ctx context.Context, bucket, path string) (filestorage.Object, error) {
	return f(ctx, bucket, path)
}

type migrationCopyTarget struct {
	migrationReadFunc
	put func(context.Context, string, string, io.Reader) (filestorage.FileInfo, error)
}

func (t migrationCopyTarget) PutIfAbsent(ctx context.Context, bucket, path string, r io.Reader) (filestorage.FileInfo, error) {
	return t.put(ctx, bucket, path, r)
}

func migrationStringObject(value string) filestorage.Object {
	return filestorage.Object{Body: io.NopCloser(strings.NewReader(value)), Info: filestorage.FileInfo{Size: int64(len(value))}}
}

func TestStorageMigrationCopyOutcomes(t *testing.T) {
	for _, name := range []string{"new", "reused", "conflict", "unknown_verified", "unknown_absent", "racing_identical", "racing_conflict", "refused", "read_failed"} {
		t.Run(name, func(t *testing.T) {
			source := migrationReadFunc(func(ctx context.Context, bucket, path string) (filestorage.Object, error) {
				return migrationStringObject("original"), nil
			})
			object, err := digestMigrationObject(t.Context(), source, "bucket", "path")
			if err != nil {
				t.Fatal(err)
			}
			var saved *string
			if name == "reused" {
				value := "original"
				saved = &value
			}
			if name == "conflict" {
				value := "different"
				saved = &value
			}
			putCalls := 0
			failure := errors.New("request failed")
			target := migrationCopyTarget{
				migrationReadFunc: func(context.Context, string, string) (filestorage.Object, error) {
					if name == "read_failed" {
						return filestorage.Object{}, failure
					}
					if saved == nil {
						return filestorage.Object{}, errors.Join(fs.ErrNotExist, &azcore.ResponseError{StatusCode: 404, ErrorCode: "BlobNotFound"})
					}
					return migrationStringObject(*saved), nil
				},
				put: func(ctx context.Context, bucket, path string, r io.Reader) (filestorage.FileInfo, error) {
					putCalls++
					data, err := io.ReadAll(r)
					if err != nil {
						return filestorage.FileInfo{}, err
					}
					value := string(data)
					switch name {
					case "unknown_absent":
						return filestorage.FileInfo{}, &filestorage.PublicationError{Outcome: filestorage.PublicationUnknown, Cause: failure}
					case "refused":
						return filestorage.FileInfo{}, &filestorage.PublicationError{Outcome: filestorage.NotPublished, Cause: failure}
					case "racing_conflict":
						value = "different"
					}
					saved = &value
					if name == "unknown_verified" {
						return filestorage.FileInfo{}, &filestorage.PublicationError{Outcome: filestorage.PublicationUnknown, Cause: failure}
					}
					if name == "racing_identical" || name == "racing_conflict" {
						return filestorage.FileInfo{}, &filestorage.PublicationError{Outcome: filestorage.NotPublished, Cause: azure.ErrTargetExists}
					}
					return filestorage.FileInfo{Size: int64(len(value))}, nil
				},
			}
			var event StorageMigrationEvent
			err = copyMigrationObject(t.Context(), source, target, object, func(e StorageMigrationEvent) error { event = e; return nil })
			wantStatus := map[string]string{"new": "target_verified", "reused": "reused", "conflict": "target_conflict", "unknown_verified": "target_verified", "unknown_absent": "copy_failed", "racing_identical": "reused", "racing_conflict": "target_conflict", "refused": "copy_failed", "read_failed": "read_failed"}[name]
			wantFailure := name == "conflict" || name == "unknown_absent" || name == "racing_conflict" || name == "refused" || name == "read_failed"
			if (err != nil) != wantFailure || event.Status != wantStatus {
				t.Fatalf("event=%+v err=%v", event, err)
			}
			if name == "reused" || name == "conflict" || name == "read_failed" {
				if putCalls != 0 {
					t.Fatal("unexpected publication")
				}
			} else if putCalls != 1 {
				t.Fatal("publication repeated")
			}
			if name == "unknown_verified" && event.Publication != "unknown" {
				t.Fatal("lost unknown publication fact")
			}
		})
	}
}

func TestStorageMigrationMissingClassification(t *testing.T) {
	missing := errors.Join(fs.ErrNotExist, &azcore.ResponseError{StatusCode: 404, ErrorCode: "BlobNotFound"})
	if !migrationMissingOnly(missing) {
		t.Fatal("missing object not recognized")
	}
	if migrationMissingOnly(errors.Join(missing, errors.New("close failed"))) {
		t.Fatal("joined failure swallowed")
	}
	if migrationMissingOnly(nil) {
		t.Fatal("nil is not an absent object")
	}
}
