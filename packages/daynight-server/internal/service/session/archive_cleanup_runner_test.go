package session

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"
)

func TestArchiveCleanupRunnerRetriesAndDrains(t *testing.T) {
	entered := make(chan string, 2)
	release := make(chan struct{})
	calls := 0
	runner := NewArchiveCleanupRunner(NewArchiveCleanup(nil, nil), slog.New(slog.NewTextHandler(io.Discard, nil)))
	runner.interval = time.Millisecond
	runner.sweep = func(ctx context.Context, cursor string) (string, error) {
		calls++
		entered <- cursor
		if calls == 1 {
			return "next", errors.New("physical cleanup failed")
		}
		<-ctx.Done()
		<-release
		return cursor, ctx.Err()
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := runner.Start(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		runner.Cancel()
		select {
		case <-release:
		default:
			close(release)
		}
		if err := runner.Stop(context.Background()); err != nil {
			t.Error(err)
		}
	})
	if err := runner.Start(ctx); err == nil {
		t.Fatal("started twice")
	}
	for _, want := range []string{"", "next"} {
		select {
		case got := <-entered:
			if got != want {
				t.Fatalf("cursor %q want %q", got, want)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	runner.Cancel()
	stopped, cancelStop := context.WithCancel(context.Background())
	cancelStop()
	if err := runner.Stop(stopped); !errors.Is(err, context.Canceled) {
		t.Fatalf("drain pretended work exited: %v", err)
	}
	close(release)
	if err := runner.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("unexpected sweeps %d", calls)
	}
}

func TestArchiveCleanupRunnerIdleCancellationAndInvalidStart(t *testing.T) {
	runner := NewArchiveCleanupRunner(NewArchiveCleanup(nil, nil), nil)
	if err := runner.Stop(t.Context()); err != nil {
		t.Fatal(err)
	}
	runner.Cancel()
	if err := runner.Start(nil); err == nil {
		t.Fatal("accepted nil context")
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if err := runner.Start(cancelled); err == nil {
		t.Fatal("accepted cancelled context")
	}
	entered := make(chan struct{})
	runner.sweep = func(context.Context, string) (string, error) { close(entered); return "", nil }
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := runner.Start(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := runner.Stop(ctx); err != nil {
		t.Fatal(err)
	}
}
