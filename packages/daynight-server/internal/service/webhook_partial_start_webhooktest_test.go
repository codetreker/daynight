//go:build webhooktest

package service

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type heldStartDeliveryStore struct {
	store.WebhookDeliveryTransactions
	entered, release chan struct{}
	once             sync.Once
}

func (s *heldStartDeliveryStore) WriteWebhookDelivery(ctx context.Context, fn func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	s.once.Do(func() { close(s.entered) })
	// Deliberately ignore cancellation until the test releases this controlled
	// dependency, proving the app does not release shared resources early.
	<-s.release
	return s.WebhookDeliveryTransactions.WriteWebhookDelivery(ctx, fn)
}

func TestWebhookPartialStartRetainsDependenciesUntilRunnerStops(t *testing.T) {
	cfg := appTestConfig(t)
	app, err := OpenApp(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	held := &heldStartDeliveryStore{WebhookDeliveryTransactions: app.webhookRuntime.runner.DB, entered: make(chan struct{}), release: make(chan struct{})}
	app.webhookRuntime.runner.DB = held
	if err = app.webhookRuntime.runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	released := false
	t.Cleanup(func() {
		if !released {
			close(held.release)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	select {
	case <-held.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("controlled runner did not enter store")
	}
	// The first worker is already running, so the application's Start fails at
	// Runner.Start. Its caller owns the one cleanup budget.
	if err = app.Start(context.Background()); err == nil {
		t.Fatal("partial Start unexpectedly succeeded")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	start := time.Now()
	err = app.Close(ctx)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
		t.Fatalf("bounded close: %v", err)
	}
	ready, done := context.WithTimeout(context.Background(), time.Second)
	defer done()
	if err = app.persistence.Ready(ready); err != nil {
		t.Fatalf("database released while runner active: %v", err)
	}
	close(held.release)
	released = true
	cleanup, finish := context.WithTimeout(context.Background(), 5*time.Second)
	defer finish()
	if err = app.Close(cleanup); err != nil {
		t.Fatalf("drain after release: %v", err)
	}
	if err = app.persistence.Ready(cleanup); err == nil {
		t.Fatal("database remained open after runner stopped")
	}
}
