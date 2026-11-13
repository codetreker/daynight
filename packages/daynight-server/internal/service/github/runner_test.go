package github

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type dueReaderFunc func(context.Context, int64, time.Time, int) ([]string, error)

func (f dueReaderFunc) DueGitHubProjects(ctx context.Context, id int64, now time.Time, limit int) ([]string, error) {
	return f(ctx, id, now, limit)
}

type executorFunc func(context.Context, string) error

func (f executorFunc) ExecuteWithClaimContext(ctx, _ context.Context, id string) error {
	return f(ctx, id)
}

func runnerFixture(reader store.GitHubWorkReader, exec projectExecutor) *Runner {
	return &Runner{reader: reader, executor: exec, appID: 8, interval: 10 * time.Millisecond, logger: slog.New(slog.NewTextHandler(io.Discard, nil)), failures: make(chan error, 1)}
}
func event[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case x := <-ch:
		return x
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for runner")
		var zero T
		return zero
	}
}
func stopRunner(t *testing.T, r *Runner) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := r.Stop(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestRunnerBoundsAndStopsAdmissionBeforeCancellation(t *testing.T) {
	scans := make(chan struct{}, 10)
	started := make(chan string, 20)
	release := make(chan struct{})
	canceled := make(chan string, 10)
	reader := dueReaderFunc(func(ctx context.Context, id int64, _ time.Time, limit int) ([]string, error) {
		if id != 8 || limit != 32 {
			t.Errorf("scan id=%d limit=%d", id, limit)
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
	r := runnerFixture(reader, exec)
	if err := r.StartWithClaimContext(context.Background(), context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
		stopRunner(t, r)
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
	stopRunner(t, r)
	select {
	case id := <-started:
		t.Fatalf("started after stop: %s", id)
	default:
	}
}

func TestRunnerRecoversScanFailureAndReportsPanics(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	panics := make(chan struct{})
	reader := dueReaderFunc(func(context.Context, int64, time.Time, int) ([]string, error) {
		mu.Lock()
		defer mu.Unlock()
		calls++
		if calls == 1 {
			return []string{"bad"}, errors.New("failed")
		}
		return []string{"ok"}, nil
	})
	r := runnerFixture(reader, executorFunc(func(_ context.Context, id string) error {
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
	stopRunner(t, r)
}

func TestRunnerStartupValidation(t *testing.T) {
	if _, err := NewRunner(nil, nil, 0, nil); err == nil {
		t.Fatal("accepted missing dependencies")
	}
	r := runnerFixture(dueReaderFunc(func(context.Context, int64, time.Time, int) ([]string, error) { return nil, nil }), executorFunc(func(context.Context, string) error { return nil }))
	if err := r.StartWithClaimContext(nil, context.Background()); err == nil {
		t.Fatal("accepted nil context")
	}
	if err := r.StartWithClaimContext(context.Background(), context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := r.StartWithClaimContext(context.Background(), context.Background()); err == nil {
		t.Fatal("accepted duplicate start")
	}
	stopRunner(t, r)
}

type claimExecutorFunc func(context.Context, context.Context, string) error

func (f claimExecutorFunc) ExecuteWithClaimContext(work, claim context.Context, project string) error {
	return f(work, claim, project)
}

func TestRunnerCancelsPendingClaimWithoutCancelingWork(t *testing.T) {
	entered := make(chan struct{})
	claimStopped := make(chan struct{})
	workStopped := make(chan struct{})
	reader := dueReaderFunc(func(context.Context, int64, time.Time, int) ([]string, error) { return []string{"one"}, nil })
	executor := claimExecutorFunc(func(work, claim context.Context, _ string) error {
		close(entered)
		<-claim.Done()
		close(claimStopped)
		<-work.Done()
		close(workStopped)
		return work.Err()
	})
	r := runnerFixture(reader, executor)
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
	stopRunner(t, r)
	event(t, workStopped)
}

func TestRunnerConstructorSuppliesDefaults(t *testing.T) {
	reader := dueReaderFunc(func(context.Context, int64, time.Time, int) ([]string, error) { return nil, nil })
	runner, err := NewRunner(reader, &Executor{}, 8, nil)
	if err != nil || runner == nil || runner.interval != time.Second || runner.logger == nil || runner.Failures() == nil {
		t.Fatalf("runner defaults: %#v %v", runner, err)
	}
	if err := runner.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}
func TestRunnerReportsScanPanic(t *testing.T) {
	reader := dueReaderFunc(func(context.Context, int64, time.Time, int) ([]string, error) { panic("scan") })
	r := runnerFixture(reader, executorFunc(func(context.Context, string) error { return nil }))
	if err := r.StartWithClaimContext(context.Background(), context.Background()); err != nil {
		t.Fatal(err)
	}
	event(t, r.Failures())
	stopRunner(t, r)
}
