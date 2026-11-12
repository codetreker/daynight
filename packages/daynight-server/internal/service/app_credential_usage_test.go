package service

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	usage "github.com/codetreker/daynight/packages/daynight-server/internal/core/credentialusage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/credentialusage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

type usageAppBackend struct {
	*appBackend
	write func(context.Context, []model.CredentialUsageEvent) (store.Completion, error)
}

func (b *usageAppBackend) WriteCredentialUsage(ctx context.Context, events []model.CredentialUsageEvent) (store.Completion, error) {
	return b.write(ctx, events)
}

func openUsageApp(t *testing.T, write func(context.Context, []model.CredentialUsageEvent) (store.Completion, error), loggers ...*slog.Logger) (*App, *usageAppBackend) {
	t.Helper()
	c := appTestConfig(t)
	b := &usageAppBackend{appBackend: newAppBackend(t), write: write}
	b.blockWebhookRuntime()
	openers := appTestOpeners(t, c, b.appBackend)
	openDatabase := openers.database
	openers.database = func(ctx context.Context, url string) (persistenceBackend, error) {
		if _, err := openDatabase(ctx, url); err != nil {
			return nil, err
		}
		return b, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	if len(loggers) != 0 {
		logger = loggers[0]
	}
	app, err := openApp(ctx, c, logger, openers)
	if err != nil {
		t.Fatal(err)
	}
	if app.persistence.Transactions != b || app.CredentialUsage == nil || app.Application.CredentialUsage != app.CredentialUsage {
		t.Fatal("production assembly did not retain the shared recorder and backend")
	}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = app.Close(cleanup)
		if !app.ProducersStopped() {
			t.Error("application producers remained active after cleanup")
		}
	})
	return app, b
}

func recordAppUsage(t *testing.T, app *App) model.CredentialUsageEvent {
	t.Helper()
	event := model.CredentialUsageEvent{Kind: model.UsageSubjectPAT, UserID: "00000000-0000-4000-8000-000000000001", SubjectID: "00000000-0000-4000-8000-000000000002", At: time.Now().UTC().Truncate(time.Microsecond)}
	ctx := credentialusage.WithSource(usage.WithCollector(requestid.With(context.Background(), "late-request"), &usage.Collector{}), usage.SourceHTTPPAT)
	if admission, err := app.CredentialUsage.Record(ctx, event); err != nil || admission != usage.Accepted {
		t.Fatalf("record application event: admission=%v err=%v", admission, err)
	}
	return event
}

func waitUsageApp[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("application operation did not reach its barrier")
		var value T
		return value
	}
}

func TestAppCredentialUsageSharesWriterAndPreservesCompletedFailure(t *testing.T) {
	failure := errors.New("committed usage cleanup failed")
	written := make(chan model.CredentialUsageEvent, 1)
	var calls atomic.Int32
	app, backend := openUsageApp(t, func(ctx context.Context, events []model.CredentialUsageEvent) (store.Completion, error) {
		calls.Add(1)
		if ctx.Err() != nil || requestid.From(ctx) != "late-request" || len(events) != 1 {
			t.Errorf("writer received invalid application context or events: %v %+v", ctx.Err(), events)
		}
		written <- events[0]
		return store.Completion{Outcome: store.TransactionCommitted}, failure
	})
	root, cancel := context.WithCancel(context.Background())
	if err := app.Start(root); err != nil {
		t.Fatal(err)
	}
	cancel()
	// An admitted request may finish authentication after root cancellation.
	event := recordAppUsage(t, app)
	if actual := waitUsageApp(t, written); actual != event {
		t.Fatalf("production writer received %+v, want %+v", actual, event)
	}
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	err := app.Drain(ctx)
	complete, ok := err.(interface{ Drained() bool })
	if !errors.Is(err, failure) || !ok || !complete.Drained() || backend.closes != 0 {
		t.Fatalf("completed drain lost cause or closed dependencies: %v", err)
	}
	for range 2 {
		err = app.Close(ctx)
		closed, ok := err.(interface{ Closed() bool })
		if !errors.Is(err, failure) || !ok || !closed.Closed() || backend.closes != 1 || calls.Load() != 1 {
			t.Fatalf("completed application failure was lost or replayed: %v", err)
		}
	}
}

func TestAppCredentialUsageTimeoutJoinsOriginalWriterBeforePersistence(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	var calls atomic.Int32
	app, backend := openUsageApp(t, func(context.Context, []model.CredentialUsageEvent) (store.Completion, error) {
		calls.Add(1)
		close(started)
		<-release
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	})
	if err := app.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	recordAppUsage(t, app)
	waitUsageApp(t, started)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	err := app.Close(ctx)
	cancel()
	complete, ok := err.(interface{ Drained() bool })
	if !errors.Is(err, context.DeadlineExceeded) || ok && complete.Drained() || backend.closes != 0 || app.ProducersStopped() {
		t.Fatalf("unfinished writer released application: %v", err)
	}
	app.CancelWork()
	unblock()
	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := app.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if backend.closes != 1 || calls.Load() != 1 {
		t.Fatalf("retry recreated work: writer=%d persistence=%d", calls.Load(), backend.closes)
	}
}

func TestAppPartialStartJoinsStartedRecorder(t *testing.T) {
	app, backend := openUsageApp(t, func(context.Context, []model.CredentialUsageEvent) (store.Completion, error) {
		t.Error("partial-start recorder unexpectedly wrote an event")
		return store.Completion{}, errors.New("unexpected usage write")
	})
	if err := app.webhookRuntime.retention.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := app.Start(context.Background()); err == nil {
		t.Fatal("already started retention did not reject application start")
	}
	if app.CredentialUsage.Snapshot().State != "running" {
		t.Fatal("failed start did not exercise the production recorder")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := app.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if app.CredentialUsage.Snapshot().State != "stopped" || backend.closes != 1 {
		t.Fatal("partial-start cleanup left the original recorder or persistence open")
	}
}

type usageBlockingHandler struct {
	slog.Handler
	started chan struct{}
	release <-chan struct{}
	once    sync.Once
}

func (h *usageBlockingHandler) Handle(ctx context.Context, record slog.Record) error {
	if record.Message == "credential usage recording fault" {
		h.once.Do(func() { close(h.started) })
		<-h.release
	}
	return h.Handler.Handle(ctx, record)
}

func TestAppCredentialUsageJoinsLoggerBeforeDependenciesClose(t *testing.T) {
	failure := errors.New("committed usage cleanup failed")
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	handler := &usageBlockingHandler{Handler: slog.NewJSONHandler(io.Discard, nil), started: make(chan struct{}), release: release}
	app, backend := openUsageApp(t, func(context.Context, []model.CredentialUsageEvent) (store.Completion, error) {
		return store.Completion{Outcome: store.TransactionCommitted}, failure
	}, slog.New(handler))
	if err := app.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	recordAppUsage(t, app)
	waitUsageApp(t, handler.started)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	err := app.Close(ctx)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) || backend.closes != 0 || app.ProducersStopped() {
		t.Fatalf("blocked diagnostic consumer released dependencies: %v", err)
	}
	unblock()
	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err = app.Close(ctx)
	closed, ok := err.(interface{ Closed() bool })
	if !errors.Is(err, failure) || !ok || !closed.Closed() || backend.closes != 1 || !app.ProducersStopped() {
		t.Fatalf("diagnostic completion lost the original failure or closure: %v", err)
	}
}
