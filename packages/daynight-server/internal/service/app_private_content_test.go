package service

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type appLogCapture struct {
	mu      sync.Mutex
	buf     bytes.Buffer
	changed chan struct{}
}

func (l *appLogCapture) Write(p []byte) (int, error) {
	l.mu.Lock()
	n, err := l.buf.Write(p)
	l.mu.Unlock()
	select {
	case l.changed <- struct{}{}:
	default:
	}
	return n, err
}
func (l *appLogCapture) wait(t *testing.T, fragment string) string {
	t.Helper()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		l.mu.Lock()
		s := l.buf.String()
		l.mu.Unlock()
		if strings.Contains(s, fragment) {
			return s
		}
		select {
		case <-l.changed:
		case <-deadline.C:
			t.Fatalf("log %q not received: %s", fragment, s)
		}
	}
}

func TestOpenAppWithLoggerReportsMaintenance(t *testing.T) {
	c := appTestConfig(t)
	logs := &appLogCapture{changed: make(chan struct{}, 1)}
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	app, _, err := openTestApp(t, context.Background(), c, logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	if app.PrivateContent == nil {
		t.Fatal("private content lifecycle missing")
	}
	got := logs.wait(t, "private transfer maintenance")
	if !strings.Contains(got, `"component":"mcptransfer"`) || !strings.Contains(got, `"temp_reserved_bytes":0`) || strings.Contains(got, c.UniAuthAppSecret) {
		t.Fatalf("unsafe or incomplete maintenance record: %s", got)
	}
}

func TestOpenAppReportsBackgroundMaintenanceFailure(t *testing.T) {
	c := appTestConfig(t)
	backend := newAppBackend(t)
	backend.privateCompletion = store.Completion{Outcome: store.TransactionNotCommitted}
	backend.privateErr = &store.Error{Phase: "fixture private maintenance", Cause: errors.New("private_transfers unavailable")}
	logs := &appLogCapture{changed: make(chan struct{}, 1)}
	app, err := openApp(context.Background(), c, slog.New(slog.NewJSONHandler(logs, nil)), appTestOpeners(t, c, backend))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	got := logs.wait(t, "private transfer maintenance failed")
	if !strings.Contains(got, `"operation":"maintain"`) || strings.Contains(got, c.UniAuthAppSecret) || strings.Contains(got, "private_transfers") {
		t.Fatalf("unsafe failure log: %s", got)
	}
}

func TestOpenAppReportsOAuthMaintenanceFailure(t *testing.T) {
	c := appTestConfig(t)
	backend := newAppBackend(t)
	backend.oauthCompletion = store.Completion{Outcome: store.TransactionNotCommitted}
	backend.oauthErr = &store.Error{Phase: "fixture OAuth maintenance", Cause: errors.New("oauth_clients unavailable")}
	logs := &appLogCapture{changed: make(chan struct{}, 1)}
	app, err := openApp(context.Background(), c, slog.New(slog.NewJSONHandler(logs, nil)), appTestOpeners(t, c, backend))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	got := logs.wait(t, "OAuth maintenance failed")
	if !strings.Contains(got, `"component":"oauth"`) || !strings.Contains(got, `"operation":"maintain"`) || strings.Contains(got, "oauth_clients") {
		t.Fatalf("unsafe OAuth maintenance failure log: %s", got)
	}
}

func TestAppCloseWaitsForPrivateTransferPermit(t *testing.T) {
	c := appTestConfig(t)
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	actor := mcptransfer.Actor{Principal: principal, AuthorityKind: "pat", AuthorityID: principal.CredentialID}
	binding := mcptransfer.Binding{ID: uuid.NewString(), Direction: "upload", ProjectID: uuid.NewString(), TaskID: uuid.NewString(), Path: "file", ContentType: "text/plain"}
	record, err := mcptransfer.NewRecord(actor, binding, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	record.Version = 1
	updated := record
	updated.Version = 2
	backend := newAppBackend(t)
	backend.privateActor, backend.privateRecord, backend.privateUpdated = &principal, &record, &updated
	app, err := openApp(context.Background(), c, nil, appTestOpeners(t, c, backend))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	permit, err := app.PrivateContent.AcquirePermit(context.Background(), actor, binding.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	err = app.Close(ctx)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("close did not wait for permit: %v", err)
	}
	if err := app.Ready(context.Background()); err != nil {
		t.Fatalf("database closed while permit active: %v", err)
	}
	select {
	case <-permit.Context.Done():
	default:
		t.Fatal("shutdown did not cancel permit")
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := app.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err := app.Ready(ctx); err == nil {
		t.Fatal("database remained open after shutdown")
	}
	if backend.privateGets != 2 || backend.privatePuts != 1 {
		t.Fatalf("permit operations: gets=%d puts=%d", backend.privateGets, backend.privatePuts)
	}
}
