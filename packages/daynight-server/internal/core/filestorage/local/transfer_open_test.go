package local

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

func TestOpenTransferRejectsInvalidAndUnavailableObjects(t *testing.T) {
	s, _ := newStorage(t)
	ns := transferNamespace(t, transferID)
	if _, err := s.OpenTransfer(t.Context(), filestorage.TransferNamespace{}, objectID); !errors.Is(err, filestorage.ErrInvalidAddress) {
		t.Fatalf("invalid namespace: %v", err)
	}
	if _, err := s.OpenTransfer(t.Context(), ns, "../escape"); !errors.Is(err, filestorage.ErrInvalidAddress) {
		t.Fatalf("invalid object: %v", err)
	}
	if _, err := s.OpenTransfer(t.Context(), ns, objectID); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing object: %v", err)
	}
	if _, err := s.PutTransfer(t.Context(), ns, objectID, strings.NewReader("private content")); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := s.OpenTransfer(ctx, ns, objectID); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled open: %v", err)
	}
	object, err := s.OpenTransfer(t.Context(), ns, objectID)
	if err != nil {
		t.Fatal(err)
	}
	contents, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || string(contents) != "private content" {
		t.Fatalf("open content: %q, read %v, close %v", contents, readErr, closeErr)
	}
}
