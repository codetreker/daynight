package local

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

func TestResidencyExactNonblocking(t *testing.T) {
	first, root := newStorage(t)
	second, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = second.Close() })
	key := "owner-1"
	stripe := sha256.Sum256([]byte(key))[0]
	var other string
	for i := 2; ; i++ {
		other = fmt.Sprintf("owner-%d", i)
		if sha256.Sum256([]byte(other))[0] == stripe {
			break
		}
	}
	permit, err := first.TryAcquireResidency(t.Context(), key)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = permit.Close() })
	for _, storage := range []*Storage{first, second} {
		if _, err := storage.TryAcquireResidency(t.Context(), key); !errors.Is(err, filestorage.ErrGateBusy) {
			t.Fatalf("same-key contention: %v", err)
		}
	}
	distinct, err := second.TryAcquireResidency(t.Context(), other)
	if err != nil {
		t.Fatalf("distinct residency key: %v", err)
	}
	if err := distinct.Close(); err != nil {
		t.Fatal(err)
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := second.TryAcquireResidency(t.Context(), key)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := first.TryAcquireResidency(t.Context(), key); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("previous permit released reacquired key: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, gateDirectory)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("residency created a control directory: %v", err)
	}
}

func TestResidencyRejectsCanceledAndClosed(t *testing.T) {
	storage, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := storage.TryAcquireResidency(ctx, "key"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled: %v", err)
	}
	if _, err := storage.TryAcquireResidency(t.Context(), ""); err == nil {
		t.Fatal("empty key accepted")
	}
	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.TryAcquireResidency(t.Context(), "key"); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("acquire after close: %v", err)
	}
}

func TestResidencyPermitOutlivesStorageRootClose(t *testing.T) {
	root := t.TempDir()
	first, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	second, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	permit, err := first.TryAcquireResidency(t.Context(), "key")
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := second.TryAcquireResidency(t.Context(), "key"); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("root close released live permit: %v", err)
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := second.TryAcquireResidency(t.Context(), "key")
	if err != nil {
		t.Fatal(err)
	}
	if err := next.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestMediaGateSharesExactResidencyKey(t *testing.T) {
	storage, _ := newStorage(t)
	blocking, err := storage.AcquireGate(t.Context(), filestorage.MediaLeaseGate, "session")
	if err != nil {
		t.Fatal(err)
	}
	defer blocking.Close()
	if _, err := filestorage.TryAcquireMediaLease(t.Context(), storage, "session"); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("nonblocking acquisition should report contention: %v", err)
	}
	if err := blocking.Close(); err != nil {
		t.Fatal(err)
	}
	instant, err := filestorage.TryAcquireMediaLease(t.Context(), storage, "session")
	if err != nil {
		t.Fatal(err)
	}
	defer instant.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	if _, err := storage.AcquireGate(ctx, filestorage.MediaLeaseGate, "session"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("blocking acquisition should wait: %v", err)
	}
}
