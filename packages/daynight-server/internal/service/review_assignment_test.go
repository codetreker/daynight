package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type reviewRuntimeStore struct {
	store.Transactions
	store.ReviewAssignmentStore
	entered, release, exited chan struct{}
}

func (s *reviewRuntimeStore) ReviewScanStart(ctx context.Context) (time.Time, *store.ReviewWorkerKey, error) {
	close(s.entered)
	<-ctx.Done()
	<-s.release
	close(s.exited)
	return time.Time{}, nil, ctx.Err()
}

func TestReviewAssignmentApplicationLifecycle(t *testing.T) {
	db := &reviewRuntimeStore{entered: make(chan struct{}), release: make(chan struct{}), exited: make(chan struct{})}
	app := NewModules(config.Config{}, db, nil, nil, nil)
	if err := app.assembleReviewAssignment(db, nil); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	t.Cleanup(func() {
		select {
		case <-db.release:
		default:
			close(db.release)
		}
		cleanup, finish := context.WithTimeout(context.Background(), 5*time.Second)
		defer finish()
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
		t.Fatal("duplicate start succeeded")
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
		t.Fatal("dependency released before reconciliation exited")
	}
	if err := app.Start(ctx); err == nil {
		t.Fatal("started after drain")
	}
}

func TestReviewAssignmentAssemblyRequiresStore(t *testing.T) {
	app := &App{}
	if err := app.assembleReviewAssignment(nil, nil); err == nil || app.reviewAssignment != nil {
		t.Fatalf("missing store: %v", err)
	}
}
