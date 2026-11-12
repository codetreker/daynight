package credentialusage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	usage "github.com/codetreker/daynight/packages/daynight-server/internal/core/credentialusage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

type writerFunc func(context.Context, []model.CredentialUsageEvent) (store.Completion, error)

func (f writerFunc) WriteCredentialUsage(ctx context.Context, events []model.CredentialUsageEvent) (store.Completion, error) {
	return f(ctx, events)
}

type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *testClock) read() time.Time         { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *testClock) advance(d time.Duration) { c.mu.Lock(); c.now = c.now.Add(d); c.mu.Unlock() }

func event(n int, at time.Time) model.CredentialUsageEvent {
	return model.CredentialUsageEvent{Kind: model.UsageSubjectPAT, UserID: "00000000-0000-4000-8000-000000000001", SubjectID: fmt.Sprintf("00000000-0000-4000-8000-%012x", n), At: at.UTC().Truncate(time.Microsecond)}
}
func request(ctx context.Context, id string) context.Context {
	ctx = usage.WithCollector(ctx, &usage.Collector{})
	ctx = requestid.With(ctx, id)
	return WithSource(ctx, usage.SourceHTTPPAT)
}
func bounded(t *testing.T) (context.Context, context.CancelFunc) {
	t.Helper()
	return context.WithTimeout(context.Background(), 5*time.Second)
}
func wait[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for background operation")
		var zero T
		return zero
	}
}
func logger() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }

func TestRecordIndependentOfRequestAndBlockedWriter(t *testing.T) {
	started := make(chan []model.CredentialUsageEvent, 2)
	release := make(chan struct{})
	writer := writerFunc(func(ctx context.Context, events []model.CredentialUsageEvent) (store.Completion, error) {
		if events[0].SubjectID == event(1, time.Now()).SubjectID && requestid.From(ctx) != "req-1" {
			t.Errorf("writer request ID: %q", requestid.From(ctx))
		}
		started <- events
		<-release
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	})
	r, err := New(writer, logger(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(request(context.Background(), "req-1"))
	cancel()
	at := time.Now().UTC().Truncate(time.Microsecond)
	if a, err := r.Record(ctx, event(1, at)); err != nil || a != usage.Accepted {
		t.Fatalf("record: %v %v", a, err)
	}
	first := wait(t, started)
	if len(first) != 1 || first[0] != event(1, at) {
		t.Fatalf("written event: %+v", first)
	}
	done := make(chan error, 1)
	go func() { _, e := r.Record(request(context.Background(), "req-2"), event(2, at)); done <- e }()
	if err := wait(t, done); err != nil {
		t.Fatal(err)
	}
	close(release)
	ctxDrain, cancelDrain := bounded(t)
	defer cancelDrain()
	if err := r.Drain(ctxDrain); err != nil {
		t.Fatal(err)
	}
}

func TestStopTimeoutJoinsOriginalWork(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	var mu sync.Mutex
	calls := 0
	writer := writerFunc(func(context.Context, []model.CredentialUsageEvent) (store.Completion, error) {
		mu.Lock()
		calls++
		mu.Unlock()
		started <- struct{}{}
		<-release
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	})
	r, err := New(writer, logger(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Record(request(context.Background(), "req"), event(1, time.Now())); err != nil {
		t.Fatal(err)
	}
	wait(t, started)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := r.Stop(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("stop: %v", err)
	}
	close(release)
	join, cancelJoin := bounded(t)
	defer cancelJoin()
	if err := r.Stop(join); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("writer called %d times", calls)
	}
}

func TestUnknownRetriesSameEventAndReportsExhaustion(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	attempts := make(chan []model.CredentialUsageEvent, 4)
	cause := errors.New("commit outcome unavailable")
	writer := writerFunc(func(_ context.Context, events []model.CredentialUsageEvent) (store.Completion, error) {
		attempts <- events
		return store.Completion{Outcome: store.TransactionUnknown}, cause
	})
	r, err := New(writer, logger(), clock.read)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := event(1, clock.read())
	if _, err := r.Record(request(context.Background(), "req"), want); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < usage.MaxAttempts; i++ {
		got := wait(t, attempts)
		if len(got) != 1 || got[0] != want {
			t.Fatalf("attempt %d: %+v", i, got)
		}
		// Wait until completion schedules its retry before advancing monotonic time.
		deadline := time.Now().Add(5 * time.Second)
		for r.Snapshot().Failed < uint64(i+1) {
			if time.Now().After(deadline) {
				t.Fatal("completion not observed")
			}
			time.Sleep(time.Millisecond)
		}
		clock.advance(time.Second)
		notify(r.wake)
	}
	ctx, cancel := bounded(t)
	defer cancel()
	err = r.Drain(ctx)
	var de *DrainError
	if !errors.As(err, &de) || !de.Drained() || de.Unpersisted != 1 || !errors.Is(err, cause) {
		t.Fatalf("drain: %v", err)
	}
	s := r.Snapshot()
	if s.Unknown != 3 || s.Abandoned != 1 {
		t.Fatalf("snapshot: %+v", s)
	}
}

func TestRequiresDependenciesAndCollector(t *testing.T) {
	if _, err := New(nil, logger(), nil); !errors.Is(err, ErrDependency) {
		t.Fatalf("missing writer: %v", err)
	}
	w := writerFunc(func(context.Context, []model.CredentialUsageEvent) (store.Completion, error) {
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	})
	r, err := New(w, logger(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Record(context.Background(), event(1, time.Now())); !errors.Is(err, ErrMissingCollector) {
		t.Fatalf("collector: %v", err)
	}
	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := bounded(t)
	defer cancel()
	if err := r.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	collector := &usage.Collector{}
	req := WithSource(requestid.With(usage.WithCollector(context.Background(), collector), "req"), usage.SourceHTTPPAT)
	if a, err := r.Record(req, event(1, time.Now())); err != nil || a != usage.Stopped {
		t.Fatalf("stopped: %v %v", a, err)
	}
	s, ok := collector.Snapshot()
	if !ok || s.Latest.Cause != usage.CauseStopped {
		t.Fatalf("refusal: %+v", s)
	}
}

type blockingHandler struct {
	entered chan slog.Record
	release chan struct{}
	mu      sync.Mutex
	blocked bool
}

func (h *blockingHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h *blockingHandler) WithAttrs([]slog.Attr) slog.Handler       { return h }
func (h *blockingHandler) WithGroup(string) slog.Handler            { return h }
func (h *blockingHandler) Handle(_ context.Context, r slog.Record) error {
	h.mu.Lock()
	first := !h.blocked
	h.blocked = true
	h.mu.Unlock()
	h.entered <- r
	if first {
		<-h.release
	}
	return nil
}

func TestBlockedDiagnosticPreservesNewRevisionAndDoesNotBlockWork(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	h := &blockingHandler{entered: make(chan slog.Record, 8), release: make(chan struct{})}
	writes := make(chan int, 8)
	var mu sync.Mutex
	n := 0
	w := writerFunc(func(context.Context, []model.CredentialUsageEvent) (store.Completion, error) {
		mu.Lock()
		n++
		call := n
		mu.Unlock()
		writes <- call
		if call <= 2 {
			return store.Completion{Outcome: store.TransactionNotCommitted}, errors.New("unavailable")
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	})
	r, err := New(w, slog.New(h), clock.read)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Record(request(context.Background(), "req-1"), event(1, clock.read())); err != nil {
		t.Fatal(err)
	}
	wait(t, writes)
	wait(t, h.entered)
	deadline := time.Now().Add(5 * time.Second)
	for r.Snapshot().Failed < 1 {
		if time.Now().After(deadline) {
			t.Fatal("first failure not observed")
		}
		time.Sleep(time.Millisecond)
	}
	clock.advance(time.Second)
	notify(r.wake)
	wait(t, writes)
	deadline = time.Now().Add(5 * time.Second)
	for r.Snapshot().Failed < 2 {
		if time.Now().After(deadline) {
			t.Fatal("second failure not observed")
		}
		time.Sleep(time.Millisecond)
	}
	done := make(chan error, 1)
	go func() { _, e := r.Record(request(context.Background(), "req-2"), event(2, clock.read())); done <- e }()
	if err := wait(t, done); err != nil {
		t.Fatal(err)
	}
	wait(t, writes)
	close(h.release)
	wait(t, h.entered)
	clock.advance(time.Second)
	notify(r.wake)
	ctx, cancel := bounded(t)
	defer cancel()
	err = r.Drain(ctx)
	var de *DrainError
	if !errors.As(err, &de) || !de.Drained() || de.Unpersisted != 0 {
		t.Fatalf("drain: %v", err)
	}
	if s := r.Snapshot(); s.Dirty != 0 {
		t.Fatalf("unconfirmed diagnostic: %+v", s)
	}
}

func TestFullAdmissionReportsToCallerCollector(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	var once sync.Once
	w := writerFunc(func(context.Context, []model.CredentialUsageEvent) (store.Completion, error) {
		once.Do(func() { started <- struct{}{}; <-release })
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	})
	r, err := New(w, logger(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	at := time.Now()
	if _, err := r.Record(request(context.Background(), "req-1"), event(1, at)); err != nil {
		t.Fatal(err)
	}
	wait(t, started)
	for i := 2; i <= usage.ResidentLimit; i++ {
		if a, err := r.Record(request(context.Background(), fmt.Sprintf("req-%d", i)), event(i, at)); err != nil || a != usage.Accepted {
			t.Fatalf("record %d: %v %v", i, a, err)
		}
	}
	c := &usage.Collector{}
	ctx := WithSource(requestid.With(usage.WithCollector(context.Background(), c), "overflow"), usage.SourceHTTPPAT)
	if a, err := r.Record(ctx, event(usage.ResidentLimit+1, at)); err != nil || a != usage.Full {
		t.Fatalf("overflow: %v %v", a, err)
	}
	fault, ok := c.Snapshot()
	if !ok || fault.Latest.Code != usage.CodeQueueFull || fault.Latest.Observation.RequestID != "overflow" {
		t.Fatalf("collector: %+v", fault)
	}
	close(release)
	join, cancel := bounded(t)
	defer cancel()
	if err := r.Drain(join); err != nil {
		t.Fatal(err)
	}
}

func TestCommittedCleanupErrorAndCancellation(t *testing.T) {
	t.Run("committed cleanup", func(t *testing.T) {
		cause := errors.New("cleanup failure")
		calls := 0
		w := writerFunc(func(context.Context, []model.CredentialUsageEvent) (store.Completion, error) {
			calls++
			return store.Completion{Outcome: store.TransactionCommitted}, cause
		})
		r, err := New(w, logger(), nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := r.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		if _, err := r.Record(request(context.Background(), "req"), event(1, time.Now())); err != nil {
			t.Fatal(err)
		}
		join, cancel := bounded(t)
		defer cancel()
		err = r.Drain(join)
		var de *DrainError
		if !errors.As(err, &de) || !de.Drained() || de.Unpersisted != 0 || !errors.Is(err, cause) || calls != 1 {
			t.Fatalf("drain %v, calls %d", err, calls)
		}
	})
	t.Run("cancel work", func(t *testing.T) {
		started := make(chan struct{}, 1)
		canceled := make(chan struct{}, 1)
		w := writerFunc(func(ctx context.Context, _ []model.CredentialUsageEvent) (store.Completion, error) {
			select {
			case started <- struct{}{}:
			default:
			}
			<-ctx.Done()
			select {
			case canceled <- struct{}{}:
			default:
			}
			return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
		})
		r, err := New(w, logger(), nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := r.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		if _, err := r.Record(request(context.Background(), "req"), event(1, time.Now())); err != nil {
			t.Fatal(err)
		}
		wait(t, started)
		r.CancelWork()
		wait(t, canceled)
		join, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		err = r.Drain(join)
		var de *DrainError
		if !errors.As(err, &de) || !de.Drained() || de.Unpersisted != 1 || !errors.Is(err, context.Canceled) {
			t.Fatalf("drain: %v", err)
		}
	})
}

func TestDiagnosticPassVisitsOtherDirtyKey(t *testing.T) {
	clock := &testClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	h := &blockingHandler{entered: make(chan slog.Record, 8), release: make(chan struct{})}
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	w := writerFunc(func(context.Context, []model.CredentialUsageEvent) (store.Completion, error) {
		started <- struct{}{}
		<-release
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	})
	r, err := New(w, slog.New(h), clock.read)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Record(request(context.Background(), "req-1"), event(1, clock.read())); err != nil {
		t.Fatal(err)
	}
	wait(t, started)
	if _, err := r.Record(request(context.Background(), "req-2"), event(2, clock.read())); err != nil {
		t.Fatal(err)
	}
	fault := func(n int) usage.Fault {
		return usage.Fault{Phase: usage.PhaseFlush, Code: usage.CodeWriteFailed, Cause: usage.CauseDatabase, Observation: usage.Observation{Event: event(n, clock.read()), RequestID: fmt.Sprintf("req-%d", n), Source: usage.SourceHTTPPAT}, OccurredAt: clock.read()}
	}
	if err := r.sampler.ReportFault(fault(1)); err != nil {
		t.Fatal(err)
	}
	if err := r.sampler.ReportFault(fault(2)); err != nil {
		t.Fatal(err)
	}
	notify(r.diagnosticWake)
	first := wait(t, h.entered)
	if err := r.sampler.ReportFault(fault(1)); err != nil {
		t.Fatal(err)
	}
	close(h.release)
	second := wait(t, h.entered)
	subject := func(rec slog.Record) string {
		var id string
		rec.Attrs(func(a slog.Attr) bool {
			if a.Key == "subject_id" {
				id = a.Value.String()
			}
			return true
		})
		return id
	}
	if subject(first) != event(1, clock.read()).SubjectID || subject(second) != event(2, clock.read()).SubjectID {
		t.Fatalf("diagnostic order: %q, %q", subject(first), subject(second))
	}
	close(release)
	join, cancel := bounded(t)
	defer cancel()
	if err := r.Drain(join); err != nil {
		t.Fatal(err)
	}
}
