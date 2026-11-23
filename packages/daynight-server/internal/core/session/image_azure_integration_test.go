package session

import (
	"bytes"
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/container"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/azure"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	"github.com/google/uuid"
)

type azureImageStorage struct {
	*azure.Storage
	cleanupFailure error
}

func (s *azureImageStorage) DeleteSessionUpload(ctx context.Context, n sessionresource.Namespace, id string) error {
	if s.cleanupFailure != nil {
		return s.cleanupFailure
	}
	return s.Storage.DeleteSessionUpload(ctx, n, id)
}

func newAzureImageStorage(t *testing.T) *azureImageStorage {
	t.Helper()
	connection := os.Getenv("DAYNIGHT_TEST_AZURITE_CONNECTION_STRING")
	if connection == "" {
		t.Skip("DAYNIGHT_TEST_AZURITE_CONNECTION_STRING is unset")
	}
	name := "daynight-image-" + strings.ReplaceAll(uuid.NewString(), "-", "")
	client, err := container.NewClientFromConnectionString(connection, name, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.Create(t.Context(), nil); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := client.Delete(ctx, nil); err != nil {
			t.Error(err)
		}
	})
	gates, err := local.NewStandaloneGates(name)
	if err != nil {
		t.Fatal(err)
	}
	storage, err := azure.New(client, gates, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return &azureImageStorage{Storage: storage}
}

func TestAzureImageCompletionIntegrityAndCleanup(t *testing.T) {
	for _, tc := range []struct {
		name  string
		alter []byte
	}{
		{name: "length", alter: []byte("too short or too long")},
		{name: "digest", alter: []byte("other")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			storage := newAzureImageStorage(t)
			raw := []byte("image")
			f := newImageRuleFixtureWithStorage(t, raw, storage)
			f.prepare(t)
			if _, err := f.write(t, raw, 0); err != nil {
				t.Fatal(err)
			}
			chunk := f.d.chunks[f.spec.UploadID][0]
			if _, err := storage.Put(t.Context(), sessionresource.Bucket, chunk.Path, bytes.NewReader(tc.alter)); err != nil {
				t.Fatal(err)
			}
			if _, err := f.complete(t); err == nil || len(f.d.resources) != 0 {
				t.Fatalf("corrupt image became available: %v", err)
			}
		})
	}
	t.Run("verified and cleanup failure", func(t *testing.T) {
		storage := newAzureImageStorage(t)
		raw := []byte("verified image bytes")
		f := newImageRuleFixtureWithStorage(t, raw, storage)
		f.prepare(t)
		if _, err := f.write(t, raw, 0); err != nil {
			t.Fatal(err)
		}
		failure := errors.New("injected Azure upload cleanup failure")
		storage.cleanupFailure = failure
		receipt, err := f.complete(t)
		if !errors.Is(err, failure) || receipt.State != "complete" || receipt.Resource == nil || f.d.uploads[f.spec.UploadID].StorageReleased {
			t.Fatalf("cleanup failure lost responsibility: %+v %v", receipt, err)
		}
		data, descriptor, err := f.s.savedResource(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, receipt.Resource.ResourceID)
		if err != nil || !bytes.Equal(data, raw) || descriptor.SHA256 == nil || *descriptor.SHA256 != f.spec.SHA256 || descriptor.ByteLength == nil || *descriptor.ByteLength != f.spec.ByteLength {
			t.Fatalf("published image differs from verified content: %+v %v", descriptor, err)
		}
		storage.cleanupFailure = nil
		retry, err := f.complete(t)
		if err != nil || retry.State != "complete" || !f.d.uploads[f.spec.UploadID].StorageReleased {
			t.Fatalf("cleanup retry: %+v %v", retry, err)
		}
	})
}
