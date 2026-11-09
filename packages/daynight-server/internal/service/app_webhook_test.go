package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestOpenAppWebhookCurrentReferencesWithoutKeyring(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c := appTestConfig(t)
	c.WebhookEnabled = true
	app, _, err := openTestApp(t, ctx, c, nil)
	if err != nil {
		t.Fatalf("open enabled webhooks without keyring: %v", err)
	}
	if app.Webhooks == nil || !app.Webhooks.DispatchEnabled || !app.Webhooks.ConfigurationExpansionAvailable {
		t.Fatal("enabled webhooks were not assembled")
	}
	if err = app.Ready(ctx); err != nil {
		t.Fatalf("ready: %v", err)
	}
	if err = app.Close(ctx); err != nil {
		t.Fatalf("close: %v", err)
	}
	for _, reason := range []string{"missing wait", "missing current key"} {
		backend := newAppBackend(t)
		failure := &store.Error{Phase: "webhook startup references", Cause: errors.New(reason)}
		backend.referencesErr = failure
		app, err := openApp(ctx, c, nil, appTestOpeners(t, c, backend))
		if app != nil || !errors.Is(err, failure) {
			t.Fatalf("%s accepted or cause lost: app=%v, error=%v", reason, app, err)
		}
		if backend.closes != 1 || backend.referencesRead != 1 {
			t.Fatalf("%s startup cleanup: closes=%d references=%d", reason, backend.closes, backend.referencesRead)
		}
	}
	app, _, err = openTestApp(t, ctx, c, nil)
	if err != nil {
		t.Fatalf("retry after fixing current references: %v", err)
	}
	if err = app.Close(ctx); err != nil {
		t.Fatalf("retry close: %v", err)
	}
}

func TestWebhookRuntimeSupervisesFailureAndCloses(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	app, backend, err := openTestApp(t, ctx, appTestConfig(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	if app.Webhooks == nil || app.Webhooks.DispatchEnabled || app.Webhooks.ConfigurationExpansionAvailable {
		t.Fatal("default composition must expose disabled webhook management")
	}
	backend.blockWebhookRuntime()
	backend.deliveryErr = &store.Error{Phase: "webhook delivery maintenance", Cause: errors.New("webhook_deliveries unavailable")}
	backend.deliveryWait = make(chan struct{})
	runtime, stop := context.WithCancel(context.Background())
	defer stop()
	if err := app.Start(runtime); err != nil {
		t.Fatal(err)
	}
	if err := app.Start(runtime); err == nil {
		t.Fatal("runtime started twice")
	}
	select {
	case <-backend.deliveryStarted:
	case <-ctx.Done():
		t.Fatal("maintenance did not enter its configured dependency")
	}
	close(backend.deliveryWait)
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		if app.Ready(ctx) != nil {
			break
		}
		select {
		case <-deadline.C:
			t.Fatal("worker failure did not affect readiness")
		case <-time.After(20 * time.Millisecond):
		}
	}
	if err := backend.Ready(ctx); err != nil {
		t.Fatalf("backend readiness failed, not worker supervision: %v", err)
	}
	stop()
	app.StopClaims()
	app.CancelWork()
	if err := app.Drain(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestOpenAppRejectsUnsupportedWebhookPolicies(t *testing.T) {
	for _, name := range []string{"missing", "modified", "unsupported"} {
		t.Run(name, func(t *testing.T) {
			c := appTestConfig(t)
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			backend := newAppBackend(t)
			backend.expectedReferences = 0
			switch name {
			case "missing":
				backend.policies = nil
			case "modified":
				backend.policies[0].HTTPTimeoutSeconds = 16
			case "unsupported":
				extra := backend.policies[0]
				extra.Version = 2
				backend.policies = append(backend.policies, extra)
			}
			app, err := openApp(ctx, c, nil, appTestOpeners(t, c, backend))
			if app != nil {
				_ = app.Close(ctx)
				t.Fatal("invalid policy accepted")
			}
			if err == nil || !strings.Contains(err.Error(), "unsupported or invalid webhook policy") {
				t.Fatalf("policy error: %v", err)
			}
			if backend.policiesRead != 1 || backend.referencesRead != 0 || backend.closes != 1 {
				t.Fatalf("invalid policy reached later startup or missed cleanup: policies=%d references=%d closes=%d", backend.policiesRead, backend.referencesRead, backend.closes)
			}
		})
	}
}
