package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type archiveRuntimeStore struct {
	store.Transactions
	store.ArchiveCleanupStore
	entered chan struct{}
	release chan struct{}
	exited  chan struct{}
}

func (s *archiveRuntimeStore) ListArchiveCleanup(ctx context.Context, cursor string, limit int) ([]store.ArchiveCleanupTarget, error) {
	if cursor != "" || limit != 32 {
		return nil, errors.New("unexpected archive scan")
	}
	close(s.entered)
	<-ctx.Done()
	<-s.release
	close(s.exited)
	return nil, ctx.Err()
}

func TestArchiveCleanupApplicationLifecycle(t *testing.T) {
	db := &archiveRuntimeStore{entered: make(chan struct{}), release: make(chan struct{}), exited: make(chan struct{})}
	app := NewModules(config.Config{}, db, nil, nil, nil)
	if err := app.assembleArchiveCleanup(db, nil, nil); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	t.Cleanup(func() {
		cleanup, finish := context.WithTimeout(context.Background(), 5*time.Second)
		defer finish()
		select {
		case <-db.release:
		default:
			close(db.release)
		}
		if err := app.Close(cleanup); err != nil {
			t.Error(err)
		}
	})
	if err := app.Start(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-db.entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := app.Start(ctx); err == nil {
		t.Fatal("duplicate worker start succeeded")
	}
	app.CancelWork()
	stopped, stop := context.WithCancel(context.Background())
	stop()
	if err := app.Drain(stopped); !errors.Is(err, context.Canceled) {
		t.Fatalf("premature drain: %v", err)
	}
	close(db.release)
	if err := app.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-db.exited:
	default:
		t.Fatal("dependencies released before cleanup exit")
	}
	if err := app.Start(ctx); err == nil {
		t.Fatal("started after drain")
	}
}

func TestArchiveCleanupAssemblyRequiresCapability(t *testing.T) {
	app := &App{}
	if err := app.assembleArchiveCleanup(nil, nil, nil); err == nil || app.archiveCleanup != nil {
		t.Fatalf("missing store: %v", err)
	}
}
