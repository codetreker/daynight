package local

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	"github.com/google/uuid"
)

func TestDeleteSessionUploadSweepsOrphansAndRetainsOtherOwners(t *testing.T) {
	storage, _ := newStorage(t)
	namespace, _ := sessionresource.NewNamespace("", archiveOwner, archiveSession)
	upload := uuid.NewString()
	path, _ := namespace.UploadPath(upload)
	other, _ := namespace.ChunkPath(uuid.NewString(), 0)
	blob, _ := namespace.BlobPath(uuid.NewString())
	for _, name := range []string{path + "/0", path + "/no-metadata", path + "/.daynight-upload-interrupted", other, blob} {
		put(t, storage, sessionresource.Bucket, name, []byte("original"))
	}
	if err := storage.DeleteSessionUpload(t.Context(), namespace, upload); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{path + "/0", path + "/no-metadata", path + "/.daynight-upload-interrupted"} {
		if o, err := storage.Open(t.Context(), sessionresource.Bucket, name); !errors.Is(err, fs.ErrNotExist) {
			if err == nil {
				_ = o.Body.Close()
			}
			t.Fatal("orphan survived sweep", name, err)
		}
	}
	for _, name := range []string{other, blob} {
		if got := string(read(t, storage, sessionresource.Bucket, name)); got != "original" {
			t.Fatal("unrelated original changed", name, got)
		}
	}
	if err := storage.DeleteSessionUpload(t.Context(), namespace, upload); err != nil {
		t.Fatal("absence retry", err)
	}
	for _, id := range []string{"", "../uploads", uuid.Nil.String(), strings.ToUpper(upload)} {
		if err := storage.DeleteSessionUpload(t.Context(), namespace, id); !errors.Is(err, filestorage.ErrInvalidAddress) {
			t.Fatal("invalid upload accepted", id, err)
		}
	}
	if err := storage.DeleteSessionUpload(t.Context(), sessionresource.Namespace{}, upload); !errors.Is(err, filestorage.ErrInvalidAddress) {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := storage.DeleteSessionUpload(ctx, namespace, upload); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled sweep succeeded", err)
	}
}

func TestDeleteSessionUploadRequiresDurableAbsenceAndRejectsDirectoryAlias(t *testing.T) {
	storage, root := newStorage(t)
	namespace, _ := sessionresource.NewNamespace("", archiveOwner, archiveSession)
	upload := uuid.NewString()
	path, _ := namespace.UploadPath(upload)
	put(t, storage, sessionresource.Bucket, path+"/orphan", []byte("original"))
	cause := errors.New("parent fsync unavailable")
	sync := storage.fileSync
	calls := 0
	storage.fileSync = func(*os.File) error { calls++; return cause }
	if err := storage.DeleteSessionUpload(t.Context(), namespace, upload); !errors.Is(err, cause) {
		t.Fatal("unconfirmed absence became success", err)
	}
	if err := storage.DeleteSessionUpload(t.Context(), namespace, upload); !errors.Is(err, cause) || calls != 2 {
		t.Fatal("retry omitted durable absence barrier", calls, err)
	}
	storage.fileSync = sync
	if err := storage.DeleteSessionUpload(t.Context(), namespace, upload); err != nil {
		t.Fatal(err)
	}
	protected := filepath.Join(root, "protected")
	if err := os.MkdirAll(protected, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(protected, "keep"), []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(protected, filepath.Join(root, sessionresource.Bucket, path)); err != nil {
		t.Fatal(err)
	}
	if err := storage.DeleteSessionUpload(t.Context(), namespace, upload); !errors.Is(err, filestorage.ErrNotRegular) {
		t.Fatal("namespace alias followed", err)
	}
	if got, err := os.ReadFile(filepath.Join(protected, "keep")); err != nil || string(got) != "original" {
		t.Fatal("alias changed protected bytes", err)
	}
}
