package local

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	"github.com/google/uuid"
)

func TestResourceNamespaceCleanupAndVolumeAdmission(t *testing.T) {
	storage, e := New(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer storage.Close()
	owner, id := uuid.NewString(), uuid.NewString()
	n, e := sessionresource.NewNamespace("", owner, id)
	if e != nil {
		t.Fatal(e)
	}
	other, _ := sessionresource.NewNamespace("", owner, uuid.NewString())
	blob := uuid.NewString()
	path, _ := n.BlobPath(blob)
	otherPath, _ := other.BlobPath(blob)
	for _, p := range []string{path, otherPath} {
		if _, e = storage.Put(t.Context(), sessionresource.Bucket, p, strings.NewReader("original")); e != nil {
			t.Fatal(e)
		}
	}
	if e = storage.DeleteSessionResources(t.Context(), n); e != nil {
		t.Fatal(e)
	}
	if e = storage.DeleteSessionResources(t.Context(), n); e != nil {
		t.Fatal("absence is idempotent", e)
	}
	if _, e = storage.Open(t.Context(), sessionresource.Bucket, path); !errors.Is(e, fs.ErrNotExist) {
		t.Fatal("deleted namespace is readable", e)
	}
	object, e := storage.Open(t.Context(), sessionresource.Bucket, otherPath)
	if e != nil {
		t.Fatal("unrelated namespace removed", e)
	}
	bytes, e := io.ReadAll(object.Body)
	e = errors.Join(e, object.Body.Close())
	if e != nil || string(bytes) != "original" {
		t.Fatal("unrelated resource changed", e)
	}
	if e = storage.DeleteSessionResources(t.Context(), sessionresource.Namespace{}); !errors.Is(e, filestorage.ErrInvalidAddress) {
		t.Fatal("invalid namespace accepted", e)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if e = storage.DeleteSessionResources(ctx, other); !errors.Is(e, context.Canceled) {
		t.Fatal("cleanup ignored cancellation", e)
	}
	available, total, e := storage.ResourceSpace(t.Context())
	if e != nil || available < 0 || total < available || total <= 0 {
		t.Fatal("volume facts", available, total, e)
	}
	if _, _, e = storage.ResourceSpace(ctx); !errors.Is(e, context.Canceled) {
		t.Fatal("volume ignored cancellation", e)
	}
}

func TestResourceLeaseGatesNeverShareAStripeWithNestedWork(t *testing.T) {
	root := t.TempDir()
	storage, e := New(root)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = storage.Close() })
	other, e := New(root)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = other.Close() })
	first := "session-image-upload/original"
	stripe := sha256.Sum256([]byte(first))[0]
	collision := ""
	for i := 0; i < 10000; i++ {
		key := fmt.Sprintf("session-resource-lease/%d", i)
		if sha256.Sum256([]byte(key))[0] == stripe {
			collision = key
			break
		}
	}
	if collision == "" {
		t.Fatal("collision fixture missing")
	}
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	upload, e := storage.AcquireGate(ctx, filestorage.PrivateGate, first)
	if e != nil {
		t.Fatal(e)
	}
	defer upload.Close()
	lease, e := storage.AcquireGate(ctx, filestorage.MediaLeaseGate, collision)
	if e != nil {
		t.Fatal("nested exact lease collided with upload stripe", e)
	}
	defer lease.Close()
	blocked, stop := context.WithTimeout(t.Context(), 30*time.Millisecond)
	_, e = other.AcquireGate(blocked, filestorage.MediaLeaseGate, collision)
	stop()
	if !errors.Is(e, context.DeadlineExceeded) {
		t.Fatal("same exact lease did not block across instances", e)
	}
	if e = lease.Close(); e != nil {
		t.Fatal(e)
	}
	resumed, e := other.AcquireGate(ctx, filestorage.MediaLeaseGate, collision)
	if e != nil {
		t.Fatal(e)
	}
	_ = resumed.Close()
}
