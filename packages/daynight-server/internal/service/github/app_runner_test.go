package github

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

type appDueReaderFunc func(context.Context, time.Time, int) ([]string, error)

func (f appDueReaderFunc) DueGitHubAppProjects(ctx context.Context, now time.Time, limit int) ([]string, error) {
	return f(ctx, now, limit)
}

func appRunnerFixture(reader store.GitHubAppWorkReader, exec projectExecutor) *AppRunner {
	r, err := NewAppRunner(reader, &AppExecutor{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		panic(err)
	}
	r.executor, r.interval = exec, 10*time.Millisecond
	return r
}
func stopAppRunner(t *testing.T, r *AppRunner) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := r.Stop(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestAppRunnerBoundsAndStopsAdmissionBeforeCancellation(t *testing.T) {
	scans := make(chan struct{}, 10)
	started := make(chan string, 20)
	release := make(chan struct{})
	canceled := make(chan string, 10)
	reader := appDueReaderFunc(func(ctx context.Context, _ time.Time, limit int) ([]string, error) {
		if limit != 32 {
			t.Errorf("scan limit=%d", limit)
		}
		select {
		case scans <- struct{}{}:
		default:
		}
		return []string{"1", "2", "3", "4", "5"}, nil
	})
	exec := executorFunc(func(ctx context.Context, id string) error {
		started <- id
		select {
		case <-ctx.Done():
			canceled <- id
			<-release
			return ctx.Err()
		case <-release:
			return nil
		}
	})
	r := appRunnerFixture(reader, exec)
	if err := r.StartWithClaimContext(context.Background(), context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
		stopAppRunner(t, r)
	})
	event(t, scans)
	got := map[string]bool{}
	for i := 0; i < 4; i++ {
		id := event(t, started)
		if got[id] {
			t.Fatalf("duplicate %s", id)
		}
		got[id] = true
	}
	event(t, scans)
	select {
	case id := <-started:
		t.Fatalf("exceeded limit: %s", id)
	default:
	}
	r.StopClaims()
	select {
	case id := <-canceled:
		t.Fatalf("stopping claims canceled %s", id)
	default:
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := r.Stop(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected drain timeout: %v", err)
	}
	for i := 0; i < 4; i++ {
		event(t, canceled)
	}
	close(release)
	stopAppRunner(t, r)
	select {
	case id := <-started:
		t.Fatalf("started after stop: %s", id)
	default:
	}
}

func TestAppRunnerRecoversScanFailureAndReportsPanics(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	panics := make(chan struct{})
	reader := appDueReaderFunc(func(context.Context, time.Time, int) ([]string, error) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		if calls == 1 {
			return []string{"bad"}, errors.New("failed")
		}
		return []string{"ok"}, nil
	})
	r := appRunnerFixture(reader, executorFunc(func(_ context.Context, id string) error {
		if id != "ok" {
			t.Errorf("partial scan result executed: %q", id)
		}
		close(panics)
		panic("worker")
	}))
	if err := r.StartWithClaimContext(context.Background(), context.Background()); err != nil {
		t.Fatal(err)
	}
	event(t, panics)
	event(t, r.Failures())
	if err := r.Ready(context.Background()); err == nil {
		t.Fatal("panic did not fail readiness")
	}
	stopAppRunner(t, r)
}

func TestAppRunnerStartupValidation(t *testing.T) {
	if _, err := NewAppRunner(nil, nil, nil); err == nil {
		t.Fatal("accepted missing dependencies")
	}
	r := appRunnerFixture(appDueReaderFunc(func(context.Context, time.Time, int) ([]string, error) { return nil, nil }), executorFunc(func(context.Context, string) error { return nil }))
	if err := r.StartWithClaimContext(nil, context.Background()); err == nil {
		t.Fatal("accepted nil context")
	}
	if err := r.StartWithClaimContext(context.Background(), context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := r.StartWithClaimContext(context.Background(), context.Background()); err == nil {
		t.Fatal("accepted duplicate start")
	}
	stopAppRunner(t, r)
}

func TestAppRunnerCancelsPendingClaimWithoutCancelingWork(t *testing.T) {
	entered := make(chan struct{})
	claimStopped := make(chan struct{})
	workStopped := make(chan struct{})
	reader := appDueReaderFunc(func(context.Context, time.Time, int) ([]string, error) { return []string{"one"}, nil })
	executor := claimExecutorFunc(func(work, claim context.Context, _ string) error {
		close(entered)
		<-claim.Done()
		close(claimStopped)
		<-work.Done()
		close(workStopped)
		return work.Err()
	})
	r := appRunnerFixture(reader, executor)
	if err := r.StartWithClaimContext(context.Background(), context.Background()); err != nil {
		t.Fatal(err)
	}
	event(t, entered)
	r.StopClaims()
	event(t, claimStopped)
	select {
	case <-workStopped:
		t.Fatal("work canceled when only claims stopped")
	default:
	}
	stopAppRunner(t, r)
	event(t, workStopped)
}

func TestAppRunnerConstructorSuppliesDefaults(t *testing.T) {
	reader := appDueReaderFunc(func(context.Context, time.Time, int) ([]string, error) { return nil, nil })
	runner, err := NewAppRunner(reader, &AppExecutor{}, nil)
	if err != nil || runner == nil || runner.interval != time.Second || runner.logger == nil || runner.Failures() == nil {
		t.Fatalf("runner defaults: %#v %v", runner, err)
	}
	if err := runner.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runner.Ready(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("readiness cancellation: %v", err)
	}
	if err := runner.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}
func TestAppRunnerReportsScanPanic(t *testing.T) {
	reader := appDueReaderFunc(func(context.Context, time.Time, int) ([]string, error) { panic("scan") })
	r := appRunnerFixture(reader, executorFunc(func(context.Context, string) error { return nil }))
	if err := r.StartWithClaimContext(context.Background(), context.Background()); err != nil {
		t.Fatal(err)
	}
	event(t, r.Failures())
	if err := r.Ready(context.Background()); err == nil {
		t.Fatal("panic did not fail readiness")
	}
	stopAppRunner(t, r)
}

func TestAppRunnerOwnsDistinctProjectContexts(t *testing.T) {
	contexts := make(chan context.Context, 2)
	release := make(chan struct{})
	r := appRunnerFixture(appDueReaderFunc(func(context.Context, time.Time, int) ([]string, error) {
		return []string{"first", "second"}, nil
	}), executorFunc(func(ctx context.Context, _ string) error {
		contexts <- ctx
		<-release
		return nil
	}))
	if err := r.StartWithClaimContext(context.Background(), context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopAppRunner(t, r) })
	first, second := event(t, contexts), event(t, contexts)
	if first == second {
		t.Fatal("Projects shared one work context")
	}
	r.StopClaims()
	close(release)
	event(t, first.Done())
	event(t, second.Done())
	if !errors.Is(first.Err(), context.Canceled) || !errors.Is(second.Err(), context.Canceled) {
		t.Fatal("completed Project contexts remained active")
	}
}

type runnerLogWriter struct {
	bytes.Buffer
	written chan struct{}
}

func (w *runnerLogWriter) Write(data []byte) (int, error) {
	n, err := w.Buffer.Write(data)
	select {
	case w.written <- struct{}{}:
	default:
	}
	return n, err
}

func TestAppRunnerLogsSafeDatabaseAndRemoteDiagnostics(t *testing.T) {
	w := &runnerLogWriter{written: make(chan struct{}, 2)}
	scans := 0
	r := appRunnerFixture(appDueReaderFunc(func(context.Context, time.Time, int) ([]string, error) {
		scans++
		if scans == 1 {
			return nil, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: &store.Error{Phase: "scan candidates", DatabaseFailure: true, SQLState: "08006", Cause: errors.New("private SQL parameters")}}
		}
		return []string{"project"}, nil
	}), executorFunc(func(context.Context, string) error {
		return &remote.Error{Code: "rate_limited", Status: 429, RequestID: "safe-request"}
	}))
	r.logger = slog.New(slog.NewJSONHandler(w, nil))
	if err := r.StartWithClaimContext(context.Background(), context.Background()); err != nil {
		t.Fatal(err)
	}
	event(t, w.written)
	event(t, w.written)
	stopAppRunner(t, r)
	logs := w.String()
	for _, field := range []string{`"database_phase":"scan candidates"`, `"sql_state":"08006"`, `"write_outcome":"unknown"`, `"transaction_phase":"commit"`, `"remote_code":"rate_limited"`, `"remote_status":429`, `"github_request_id":"safe-request"`} {
		if !strings.Contains(logs, field) {
			t.Errorf("missing %s in %s", field, logs)
		}
	}
	if strings.Contains(logs, "private SQL parameters") {
		t.Fatal("logged private driver cause")
	}
}
