package local

import (
	"context"
	"errors"
	"io"
	"sync"
	"testing"

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
