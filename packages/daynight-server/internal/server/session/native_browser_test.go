package session_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

func browserFixtureSnapshot(f *sessionHTTPFixture) sp.Snapshot {
	snapshot := f.snapshot
	snapshot.ConnectionEpoch = "1"
	snapshot.ConnectionState = "connected"
	snapshot.Synchronized = true
	snapshot.Activity = "idle"
	return snapshot
}

func browserTimelineEvent(snapshot sp.Snapshot, sequence, entryID, text string) map[string]any {
	return sp.BindingFields(snapshot.Fence, map[string]any{"protocol": sp.Protocol, "sessionId": snapshot.SessionID, "claimId": snapshot.ClaimID, "executionGeneration": snapshot.ExecutionGeneration, "connectionEpoch": snapshot.ConnectionEpoch, "eventSeq": sequence, "historyEpoch": snapshot.HistoryEpoch, "kind": "timeline_upsert", "payload": map[string]any{"entryId": entryID, "entrySeq": sequence, "revision": "1", "kind": "reasoning", "text": text}})
}

func browserCallArguments(t *testing.T, f *sessionHTTPFixture, ctx context.Context, principal model.Principal, project, task, session string) error {
	t.Helper()
	if ctx == nil || project != f.task.ProjectID || task != f.task.ID || session != f.snapshot.SessionID || principal != f.handler.principal {
		cause := fmt.Errorf("BrowserPoll received unexpected context, principal or resource IDs")
		t.Error(cause)
		return cause
	}
	return nil
}

func TestSessionRoutesBrowserRespondsToPingAndContinuesReceivingEvents(t *testing.T) {
	f := sessionHTTPSetupWithApplication(t, newSessionPingApplication)
	snapshot := browserFixtureSnapshot(f)
	next := snapshot
	next.LastEventSeq, next.LastTimelineSeq = "1", "1"
	initialCursor, eventCursor := "ping-initial", "ping-event"
	entryID := uuid.NewString()
	event := browserTimelineEvent(snapshot, "1", entryID, "Output after the browser answered the server ping")
	eventReady := make(chan struct{})
	f.backend.RequireCalls("BrowserPoll", 2)
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.BrowserPoll = func(ctx context.Context, principal model.Principal, project, task, session, after string) (sp.Snapshot, []map[string]any, string, error) {
			if err := browserCallArguments(t, f, ctx, principal, project, task, session); err != nil {
				return sp.Snapshot{}, nil, "", err
			}
			switch after {
			case "":
				return snapshot, nil, initialCursor, nil
			case initialCursor:
				select {
				case <-eventReady:
					return next, []map[string]any{event}, eventCursor, nil
				default:
					return snapshot, nil, initialCursor, nil
				}
			case eventCursor:
				return next, nil, eventCursor, nil
			default:
				cause := fmt.Errorf("BrowserPoll changed the supplied Ping cursor: %q", after)
				t.Error(cause)
				return sp.Snapshot{}, nil, "", cause
			}
		}
	})
	pingSeen := make(chan struct{})
	var firstPing sync.Once
	path := f.base + "/" + snapshot.SessionID + "/channel"
	browser := sessionDialOptions(t, f.server.URL, path, f.handler.token, nil, websocket.DialOptions{OnPingReceived: func(context.Context, []byte) bool { firstPing.Do(func() { close(pingSeen) }); return true }})
	sessionWSKind(t, browser, "snapshot")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	type readResult struct {
		data []byte
		err  error
	}
	result := make(chan readResult, 1)
	go func() {
		// Read handles Ping control frames and sends Pong while awaiting the
		// following application event on the same connection.
		_, data, err := browser.Read(ctx)
		result <- readResult{data, err}
	}()
	select {
	case early := <-result:
		t.Fatalf("idle browser closed or received data before Ping: %s, %v", early.data, early.err)
	case <-pingSeen:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	close(eventReady)
	select {
	case received := <-result:
		if received.err != nil {
			t.Fatalf("browser could not receive after Ping: %v", received.err)
		}
		var frame map[string]json.RawMessage
		if err := json.Unmarshal(received.data, &frame); err != nil || string(frame["type"]) != `"event"` {
			t.Fatalf("expected an application event after Ping: %s, %v", received.data, err)
		}
		value, err := sp.DecodeEvent(frame["event"])
		if err != nil || value.Kind != "timeline_upsert" || value.HistoryEpoch != snapshot.HistoryEpoch {
			t.Fatalf("invalid event after Ping: %+v, %v", value, err)
		}
		entry, err := sp.DecodeTimeline(value.Payload)
		if err != nil || entry.EntryID != entryID {
			t.Fatalf("wrong entry after Ping: %+v, %v", entry, err)
		}
	case <-ctx.Done():
		t.Fatal("browser did not receive an event after Ping: ", ctx.Err())
	}
}

func TestSessionRoutesBrowserHistoryResetClosesOldCursorAndRecovers(t *testing.T) {
	f := sessionHTTPSetup(t)
	snapshot := browserFixtureSnapshot(f)
	recoveredSnapshot := snapshot
	recoveredSnapshot.LastEventSeq, recoveredSnapshot.LastTimelineSeq = "24", "24"
	next := recoveredSnapshot
	next.LastEventSeq, next.LastTimelineSeq = "25", "25"
	oldCursor, freshCursor, eventCursor := "history-old", "history-current", "history-event"
	entryID, text := uuid.NewString(), strings.Repeat("x", 100*1024)
	event := browserTimelineEvent(next, "25", entryID, text)
	eventReady := make(chan struct{})
	var initial atomic.Int32
	f.backend.RequireCalls("BrowserPoll", 4)
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.BrowserPoll = func(ctx context.Context, principal model.Principal, project, task, session, after string) (sp.Snapshot, []map[string]any, string, error) {
			if err := browserCallArguments(t, f, ctx, principal, project, task, session); err != nil {
				return sp.Snapshot{}, nil, "", err
			}
			switch after {
			case "":
				switch initial.Add(1) {
				case 1:
					return snapshot, nil, oldCursor, nil
				case 2:
					return recoveredSnapshot, nil, freshCursor, nil
				}
			case oldCursor:
				return sp.Snapshot{}, nil, "", &model.Fault{Code: "reset_required", Message: "The supplied history cursor has expired."}
			case freshCursor:
				select {
				case <-eventReady:
					return next, []map[string]any{event}, eventCursor, nil
				default:
					return recoveredSnapshot, nil, freshCursor, nil
				}
			case eventCursor:
				return next, nil, eventCursor, nil
			}
			cause := fmt.Errorf("BrowserPoll received an unexpected history request: after=%q,initial=%d", after, initial.Load())
			t.Error(cause)
			return sp.Snapshot{}, nil, "", cause
		}
	})
	path := f.base + "/" + snapshot.SessionID + "/channel"
	browser := sessionDial(t, f.server.URL, path, f.handler.token, nil)
	first := sessionWSKind(t, browser, "snapshot")
	var suppliedCursor string
	if err := json.Unmarshal(first["cursor"], &suppliedCursor); err != nil || suppliedCursor != oldCursor {
		t.Fatalf("initial cursor: %s,%v", first["cursor"], err)
	}
	_ = browser.CloseNow()
	stale := sessionDial(t, f.server.URL, path+"?after="+oldCursor, f.handler.token, nil)
	frame := sessionWSRead(t, stale)
	if string(frame["type"]) != `"reset_required"` || string(frame["protocol"]) != `"`+sp.Protocol+`"` {
		t.Fatalf("old cursor received history instead of reset: %s", jsonBody(t, frame))
	}
	var reason string
	if json.Unmarshal(frame["reason"], &reason) != nil || reason == "" {
		t.Fatal("history reset omitted its reason")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_, data, err := stale.Read(ctx)
	if err == nil || ctx.Err() != nil {
		cancel()
		t.Fatalf("reset must close without further cursor traffic: frame=%s,error=%v", data, err)
	}
	cancel()
	recovered := sessionDial(t, f.server.URL, path, f.handler.token, nil)
	recovered.SetReadLimit(sp.MaxFrameBytes)
	frame = sessionWSKind(t, recovered, "snapshot")
	current, err := sp.DecodeSnapshot(frame["snapshot"])
	if err != nil || current.HistoryEpoch != snapshot.HistoryEpoch || current.LastEventSeq != "24" {
		t.Fatalf("replacement snapshot: %+v,%v", current, err)
	}
	if err := json.Unmarshal(frame["cursor"], &suppliedCursor); err != nil || suppliedCursor != freshCursor || suppliedCursor == oldCursor {
		t.Fatalf("replacement cursor: %s,%v", frame["cursor"], err)
	}
	close(eventReady)
	frame = sessionWSKind(t, recovered, "event")
	value, err := sp.DecodeEvent(frame["event"])
	if err != nil || value.HistoryEpoch != snapshot.HistoryEpoch || value.Kind != "timeline_upsert" || value.EventSeq != "25" {
		t.Fatalf("replacement event: %+v,%v", value, err)
	}
	entry, err := sp.DecodeTimeline(value.Payload)
	var receivedText string
	if err != nil || entry.EntryID != entryID || json.Unmarshal(entry.Data["text"], &receivedText) != nil || receivedText != text {
		t.Fatalf("replacement timeline entry lost frame bytes: %+v,%v", entry, err)
	}
}

func TestSessionRoutesCookieOriginResetAndShutdown(t *testing.T) {
	f := sessionHTTPSetup(t)
	snapshot := browserFixtureSnapshot(f)
	path := f.base + "/" + snapshot.SessionID + "/channel"
	principal := model.Principal{Kind: model.SessionCredential, UserID: f.handler.principal.UserID, CredentialID: uuid.NewString()}
	secret := f.authentication.Credential(principal)
	missingID := uuid.NewString()
	f.backend.RequireCalls("BrowserPoll", 4)
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.BrowserPoll = func(ctx context.Context, p model.Principal, project, task, session, after string) (sp.Snapshot, []map[string]any, string, error) {
			if ctx == nil || project != f.task.ProjectID || task != f.task.ID || p != f.handler.principal && p != principal {
				cause := fmt.Errorf("cookie BrowserPoll lost principal,context or resource IDs")
				t.Error(cause)
				return sp.Snapshot{}, nil, "", cause
			}
			if session == missingID && after == "" {
				return sp.Snapshot{}, nil, "", &model.Fault{Code: "not_found", Message: "Session was not found."}
			}
			if session == snapshot.SessionID {
				switch after {
				case "", "cookie-current":
					return snapshot, nil, "cookie-current", nil
				case "invalid":
					return sp.Snapshot{}, nil, "", &model.Fault{Code: "reset_required", Message: "Invalid supplied cursor."}
				}
			}
			cause := fmt.Errorf("cookie BrowserPoll received an unconfigured Session or cursor")
			t.Error(cause)
			return sp.Snapshot{}, nil, "", cause
		}
	})
	cookie := "__Host-daynight_session=" + secret
	for _, origin := range []string{"", "https://evil.example", "https://daynight.example.evil"} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		header := http.Header{"Cookie": []string{cookie}}
		if origin != "" {
			header.Set("Origin", origin)
		}
		before := f.backend.TotalCalls()
		conn, response, err := websocket.Dial(ctx, strings.Replace(f.server.URL, "http://", "ws://", 1)+path, &websocket.DialOptions{HTTPHeader: header})
		cancel()
		if conn != nil {
			_ = conn.CloseNow()
		}
		if err == nil || response == nil || response.StatusCode != http.StatusForbidden {
			t.Fatalf("cookie origin %q accepted: %v", origin, err)
		}
		if f.backend.TotalCalls() != before {
			t.Fatal("cookie Origin refusal reached the service")
		}
	}
	browser := sessionDial(t, f.server.URL, path, "", http.Header{"Cookie": []string{cookie}, "Origin": []string{"https://daynight.example"}})
	sessionWSKind(t, browser, "snapshot")
	reset := sessionDial(t, f.server.URL, path+"?after=invalid", f.handler.token, nil)
	sessionWSKind(t, reset, "reset_required")
	for _, requestPath := range []string{path + "?unknown=1", f.base + "/" + missingID + "/channel"} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		conn, response, err := websocket.Dial(ctx, strings.Replace(f.server.URL, "http://", "ws://", 1)+requestPath, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + f.handler.token}}})
		cancel()
		if conn != nil {
			_ = conn.CloseNow()
		}
		if err == nil || response == nil || response.StatusCode < 400 {
			t.Fatalf("bad browser route accepted: %s", requestPath)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := f.application.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	read, stop := context.WithTimeout(context.Background(), time.Second)
	for {
		if _, _, err := browser.Read(read); err != nil {
			if read.Err() != nil {
				stop()
				t.Fatalf("shutdown retained a websocket until its caller deadline: %v", err)
			}
			break
		}
	}
	stop()
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	conn, response, err := websocket.Dial(ctx2, strings.Replace(f.server.URL, "http://", "ws://", 1)+path, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + f.handler.token}}})
	if conn != nil {
		_ = conn.CloseNow()
	}
	if err == nil || response == nil || response.StatusCode != http.StatusTooManyRequests {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("shutdown accepted a new channel: status=%d,error=%v", status, err)
	}
}
