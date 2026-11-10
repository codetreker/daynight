package session_test

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

func watchDeletedChannel(ctx context.Context, conn *websocket.Conn) <-chan error {
	done := make(chan error, 1)
	go func() {
		for {
			if _, _, err := conn.Read(ctx); err != nil {
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
	supplied := routeCopy(snapshot)
	supplied.Lifecycle, supplied.ConnectionState, supplied.Activity = "draining", "connected", "idle"
	supplied.Synchronized = true
	cursor := "project-browser-cursor"
	f.backend.AllowRepeated("BrowserPoll")
	f.backend.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.BrowserPoll = func(ctx context.Context, p model.Principal, project, task, id, actualCursor string) (sp.Snapshot, []map[string]any, string, error) {
			if err := f.scopeArguments(ctx, p, project, task, id); err != nil {
				return sp.Snapshot{}, nil, "", err
			}
			if err := f.require(actualCursor == "" || actualCursor == cursor, "browser cursor changed"); err != nil {
				return sp.Snapshot{}, nil, "", err
			}
			return routeCopy(supplied), []map[string]any{}, cursor, nil
		}
	})
	f.authentication.ExpectCalls(1)
	browser := sessionDial(t, f.server.URL, f.base+"/"+snapshot.SessionID+"/channel", f.handler.token, nil)
	sessionWSKind(t, browser, "snapshot")
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	controllerClosed, browserClosed := watchDeletedChannel(ctx, controller), watchDeletedChannel(ctx, browser)
	if err := controller.Ping(ctx); err != nil {
		t.Fatal("controller unavailable before missing-Project reply", err)
	}
	if err := browser.Ping(ctx); err != nil {
		t.Fatal("browser unavailable before missing-Project reply", err)
	}
	missing := &model.Fault{Code: "not_found", Message: "Project was not found."}
	var controllerRefusals, browserRefusals atomic.Int32
	f.backend.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.Poll = func(ctx context.Context, fence sp.ControllerFence) ([]map[string]any, error) {
			if err := f.require(ctx != nil && fence == snapshot.ControllerFence, "missing-Project Poll fence/context changed"); err != nil {
				return nil, err
			}
			controllerRefusals.Add(1)
			return nil, missing
		}
		c.BrowserPoll = func(ctx context.Context, p model.Principal, project, task, id, actualCursor string) (sp.Snapshot, []map[string]any, string, error) {
			if err := f.scopeArguments(ctx, p, project, task, id); err != nil {
				return sp.Snapshot{}, nil, "", err
			}
			if err := f.require(actualCursor == cursor, "missing-Project browser cursor changed"); err != nil {
				return sp.Snapshot{}, nil, "", err
			}
			browserRefusals.Add(1)
			return sp.Snapshot{}, nil, "", missing
		}
		c.Disconnect = func(ctx context.Context, fence sp.ControllerFence) error {
			_, bounded := ctx.Deadline()
			if err := f.require(ctx.Err() == nil && bounded && fence == snapshot.ControllerFence, "missing-Project cleanup context/fence changed"); err != nil {
				return err
			}
			return missing
		}
	})
	f.expectShutdownError = func(err error) bool { return shutdownFaultMatches(err, "not_found") }
	requireDeletedChannelClosed(t, ctx, controllerClosed)
	requireDeletedChannelClosed(t, ctx, browserClosed)
	drain, cancelDrain := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancelDrain()
	if err := f.application.Shutdown(drain); err != nil && !shutdownFaultMatches(err, "not_found") {
		t.Fatal("missing-Project channels did not drain", err)
	}
	if controllerRefusals.Load() == 0 || browserRefusals.Load() == 0 || f.backend.Called("Disconnect") != 1 {
		t.Fatal("closure did not follow both missing-Project replies and one cleanup")
	}
}

func TestDeletedProjectClosesTerminalBrowserAfterWorkerCompletion(t *testing.T) {
	f := terminalHTTPSetup(t)
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	path := f.base + "/" + f.message.SessionID
	acknowledgement := f.ack("1")
	state := f.knownState("1")
	browserID := uuid.NewString()
	f.calls.AllowRepeated("PollTerminal")
	f.calls.AllowRepeated("TerminalState")
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.RegisterTerminal = func(ctx context.Context, p model.Principal, project, task string, message v2.Message) (v2.Message, error) {
			f.scope(t, ctx, p, project, task, message.SessionID)
			if !reflect.DeepEqual(message, f.message) {
				t.Error("worker registration frame changed")
			}
			return acknowledgement, nil
		}
		c.BindTerminalConnection = func(ctx context.Context, p model.Principal, project, task, id string, fence v2.Envelope, epoch string) error {
			f.scope(t, ctx, p, project, task, id)
			if fence != f.message.Envelope || epoch != "1" {
				t.Error("worker bind fence/epoch changed")
			}
			return nil
		}
		c.PollTerminal = func(ctx context.Context, p model.Principal, project, task, id string, fence v2.Envelope, epoch string) ([]v2.Message, error) {
			f.scope(t, ctx, p, project, task, id)
			if fence != f.message.Envelope || epoch != "1" {
				t.Error("worker Poll fence/epoch changed")
			}
			return []v2.Message{}, nil
		}
		c.TerminalState = func(ctx context.Context, p model.Principal, project, task, id string) (map[string]any, error) {
			f.scope(t, ctx, p, project, task, id)
			return routeCopy(state), nil
		}
		c.DisconnectTerminal = func(ctx context.Context, p model.Principal, project, task, id string, fence v2.Envelope, epoch string) error {
			f.scope(t, ctx, p, project, task, id)
			_, bounded := ctx.Deadline()
			if !bounded || fence != f.message.Envelope || epoch != "1" {
				t.Error("worker cleanup fence/epoch/deadline changed")
			}
			return nil
		}
		c.DisconnectTerminalViewer = func(ctx context.Context, p model.Principal, project, task, id, actualBrowser, claim, epoch string) error {
			f.scope(t, ctx, p, project, task, id)
			_, bounded := ctx.Deadline()
			if !bounded || actualBrowser != browserID || claim != f.message.ClaimID || epoch != "1" {
				t.Error("viewer cleanup browser/claim/epoch/deadline changed")
			}
			return nil
		}
	})
	f.authentication.ExpectCalls(1)
	worker, _, err := websocket.Dial(ctx, f.server.URL+path+"/worker-channel", &websocket.DialOptions{HTTPHeader: f.workerHeaders(), Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.CloseNow()
	if got := f.handshake(t, worker); !reflect.DeepEqual(got, acknowledgement) {
		t.Fatal("worker ACK changed supplied usecase result")
	}
	f.authentication.ExpectCalls(1)
	browser, _, err := websocket.Dial(ctx, f.server.URL+path+"/channel?browserClientId="+browserID, &websocket.DialOptions{HTTPHeader: f.viewerHeaders(f.h), Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer browser.CloseNow()
	sessionWSRead(t, browser)
	workerClosed, browserClosed := watchDeletedChannel(ctx, worker), watchDeletedChannel(ctx, browser)
	if err = worker.Ping(ctx); err != nil {
		t.Fatal("worker unavailable before completion reply", err)
	}
	if err = browser.Ping(ctx); err != nil {
		t.Fatal("browser unavailable before completion reply", err)
	}
	completed := &model.Fault{Code: "session_conflict", Message: "Worker execution ended."}
	disconnected := routeCopy(state)
	disconnected["connected"] = false
	var completionReplies atomic.Int32
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.PollTerminal = func(ctx context.Context, p model.Principal, project, task, id string, fence v2.Envelope, epoch string) ([]v2.Message, error) {
			f.scope(t, ctx, p, project, task, id)
			if fence != f.message.Envelope || epoch != "1" {
				t.Error("completed worker Poll scope changed")
			}
			completionReplies.Add(1)
			return nil, completed
		}
		c.TerminalState = func(ctx context.Context, p model.Principal, project, task, id string) (map[string]any, error) {
			f.scope(t, ctx, p, project, task, id)
			return routeCopy(disconnected), nil
		}
	})
	requireDeletedChannelClosed(t, ctx, workerClosed)
	f.waitConnections(t, 1)
	if completionReplies.Load() == 0 || f.calls.Called("DisconnectTerminal") != 1 {
		t.Fatal("worker closure did not follow completion reply and one cleanup")
	}
	if err = browser.Ping(ctx); err != nil {
		t.Fatal("terminal browser closed before missing-Project reply", err)
	}
	missing := &model.Fault{Code: "not_found", Message: "Project was not found."}
	var missingReplies atomic.Int32
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.TerminalState = func(ctx context.Context, p model.Principal, project, task, id string) (map[string]any, error) {
			f.scope(t, ctx, p, project, task, id)
			missingReplies.Add(1)
			return nil, missing
		}
		c.DisconnectTerminalViewer = func(ctx context.Context, p model.Principal, project, task, id, actualBrowser, claim, epoch string) error {
			f.scope(t, ctx, p, project, task, id)
			_, bounded := ctx.Deadline()
			if !bounded || actualBrowser != browserID || claim != f.message.ClaimID || epoch != "1" {
				t.Error("missing-Project viewer cleanup arguments changed")
			}
			return missing
		}
	})
	f.expectShutdownError = func(err error) bool { return shutdownFaultMatches(err, "not_found") }
	requireDeletedChannelClosed(t, ctx, browserClosed)
	f.waitConnections(t, 0)
	if missingReplies.Load() == 0 || f.calls.Called("DisconnectTerminalViewer") != 1 {
		t.Fatal("browser closure did not follow missing-Project reply and one cleanup")
	}
}

func TestDeletedProjectTimelineReturnsNotFound(t *testing.T) {
	f := sessionHTTPSetup(t)
	f.authentication.ExpectCalls(1)
	f.nextCall("Timeline")
	f.backend.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.Timeline = func(ctx context.Context, p model.Principal, project, task, id, direction, cursor string, limit int) (map[string]any, error) {
			if err := f.scopeArguments(ctx, p, project, task, id); err != nil {
				return nil, err
			}
			if err := f.require(direction == "tail" && cursor == "" && limit == 100, "missing Project changed timeline defaults"); err != nil {
				return nil, err
			}
			return nil, &model.Fault{Code: "not_found", Message: "Project was not found."}
		}
	})
	assertProjectError(t, projectRequest(f.handler, http.MethodGet, f.base+"/"+f.snapshot.SessionID+"/timeline", ""), http.StatusNotFound, "not_found")
}
