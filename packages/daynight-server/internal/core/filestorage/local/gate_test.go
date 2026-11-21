package local

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

func TestGateClosedStorageFails(t *testing.T) {
	storage, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.AcquireGate(t.Context(), filestorage.TargetGate, "key"); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("acquire after close: %v", err)
	}
}

func TestGateAcrossHandlesAndDomains(t *testing.T) {
	first, root := newStorage(t)
	second, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = second.Close() })
	permit, err := first.AcquireGate(t.Context(), filestorage.TargetGate, "same")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = permit.Close() })
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	if _, err := second.AcquireGate(ctx, filestorage.TargetGate, "same"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("second handle should wait: %v", err)
	}
	private, err := second.AcquireGate(t.Context(), filestorage.PrivateGate, "same")
	if err != nil {
		t.Fatal(err)
	}
	if err := private.Close(); err != nil {
		t.Fatal(err)
	}
	other, _ := newStorage(t)
	isolated, err := other.AcquireGate(t.Context(), filestorage.TargetGate, "same")
	if err != nil {
		t.Fatal(err)
	}
	if err := isolated.Close(); err != nil {
		t.Fatal(err)
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := second.AcquireGate(t.Context(), filestorage.TargetGate, "same")
	if err != nil {
		t.Fatal(err)
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := first.AcquireGate(ctx, filestorage.TargetGate, "same"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("canceled waiter: %v", err)
	}
	if err := next.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := first.AcquireGate(t.Context(), "wrong", "key"); err == nil {
		t.Fatal("invalid domain accepted")
	}
	if _, err := first.AcquireGate(t.Context(), filestorage.TargetGate, ""); err == nil {
		t.Fatal("empty key accepted")
	}
	if _, err := os.Stat(filepath.Join(root, gateDirectory)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("gate created a control directory: %v", err)
	}
}

func TestLegacyGateDirectoryRemainsReserved(t *testing.T) {
	storage, root := newStorage(t)
	control := filepath.Join(root, gateDirectory)
	if err := os.Mkdir(control, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(control, "target-001"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, bucket := range []string{gateDirectory, strings.ToUpper(gateDirectory)} {
		if _, err := storage.Put(t.Context(), bucket, "target-001", strings.NewReader("x")); !errors.Is(err, filestorage.ErrInvalidAddress) {
			t.Fatalf("write control object: %v", err)
		}
		if _, err := storage.Open(t.Context(), bucket, "target-001"); !errors.Is(err, filestorage.ErrInvalidAddress) {
			t.Fatalf("read control object: %v", err)
		}
		if err := storage.Delete(t.Context(), bucket, "target-001"); !errors.Is(err, filestorage.ErrInvalidAddress) {
			t.Fatalf("delete control object: %v", err)
		}
	}
	permit, err := storage.AcquireGate(t.Context(), filestorage.TargetGate, "ignored-control-file")
	if err != nil {
		t.Fatal(err)
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(control)
	if err != nil || len(entries) != 1 || entries[0].Name() != "target-001" {
		t.Fatalf("legacy control directory changed: %v %v", entries, err)
	}
}

func TestStorageDelegatesToConfiguredGates(t *testing.T) {
	root := t.TempDir()
	backendErr := errors.New("gate backend unavailable")
	gates := gateProbe{backendErr: backendErr}
	storage, err := NewWithGates(root, &gates)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = storage.Close() })
	if _, err := storage.AcquireGate(t.Context(), filestorage.PrivateGate, "private"); !errors.Is(err, backendErr) {
		t.Fatalf("blocking backend failure: %v", err)
	}
	if _, err := storage.TryAcquireResidency(t.Context(), "residency"); !errors.Is(err, backendErr) {
		t.Fatalf("nonblocking backend failure: %v", err)
	}
	if gates.domain != filestorage.PrivateGate || gates.blockingKey != "private" || gates.residencyKey != "residency" {
		t.Fatalf("forwarded gate arguments: %+v", gates)
	}
	if _, err := NewWithGates(root, nil); err == nil {
		t.Fatal("nil configured backend was accepted")
	}
}

type gateProbe struct {
	backendErr                error
	domain                    filestorage.GateDomain
	blockingKey, residencyKey string
}

func (p *gateProbe) TryAcquireArchive(_ context.Context, _, _ string, _ int, _ bool) (io.Closer, error) {
	return nil, p.backendErr
}

func (p *gateProbe) AcquireGate(_ context.Context, domain filestorage.GateDomain, key string) (io.Closer, error) {
	p.domain, p.blockingKey = domain, key
	return nil, p.backendErr
}

func (p *gateProbe) TryAcquireResidency(_ context.Context, key string) (io.Closer, error) {
	p.residencyKey = key
	return nil, p.backendErr
}
