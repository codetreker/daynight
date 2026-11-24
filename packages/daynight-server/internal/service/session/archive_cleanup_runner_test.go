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

func TestArchiveCleanupRunnerKeepsBotProgressAndDrainsItsSweep(t *testing.T) {
	runner := NewArchiveCleanupRunner(NewArchiveCleanup(nil, nil), slog.New(slog.NewTextHandler(io.Discard, nil)))
	runner.interval = time.Millisecond
	if err := runner.SetBotHistorySweep(nil); err == nil {
		t.Fatal("nil Bot sweep accepted")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	entered := make(chan string, 2)
	release := make(chan struct{})
	archiveCalls, botCalls := 0, 0
	var archiveContext context.Context
	runner.sweep = func(ctx context.Context, cursor string) (string, error) {
		archiveContext = ctx
		archiveCalls++
		if archiveCalls == 1 && cursor != "" || archiveCalls == 2 && cursor != "archive-next" {
			t.Error("archive cursor crossed into Bot work", cursor)
		}
		return "archive-next", errors.New("archive failure must not block Bot cleanup")
	}
	if err := runner.SetBotHistorySweep(func(ctx context.Context, cursor string) (string, error) {
		botCalls++
		if ctx == archiveContext || ctx.Err() != nil || archiveContext.Err() == nil {
			t.Error("Bot cleanup inherited the closed archive deadline")
		}
		if _, ok := ctx.Deadline(); !ok {
			t.Error("Bot cleanup has no deadline")
		}
		entered <- cursor
		if botCalls == 1 {
			return "bot-next", errors.New("retryable Bot failure")
		}
		<-ctx.Done()
		<-release
		return cursor, ctx.Err()
	}); err != nil {
		t.Fatal(err)
	}
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
	if err := runner.SetBotHistorySweep(func(context.Context, string) (string, error) { return "", nil }); err == nil {
		t.Fatal("active sweep was replaced")
	}
	for _, expected := range []string{"", "bot-next"} {
		select {
		case actual := <-entered:
			if actual != expected {
				t.Fatal("Bot cursor lost", actual, expected)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	runner.Cancel()
	stopped, stop := context.WithCancel(context.Background())
	stop()
	if err := runner.Stop(stopped); !errors.Is(err, context.Canceled) {
		t.Fatal("Bot sweep was not drained", err)
	}
	close(release)
	if err := runner.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if archiveCalls != 2 || botCalls != 2 {
		t.Fatal("unexpected cleanup passes", archiveCalls, botCalls)
	}
}
