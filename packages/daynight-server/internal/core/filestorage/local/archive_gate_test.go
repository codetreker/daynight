package local

import (
	"context"
	"errors"
	"io"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/google/uuid"
)

func TestArchiveOwnerAdmissionAndCleanup(t *testing.T) {
	a, root := newStorage(t)
	b, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.Close() })
	owner, one, two, three := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	acquire := func(s *Storage, id string, cleanup bool) io.Closer {
		t.Helper()
		p, err := s.TryAcquireArchive(t.Context(), owner, id, 2, cleanup)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = p.Close() })
		return p
	}
	busy := func(id string, cleanup bool) {
		t.Helper()
		if p, err := b.TryAcquireArchive(t.Context(), owner, id, 2, cleanup); !errors.Is(err, filestorage.ErrGateBusy) {
			if p != nil {
				_ = p.Close()
			}
			t.Fatalf("expected busy, got %v", err)
		}
	}
	p := acquire(a, one, false)
	busy(one, false)
	if _, err := b.TryAcquireArchive(t.Context(), owner, two, 1, false); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("lower owner limit should reject the existing occupancy: %v", err)
	}
	q := acquire(b, two, false)
	busy(three, false)
	busy("", true)
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	busy("", true)
	if err := q.Close(); err != nil {
		t.Fatal(err)
	}
	c := acquire(a, "", true)
	busy(three, false)
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	next := acquire(b, one, false)
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	busy(one, false)
	_ = next
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := a.TryAcquireArchive(ctx, owner, two, 2, false); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled: %v", err)
	}
	if _, err := a.TryAcquireArchive(t.Context(), owner, "bad", 2, false); err == nil {
		t.Fatal("invalid Session accepted")
	}
}

func TestArchiveConcurrentSameSession(t *testing.T) {
	s, _ := newStorage(t)
	owner, id := uuid.NewString(), uuid.NewString()
	start := make(chan struct{})
	results := make(chan io.Closer, 16)
	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			p, err := s.TryAcquireArchive(t.Context(), owner, id, 16, false)
			if err == nil {
				results <- p
			} else if !errors.Is(err, filestorage.ErrGateBusy) {
				t.Errorf("acquire: %v", err)
			}
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	var permits []io.Closer
	for p := range results {
		permits = append(permits, p)
	}
	for _, p := range permits {
		defer p.Close()
	}
	if len(permits) != 1 {
		t.Fatalf("got %d simultaneous same-Session permits", len(permits))
	}
}

type blockingArchiveGates struct {
	filestorage.Gates
	acquired chan struct{}
	release  chan struct{}
}

func (g blockingArchiveGates) TryAcquireArchive(ctx context.Context, owner, session string, limit int, cleanup bool) (io.Closer, error) {
	p, err := g.Gates.TryAcquireArchive(ctx, owner, session, limit, cleanup)
	if err != nil {
		return nil, err
	}
	close(g.acquired)
	select {
	case <-g.release:
		return p, nil
	case <-ctx.Done():
		return nil, errors.Join(context.Cause(ctx), p.Close())
	}
}

func TestArchiveGrantReleasedWhenStorageClosesDuringAcquisition(t *testing.T) {
	root := t.TempDir()
	backend := blockingArchiveGates{Gates: standaloneGates{root: root}, acquired: make(chan struct{}), release: make(chan struct{})}
	s, err := NewWithGates(root, backend)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	owner, id := uuid.NewString(), uuid.NewString()
	result := make(chan error, 1)
	go func() {
		p, err := s.TryAcquireArchive(ctx, owner, id, 1, false)
		if p != nil {
			_ = p.Close()
		}
		result <- err
	}()
	select {
	case <-backend.acquired:
	case <-ctx.Done():
		t.Fatal("backend did not acquire the permit")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	close(backend.release)
	select {
	case err := <-result:
		if !errors.Is(err, os.ErrClosed) {
			t.Fatalf("acquisition after close: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("acquisition did not return")
	}
	if _, err := s.TryAcquireArchive(ctx, owner, id, 1, false); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("closed storage accepted a new operation: %v", err)
	}
	other, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	p, err := other.TryAcquireArchive(ctx, owner, id, 1, false)
	if err != nil {
		t.Fatalf("closed storage retained its grant: %v", err)
	}
	defer p.Close()
}
