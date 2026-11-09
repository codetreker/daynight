package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

func TestWebhookRuntimeRejectsInvalidAndFailedStarts(t *testing.T) {
	app := NewModules(config.Config{}, nil, nil, nil, nil)
	if err := app.Start(nil); err != nil {
		t.Fatalf("application without webhook runtime: %v", err)
	}
	app.webhookRuntime = &webhookRuntime{runner: webhook.NewRunner(nil, &webhook.Service{}, false), retention: webhook.NewRetention(nil)}
	if err := app.Start(nil); err == nil {
		t.Fatal("nil root accepted")
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := app.Start(canceled); err == nil {
		t.Fatal("canceled root accepted")
	}
	if err := app.Start(context.Background()); err == nil || !strings.Contains(err.Error(), "invalid webhook runner dependencies") {
		t.Fatalf("missing runner dependencies: %v", err)
	}
	if err := app.Start(context.Background()); err == nil || !strings.Contains(err.Error(), "already started") {
		t.Fatalf("partial start was restarted: %v", err)
	}
	ctx, done := context.WithTimeout(context.Background(), time.Second)
	defer done()
	if err := app.Close(ctx); err != nil {
		t.Fatalf("cleanup after runner start failure: %v", err)
	}
}

func TestWebhookRuntimeDrainRetainsEngineUntilAllWorkersStop(t *testing.T) {
	app := NewModules(config.Config{}, nil, nil, nil, nil)
	supervisor, logWorker := make(chan struct{}), make(chan struct{})
	app.webhookRuntime = &webhookRuntime{runner: webhook.NewRunner(nil, &webhook.Service{}, false), retention: webhook.NewRetention(nil), done: supervisor, logDone: logWorker}
	for i, ch := range []chan struct{}{supervisor, logWorker} {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
		err := app.Drain(ctx)
		cancel()
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("worker %d did not hold drain: %v", i, err)
		}
		op, err := app.Engine.BeginOperation()
		if err != nil {
			t.Fatalf("engine stopped before worker %d: %v", i, err)
		}
		op.Close()
		close(ch)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := app.Drain(ctx); err != nil {
		t.Fatalf("finished workers did not drain: %v", err)
	}
	if op, err := app.Engine.BeginOperation(); err == nil {
		op.Close()
		t.Fatal("engine still accepted work after drain")
	}
	if err := app.Close(ctx); err != nil {
		t.Fatalf("close after drain: %v", err)
	}
}

func TestWebhookRuntimeRetentionStartFailureDrainsStartedRunner(t *testing.T) {
	c := appTestConfig(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	app, backend, err := openTestApp(t, ctx, c, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		if e := app.Close(cleanup); e != nil {
			t.Error(e)
		}
	})
	backend.blockWebhookRuntime()
	if err = app.webhookRuntime.retention.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err = app.Start(context.Background()); err == nil || !strings.Contains(err.Error(), "already started webhook retention") {
		t.Fatalf("retention failure: %v", err)
	}
	if err = app.Close(ctx); err != nil {
		t.Fatalf("partial startup cleanup: %v", err)
	}
	if err = app.Ready(ctx); err == nil {
		t.Fatal("database remained ready after partial startup cleanup")
	}
}

func TestOpenAppCleansUpAfterOAuthCompositionFailure(t *testing.T) {
	c := appTestConfig(t)
	// The public-origin validator accepts a Unicode host, but the OAuth profile
	// requires the canonical URL string and rejects the escaped form.
	c.PublicOrigin = "https://例子.测试"
	c.UniAuthCallbackURL = c.PublicOrigin + "/api/v1/auth/callback"
	if err := c.Validate(); err != nil {
		t.Fatalf("fixture did not reach composition: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	backend := newAppBackend(t)
	app, err := openApp(ctx, c, nil, appTestOpeners(t, c, backend))
	if app != nil {
		_ = app.Close(ctx)
		t.Fatal("OAuth composition unexpectedly succeeded")
	}
	if err == nil || !strings.Contains(err.Error(), "OAuth public profile is unavailable") {
		t.Fatalf("OAuth composition failure: app=%v err=%v", app, err)
	}
	// Failed composition must leave the storage root reusable by a new backend.
	c.PublicOrigin = "https://daynight.example"
	c.UniAuthCallbackURL = c.PublicOrigin + "/api/v1/auth/callback"
	app, corrected, err := openTestApp(t, ctx, c, nil)
	if err != nil {
		t.Fatalf("retry after cleanup: %v", err)
	}
	if err = app.Ready(ctx); err != nil {
		t.Fatalf("corrected application readiness: %v", err)
	}
	if err = app.Close(ctx); err != nil {
		t.Fatalf("corrected application close: %v", err)
	}
	if err := backend.Ready(ctx); err == nil {
		t.Fatal("failed composition retained its persistence backend")
	}
	if err := corrected.Ready(ctx); err == nil {
		t.Fatal("corrected application retained its persistence backend")
	}
}
