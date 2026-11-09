package session_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func watchDeletedChannel(ctx context.Context, conn *websocket.Conn) <-chan error {
	done := make(chan error, 1)
	go func() {
		for {
			_, _, err := conn.Read(ctx)
			if err != nil {
				done <- err
				return
			}
		}
	}()
	return done
}

func requireDeletedChannelClosed(t *testing.T, ctx context.Context, done <-chan error) {
	t.Helper()
	select {
	case err := <-done:
		if errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
			t.Fatalf("connection remained open: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("connection remained open")
	}
}

func TestDeletedProjectClosesWebSessionChannels(t *testing.T) {
	f := sessionHTTPSetup(t)
	f.backend.Declare("owner.project-controller-missing", map[string]int{"SessionLocation": 1, "LockTask": 1}, func() any { return f.InputSnapshot() }, true)
	f.backend.Declare("owner.project-browser-missing", map[string]int{"LockTask": 1}, func() any { return f.InputSnapshot() }, true)
	f.backend.Background("native.disconnect", "owner.project-controller-missing")
	controller, snapshot := f.controller(t, uuid.NewString(), "owner.project-controller-missing")
	browser := sessionDial(t, f.server.URL, f.base+"/"+snapshot.SessionID+"/channel", f.handler.token, f.backend.PlanHeader("native.browser", "owner.project-browser-missing"))
	sessionWSKind(t, browser, "snapshot")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	controllerClosed := watchDeletedChannel(ctx, controller)
	browserClosed := watchDeletedChannel(ctx, browser)
	f.SetInput(func(in *nativeRouteInput) {
		worker := *in.Task.Worker
		worker.State = model.WorkerCompleted
		in.Task.Worker = &worker
		in.Session.Snapshot.Lifecycle = "draining"
		deadline := time.Now().Add(time.Minute)
		in.Session.DrainUntil = &deadline
	})
	var err error
	if err = controller.Ping(ctx); err != nil {
		t.Fatalf("controller closed before deletion: %v", err)
	}
	if err = browser.Ping(ctx); err != nil {
		t.Fatalf("browser closed before deletion: %v", err)
	}
	f.expectShutdownError = projectMissingDrainMatches
	f.SetInput(func(in *nativeRouteInput) { in.TaskError = model.ErrNotFound })
	requireDeletedChannelClosed(t, ctx, controllerClosed)
	requireDeletedChannelClosed(t, ctx, browserClosed)
}

func TestDeletedProjectClosesTerminalBrowserAfterWorkerCompletion(t *testing.T) {
	f := terminalHTTPSetup(t)
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	path := f.base + "/" + f.message.SessionID
	f.declareTerminal("owner.terminal-completed", terminalReadCounts(nil), true)
	f.declareTerminal("owner.terminal-project-missing", map[string]int{"LockTask": 1}, true)
	f.declareTerminal("owner.terminal-archive-project-missing", map[string]int{"LockArchiveTask": 1}, true)
	f.backend.Background("terminal-worker-drain", "terminal-worker-stale-drain", "terminal-viewer-drain", "terminal-viewer-stale-drain", "owner.terminal-archive-project-missing", "owner.terminal-project-missing")
	worker, _, err := websocket.Dial(ctx, f.server.URL+path+"/worker-channel", &websocket.DialOptions{HTTPHeader: f.workerHeaders("owner.terminal-completed"), Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.CloseNow()
	f.handshake(t, worker)
	browserHeader := f.viewerHeaders(f.h)
	browserHeader.Set(routePlanHeader, browserHeader.Get(routePlanHeader)+",owner.terminal-project-missing")
	browser, _, err := websocket.Dial(ctx, f.server.URL+path+"/channel?browserClientId="+uuid.NewString(), &websocket.DialOptions{HTTPHeader: browserHeader, Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer browser.CloseNow()
	sessionWSRead(t, browser)
	workerClosed := watchDeletedChannel(ctx, worker)
	browserClosed := watchDeletedChannel(ctx, browser)
	if err = worker.Ping(ctx); err != nil {
		t.Fatal("worker unavailable before completion", err)
	}
	if err = browser.Ping(ctx); err != nil {
		t.Fatal("browser unavailable before completion", err)
	}
	writeIndex := f.writeIndex()
	f.completeTask()
	requireDeletedChannelClosed(t, ctx, workerClosed)
	f.awaitSaved(t, writeIndex, func(r terminalRouteRecord) bool { return r.LastSeen == nil })
	if err = browser.Ping(ctx); err != nil {
		t.Fatal("browser closed on completion before Project disappearance", err)
	}
	f.expectShutdownError = projectMissingDrainMatches
	f.projectMissing()
	requireDeletedChannelClosed(t, ctx, browserClosed)
}

func projectMissingDrainMatches(err error) bool {
	if drained, ok := err.(interface {
		Drained() bool
		Unwrap() error
	}); ok && drained.Drained() {
		return projectMissingDrainMatches(drained.Unwrap())
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		causes := joined.Unwrap()
		if len(causes) == 0 {
			return false
		}
		for _, cause := range causes {
			if !projectMissingDrainMatches(cause) {
				return false
			}
		}
		return true
	}
	if fault, ok := err.(*model.Fault); ok {
		return fault.Code == "not_found" && fault.Cause == nil
	}
	transaction, ok := err.(*store.TransactionError)
	return ok && transaction.Phase == "operation" && transaction.Outcome == store.TransactionNotCommitted && !transaction.CommitAttempted && !transaction.CleanupFailed && transaction.Cause == model.ErrNotFound
}
