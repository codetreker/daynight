package session_test

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
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
	controller, snapshot := f.controller(t, uuid.NewString())
	browser := sessionDial(t, f.server.URL, f.base+"/"+snapshot.SessionID+"/channel", f.handler.token, nil)
	sessionWSKind(t, browser, "snapshot")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	controllerClosed := watchDeletedChannel(ctx, controller)
	browserClosed := watchDeletedChannel(ctx, browser)
	tx, err := f.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{state}','"completed"')::text WHERE task_id=$1 AND name='worker'`, f.task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{lifecycle}','"draining"'),draining_until=now()+interval '1 minute' WHERE id=$1`, snapshot.SessionID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = controller.Ping(ctx); err != nil {
		t.Fatalf("controller closed before deletion: %v", err)
	}
	if err = browser.Ping(ctx); err != nil {
		t.Fatalf("browser closed before deletion: %v", err)
	}
	deleted := projectRequest(f.handler, http.MethodDelete, "/api/v1/projects/"+f.task.ProjectID, "")
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete %d: %s", deleted.Code, deleted.Body.String())
	}
	// Socket closure can precede disconnect cleanup against the deleted Project.
	f.expectShutdownError = func(err error) bool { return shutdownFaultMatches(err, "not_found") }
	requireDeletedChannelClosed(t, ctx, controllerClosed)
	requireDeletedChannelClosed(t, ctx, browserClosed)
}

func TestDeletedProjectClosesTerminalSessionChannels(t *testing.T) {
	f := terminalHTTPSetup(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	path := f.base + "/" + f.message.SessionID
	header := http.Header{"Authorization": []string{"Bearer " + f.h.token}}
	worker, _, err := websocket.Dial(ctx, f.server.URL+path+"/worker-channel", &websocket.DialOptions{HTTPHeader: header, Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.CloseNow()
	sessionWSWrite(t, worker, f.message)
	sessionWSKind(t, worker, "registration_ack")
	browser, _, err := websocket.Dial(ctx, f.server.URL+path+"/channel?browserClientId="+uuid.NewString(), &websocket.DialOptions{HTTPHeader: header, Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer browser.CloseNow()
	sessionWSRead(t, browser)
	workerClosed := watchDeletedChannel(ctx, worker)
	browserClosed := watchDeletedChannel(ctx, browser)
	if err = worker.Ping(ctx); err != nil {
		t.Fatalf("worker unavailable before claim completed: %v", err)
	}
	owner := f.message.Payload.(v2.Registration).Owner
	if _, err = f.db.Pool.Exec(ctx, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{state}','"completed"')::text WHERE task_id=$1 AND name='worker'`, owner.TaskID); err != nil {
		t.Fatal(err)
	}
	if err = browser.Ping(ctx); err != nil {
		t.Fatalf("terminal browser closed before deletion: %v", err)
	}
	deleted := projectRequest(f.h, http.MethodDelete, "/api/v1/projects/"+owner.ProjectID, "")
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete %d: %s", deleted.Code, deleted.Body.String())
	}
	// Socket closure can precede disconnect cleanup against the deleted Project.
	f.expectShutdownError = func(err error) bool { return shutdownFaultMatches(err, "not_found") }
	requireDeletedChannelClosed(t, ctx, workerClosed)
	requireDeletedChannelClosed(t, ctx, browserClosed)
}
