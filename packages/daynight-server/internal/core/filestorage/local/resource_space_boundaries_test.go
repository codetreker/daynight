package local

import (
	"context"
	"errors"
	"testing"
)

func TestResourceSpaceRejectsCancelledAndClosedStorage(t *testing.T) {
	s, _ := newStorage(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, _, err := s.ResourceSpace(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled capacity observation succeeded", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.ResourceSpace(t.Context()); err == nil {
		t.Fatal("closed volume supplied capacity")
	}
}
