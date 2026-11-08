package local

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"golang.org/x/sys/unix"
)

func TestResidencyExactNonblockingAndPersistent(t *testing.T) {
	root := t.TempDir()
	a, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	key := "owner-1"
	stripe := sha256.Sum256([]byte(key))[0]
	var other string
	for i := 0; ; i++ {
		other = fmt.Sprintf("owner-%d", i+2)
		if sha256.Sum256([]byte(other))[0] == stripe {
			break
		}
	}
	permit, err := a.TryAcquireResidency(t.Context(), key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.TryAcquireResidency(t.Context(), key); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("local contention: %v", err)
	}
	if _, err := b.TryAcquireResidency(t.Context(), key); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("cross-instance contention: %v", err)
	}
	distinct, err := b.TryAcquireResidency(t.Context(), other)
	if err != nil {
		t.Fatalf("colliding stripe: %v", err)
	}
	if err := distinct.Close(); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte(key))
	name := filepath.Join(root, gateDirectory, fmt.Sprintf("residency-%x", hash))
	before, err := os.Stat(name)
	if err != nil {
		t.Fatal(err)
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	a.residencyMu.Lock()
	remaining := len(a.residency)
	a.residencyMu.Unlock()
	if remaining != 0 {
		t.Fatalf("local entries retained: %d", remaining)
	}
	next, err := b.TryAcquireResidency(t.Context(), key)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Close()
	after, err := os.Stat(name)
	if err != nil || !os.SameFile(before, after) {
		t.Fatalf("lock inode changed: %v", err)
	}
	if _, err := a.TryAcquireResidency(t.Context(), key); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("reacquisition split exclusion: %v", err)
	}
}

func TestResidencyRejectsUnsafeControlObjects(t *testing.T) {
	for _, kind := range []string{"directory-file", "directory-symlink", "lock-symlink", "lock-fifo"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			s, err := New(root)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			control := filepath.Join(root, gateDirectory)
			hash := sha256.Sum256([]byte("key"))
			lock := filepath.Join(control, fmt.Sprintf("residency-%x", hash))
			switch kind {
			case "directory-file":
				err = os.WriteFile(control, []byte("x"), 0o600)
			case "directory-symlink":
				err = os.Symlink(t.TempDir(), control)
			case "lock-symlink":
				if err = os.Mkdir(control, 0o700); err == nil {
					err = os.Symlink(filepath.Join(root, "other"), lock)
				}
			case "lock-fifo":
				if err = os.Mkdir(control, 0o700); err == nil {
					err = unix.Mkfifo(lock, 0o600)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			if permit, err := s.TryAcquireResidency(t.Context(), "key"); err == nil {
				permit.Close()
				t.Fatalf("accepted %s", kind)
			}
			s.residencyMu.Lock()
			remaining := len(s.residency)
			s.residencyMu.Unlock()
			if remaining != 0 {
				t.Fatal("failed acquisition retained local entry")
			}
		})
	}
}

func TestResidencyRejectsCanceledAndClosed(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := s.TryAcquireResidency(ctx, "key"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled: %v", err)
	}
	if _, err := s.TryAcquireResidency(t.Context(), ""); err == nil {
		t.Fatal("empty key accepted")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.TryAcquireResidency(t.Context(), "key"); err == nil {
		t.Fatal("closed storage accepted gate")
	}
	s.residencyMu.Lock()
	defer s.residencyMu.Unlock()
	if len(s.residency) != 0 {
		t.Fatal("failed acquisition retained local entry")
	}
}

func TestResidencyPermitOutlivesStorageRootClose(t *testing.T) {
	root := t.TempDir()
	a, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	b, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	permit, err := a.TryAcquireResidency(t.Context(), "key")
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := b.TryAcquireResidency(t.Context(), "key"); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("root close released live permit: %v", err)
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := b.TryAcquireResidency(t.Context(), "key")
	if err != nil {
		t.Fatal(err)
	}
	if err := next.Close(); err != nil {
		t.Fatal(err)
	}
}
