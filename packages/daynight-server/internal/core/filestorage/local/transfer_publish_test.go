package local

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

func TestPublishTransferAttachment(t *testing.T) {
	s, _ := newStorage(t)
	n := transferNamespace(t, transferID)
	target, err := filestorage.NewTransferAttachmentTarget(transferID, otherTransferID, "dir/file")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.PutTransfer(t.Context(), n, objectID, strings.NewReader("complete")); err != nil {
		t.Fatal(err)
	}
	if err := s.PublishTransferAttachment(t.Context(), n, objectID, target); err != nil {
		t.Fatal(err)
	}
	if _, err := s.OpenTransfer(t.Context(), n, objectID); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("source still present: %v", err)
	}
	if err := s.DeleteTransferNamespace(t.Context(), n); err != nil {
		t.Fatal(err)
	}
	object, err := s.Open(t.Context(), "task-attachments", target.Path())
	if err != nil {
		t.Fatal(err)
	}
	data, readErr := io.ReadAll(object.Body)
	if closeErr := object.Body.Close(); readErr != nil || closeErr != nil || string(data) != "complete" {
		t.Fatalf("target = %q, read = %v, close = %v", data, readErr, closeErr)
	}
}

func TestPublishTransferRejectsNamespaceSymlink(t *testing.T) {
	s, root := newStorage(t)
	n, other := transferNamespace(t, transferID), transferNamespace(t, otherTransferID)
	if _, err := s.PutTransfer(t.Context(), other, objectID, strings.NewReader("other")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, transferBucket, other.Directory()), filepath.Join(root, transferBucket, n.Directory())); err != nil {
		t.Fatal(err)
	}
	target, err := filestorage.NewTransferAttachmentTarget(transferID, otherTransferID, "file")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.PublishTransferAttachment(t.Context(), n, objectID, target); !errors.Is(err, filestorage.ErrNotRegular) {
		t.Fatalf("namespace symlink: %v", err)
	}
	object, err := s.OpenTransfer(t.Context(), other, objectID)
	if err != nil {
		t.Fatalf("other transfer changed: %v", err)
	}
	if err := object.Body.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestPublishTransferAttachmentValidationAndSyncFailure(t *testing.T) {
	s, _ := newStorage(t)
	n := transferNamespace(t, transferID)
	for _, relative := range []string{"", "../x", "/absolute", "a/../b"} {
		if _, err := filestorage.NewTransferAttachmentTarget(transferID, otherTransferID, relative); !errors.Is(err, filestorage.ErrInvalidAddress) {
			t.Fatalf("target %q: %v", relative, err)
		}
	}
	if err := s.PublishTransferAttachment(t.Context(), n, objectID, filestorage.TransferAttachmentTarget{}); !errors.Is(err, filestorage.ErrInvalidAddress) {
		t.Fatalf("zero target: %v", err)
	}
	target, err := filestorage.NewTransferAttachmentTarget(transferID, otherTransferID, "file")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.PutTransfer(t.Context(), n, objectID, strings.NewReader("published")); err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("directory sync failed")
	s.fileSync = func(*os.File) error { return sentinel }
	if err := s.PublishTransferAttachment(t.Context(), n, objectID, target); !errors.Is(err, sentinel) {
		t.Fatalf("sync failure lost: %v", err)
	}
	s.fileSync = (*os.File).Sync
	object, err := s.Open(t.Context(), "task-attachments", target.Path())
	if err != nil {
		t.Fatalf("rename occurred before sync failure: %v", err)
	}
	if err := object.Body.Close(); err != nil {
		t.Fatal(err)
	}
}
