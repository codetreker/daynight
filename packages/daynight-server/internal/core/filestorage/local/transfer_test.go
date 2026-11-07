package local

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

const transferID = "7540b06e-11f4-4a2b-94af-f3e7ea790c85"
const otherTransferID = "7540b06e-11f4-4a2b-94af-f3e7ea790c86"
const objectID = "70b6f95f-23d4-4a9e-9f93-f24f29c066a9"

func transferNamespace(t *testing.T, id string) filestorage.TransferNamespace {
	t.Helper()
	n, err := filestorage.NewTransferNamespace(id)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestTransferObjectsAndRanges(t *testing.T) {
	s, _ := newStorage(t)
	n := transferNamespace(t, transferID)
	info, err := s.PutTransfer(t.Context(), n, objectID, strings.NewReader("abcdefgh"))
	if err != nil || info.Size != 8 {
		t.Fatalf("put: %+v %v", info, err)
	}
	for _, test := range []struct {
		offset, length int64
		want           string
	}{{0, 8, "abcdefgh"}, {2, 3, "cde"}, {7, 9, "h"}, {8, 1, ""}, {100, 1, ""}, {0, 0, ""}} {
		object, err := s.OpenTransferRange(t.Context(), n, objectID, test.offset, test.length)
		if err != nil {
			t.Fatal(err)
		}
		got, err := io.ReadAll(object.Body)
		if err != nil || object.Body.Close() != nil || string(got) != test.want || object.Info.Size != 8 {
			t.Fatalf("range %+v: %q %+v %v", test, got, object.Info, err)
		}
	}
	for _, test := range [][2]int64{{-1, 0}, {0, -1}} {
		if _, err := s.OpenTransferRange(t.Context(), n, objectID, test[0], test[1]); !errors.Is(err, filestorage.ErrInvalidAddress) {
			t.Fatalf("bad range: %v", err)
		}
	}
}

func TestTransferCleanupRemovesOnlyRecordedNamespace(t *testing.T) {
	s, root := newStorage(t)
	n, other := transferNamespace(t, transferID), transferNamespace(t, otherTransferID)
	for _, ns := range []filestorage.TransferNamespace{n, other} {
		if _, err := s.PutTransfer(t.Context(), ns, objectID, strings.NewReader("content")); err != nil {
			t.Fatal(err)
		}
	}
	// An interrupted publisher can leave a temporary file without a receipt.
	if err := os.WriteFile(filepath.Join(root, transferBucket, n.Directory(), ".daynight-upload-orphan"), []byte("orphan"), 0o600); err != nil {
		t.Fatal(err)
	}
	permit, err := s.AcquireGate(t.Context(), filestorage.PrivateGate, n.ID())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteTransferNamespace(t.Context(), n); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteTransferNamespace(t.Context(), n); err != nil {
		t.Fatal(err)
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.OpenTransfer(t.Context(), n, objectID); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("deleted object: %v", err)
	}
	object, err := s.OpenTransfer(t.Context(), other, objectID)
	if err != nil {
		t.Fatal(err)
	}
	if err := object.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, gateDirectory)); err != nil {
		t.Fatalf("control namespace: %v", err)
	}
}

func TestTransferRejectsInvalidIDsAndSymlinks(t *testing.T) {
	s, root := newStorage(t)
	for _, id := range []string{"", "..", transferID + "/child", strings.ToUpper(transferID), "00000000-0000-0000-0000-000000000000"} {
		n, err := filestorage.NewTransferNamespace(id)
		if !errors.Is(err, filestorage.ErrInvalidAddress) {
			t.Fatalf("namespace %q: %v", id, err)
		}
		if err := s.DeleteTransferNamespace(t.Context(), n); !errors.Is(err, filestorage.ErrInvalidAddress) {
			t.Fatalf("cleanup %q: %v", id, err)
		}
		if _, err := s.PutTransfer(t.Context(), transferNamespace(t, transferID), id, strings.NewReader("x")); !errors.Is(err, filestorage.ErrInvalidAddress) {
			t.Fatalf("object %q: %v", id, err)
		}
	}
	n := transferNamespace(t, transferID)
	outside := filepath.Join(root, "outside")
	if err := os.Mkdir(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "keep"), []byte("safe"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, transferBucket, transferID[:2]), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, transferBucket, n.Directory())); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteTransferNamespace(t.Context(), n); !errors.Is(err, filestorage.ErrNotRegular) {
		t.Fatalf("symlink: %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "keep")); err != nil {
		t.Fatal(err)
	}
}

func TestTransferCleanupFailureAndCancellationAreRetryable(t *testing.T) {
	s, _ := newStorage(t)
	n := transferNamespace(t, transferID)
	if _, err := s.PutTransfer(t.Context(), n, objectID, strings.NewReader("content")); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := s.DeleteTransferNamespace(ctx, n); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled cleanup: %v", err)
	}
	object, err := s.OpenTransfer(t.Context(), n, objectID)
	if err != nil {
		t.Fatal(err)
	}
	if err := object.Body.Close(); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("sync failed")
	s.fileSync = func(*os.File) error { return failure }
	if err := s.DeleteTransferNamespace(t.Context(), n); !errors.Is(err, failure) {
		t.Fatalf("cleanup hid failure: %v", err)
	}
	s.fileSync = (*os.File).Sync
	if err := s.DeleteTransferNamespace(t.Context(), n); err != nil {
		t.Fatalf("retry: %v", err)
	}
}

func TestTransferAvailableSpace(t *testing.T) {
	s, _ := newStorage(t)
	if size, err := s.AvailableTransferBytes(t.Context()); err != nil || size <= 0 {
		t.Fatalf("space: %d %v", size, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := s.AvailableTransferBytes(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	if _, err := transferAvailableBytes(1, 0); err == nil {
		t.Fatal("zero block size")
	}
	if size, err := transferAvailableBytes(math.MaxUint64, 4096); err != nil || size != math.MaxInt64 {
		t.Fatalf("overflow: %d %v", size, err)
	}
}
