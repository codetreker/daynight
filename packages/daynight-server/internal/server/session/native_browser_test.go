package session_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestSessionRoutesBrowserRespondsToPingAndContinuesReceivingEvents(t *testing.T) {
	f := sessionHTTPSetupWithApplication(t, newSessionPingApplication)
	pingSeen := make(chan struct{})
	var firstPing sync.Once
	sourceEpoch := uuid.NewString()
	controller, snapshot := f.controller(t, sourceEpoch)
	path := f.base + "/" + snapshot.SessionID + "/channel"
	browser := sessionDialOptions(t, f.server.URL, path, f.handler.token, f.backend.PlanHeader("native.browser"), websocket.DialOptions{
		OnPingReceived: func(context.Context, []byte) bool {
			firstPing.Do(func() { close(pingSeen) })
			return true
		},
	})
	sessionWSKind(t, browser, "snapshot")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	type readResult struct {
		data []byte
		err  error
	}
	result := make(chan readResult, 1)
	go func() {
		// Read handles ping control frames and sends pong while waiting for the
		// next application event on this same connection.
		_, data, err := browser.Read(ctx)
		result <- readResult{data: data, err: err}
	}()
	select {
	case early := <-result:
		t.Fatalf("idle browser closed or received unexpected data before ping: %s, %v", early.data, early.err)
	case <-pingSeen:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	entryID := uuid.NewString()
	f.ControllerWrite(t, controller, sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, SourceEpoch: sourceEpoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{
		{SourceSeq: "1", Kind: "timeline_upsert", Payload: json.RawMessage(jsonBody(t, map[string]any{"entryId": entryID, "revision": "1", "kind": "reasoning", "text": "Output after the browser answered the server ping"}))},
	}})
	sessionWSKind(t, controller, "events_ack")
	f.SelectNativeState(t, sourceEpoch, 1, nil)
	select {
	case received := <-result:
		if received.err != nil {
			t.Fatalf("browser could not receive after ping: %v", received.err)
		}
		var frame map[string]json.RawMessage
		if err := json.Unmarshal(received.data, &frame); err != nil || string(frame["type"]) != `"event"` {
			t.Fatalf("expected an application event after ping: %s, %v", received.data, err)
		}
		event, err := sp.DecodeEvent(frame["event"])
		if err != nil || event.Kind != "timeline_upsert" || event.HistoryEpoch != snapshot.HistoryEpoch {
			t.Fatalf("invalid event after ping: %+v, %v", event, err)
		}
		entry, err := sp.DecodeTimeline(event.Payload)
		if err != nil || entry.EntryID != entryID {
			t.Fatalf("wrong entry after ping: %+v, %v", entry, err)
		}
	case <-ctx.Done():
		t.Fatal("browser did not receive an event after ping: ", ctx.Err())
	}
}

func TestSessionRoutesBrowserHistoryResetClosesOldCursorAndRecovers(t *testing.T) {
	f := sessionHTTPSetup(t)
	sourceEpoch := uuid.NewString()
	controller, snapshot := f.controller(t, sourceEpoch)
	path := f.base + "/" + snapshot.SessionID
	browser := sessionDial(t, f.server.URL, path+"/channel", f.handler.token, f.backend.PlanHeader("native.browser"))
	first := sessionWSKind(t, browser, "snapshot")
	var oldCursor string
	if err := json.Unmarshal(first["cursor"], &oldCursor); err != nil || oldCursor == "" {
		t.Fatalf("initial cursor: %s, %v", first["cursor"], err)
	}
	// A disconnected browser may resume after the bounded live event ring has
	// evicted its cursor. History stays local and retains its identity.
	_ = browser.CloseNow()
	historyEpoch := snapshot.HistoryEpoch
	writeEntry := func(seq string) string {
		entryID := uuid.NewString()
		f.ControllerWrite(t, controller, sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, SourceEpoch: sourceEpoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{
			{SourceSeq: seq, Kind: "timeline_upsert", Payload: json.RawMessage(jsonBody(t, map[string]any{"entryId": entryID, "revision": "1", "kind": "reasoning", "text": strings.Repeat("x", 100*1024)}))},
		}})
		sessionWSKind(t, controller, "events_ack")
		sequence, err := strconv.ParseInt(seq, 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		f.SelectNativeState(t, sourceEpoch, sequence, nil)
		return entryID
	}
	for seq := 1; seq <= 24; seq++ {
		writeEntry(strconv.Itoa(seq))
	}
	assertResetAndClosed := func(conn *websocket.Conn) {
		t.Helper()
		frame := sessionWSRead(t, conn)
		if string(frame["type"]) != `"reset_required"` || string(frame["protocol"]) != `"`+sp.Protocol+`"` {
			t.Fatalf("old cursor received history instead of reset: %s", jsonBody(t, frame))
		}
		var reason string
		if json.Unmarshal(frame["reason"], &reason) != nil || reason == "" {
			t.Fatal("history reset omitted its reason")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, data, err := conn.Read(ctx)
		if err == nil || ctx.Err() != nil {
			t.Fatalf("reset must close without further cursor traffic: frame=%s error=%v context=%v", data, err, ctx.Err())
		}
	}
	stale := sessionDial(t, f.server.URL, path+"/channel?after="+oldCursor, f.handler.token, f.backend.PlanHeader("native.browser"))
	assertResetAndClosed(stale)

	recovered := sessionDial(t, f.server.URL, path+"/channel", f.handler.token, f.backend.PlanHeader("native.browser"))
	recovered.SetReadLimit(sp.MaxFrameBytes)
	frame := sessionWSKind(t, recovered, "snapshot")
	current, err := sp.DecodeSnapshot(frame["snapshot"])
	if err != nil || current.HistoryEpoch != historyEpoch {
		t.Fatalf("replacement snapshot: %+v, %v", current, err)
	}
	var freshCursor string
	if err := json.Unmarshal(frame["cursor"], &freshCursor); err != nil || freshCursor == "" || freshCursor == oldCursor {
		t.Fatalf("replacement cursor: %s, %v", frame["cursor"], err)
	}
	entryID := writeEntry("25")
	frame = sessionWSKind(t, recovered, "event")
	event, err := sp.DecodeEvent(frame["event"])
	if err != nil || event.HistoryEpoch != historyEpoch || event.Kind != "timeline_upsert" {
		t.Fatalf("replacement event: %+v, %v", event, err)
	}
	entry, err := sp.DecodeTimeline(event.Payload)
	if err != nil || entry.EntryID != entryID {
		t.Fatalf("replacement timeline entry: %+v, %v", entry, err)
	}
}

func TestSessionRoutesCookieOriginResetAndShutdown(t *testing.T) {
	f := sessionHTTPSetup(t)
	path := f.base + "/" + f.snapshot.SessionID + "/channel"
	principal := model.Principal{Kind: model.SessionCredential, UserID: f.handler.principal.UserID, CredentialID: uuid.NewString()}
	secret := f.authentication.Credential(principal)
	f.SetInput(func(input *nativeRouteInput) { input.Credentials[principal.CredentialID] = principal })
	cookie := "__Host-daynight_session=" + secret
	f.backend.Declare("browser.origin-admission", map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "SessionBotID": 1, "LockSession": 1}, func() any { return f.InputSnapshot() }, false)
	f.backend.Require("browser.origin-admission", 0)
	for _, origin := range []string{"", "https://evil.example", "https://daynight.example.evil"} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		header := f.backend.PlanHeader("browser.origin-admission")
		header.Set("Cookie", cookie)
		if origin != "" {
			header.Set("Origin", origin)
		}
		queries := f.backend.Called("LockTask")
		conn, response, err := websocket.Dial(ctx, strings.Replace(f.server.URL, "http://", "ws://", 1)+path, &websocket.DialOptions{HTTPHeader: header})
		cancel()
		if conn != nil {
			_ = conn.CloseNow()
		}
		if err == nil || response == nil || response.StatusCode != 403 {
			t.Fatalf("cookie origin %q accepted: %v", origin, err)
		}
		if f.backend.Called("LockTask") != queries {
			t.Fatal("cookie Origin refusal reached Session data access")
		}
	}
	header := f.backend.PlanHeader("native.browser")
	header.Set("Cookie", cookie)
	header.Set("Origin", "https://daynight.example")
	browser := sessionDial(t, f.server.URL, path, "", header)
	sessionWSKind(t, browser, "snapshot")
	reset := sessionDial(t, f.server.URL, path+"?after=invalid", f.handler.token, f.backend.PlanHeader("native.browser"))
	sessionWSKind(t, reset, "reset_required")
	missingID := uuid.NewString()
	f.backend.Declare("browser.missing", map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "SessionBotID": 1}, func() any {
		input := f.InputSnapshot()
		input.SessionID, input.SessionError = missingID, model.ErrNotFound
		return input
	}, false)
	for index, requestPath := range []string{path + "?unknown=1", f.base + "/" + missingID + "/channel"} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		header := make(http.Header)
		if index == 1 {
			header = f.backend.PlanHeader("browser.missing")
		}
		header.Set("Authorization", "Bearer "+f.handler.token)
		conn, response, err := websocket.Dial(ctx, strings.Replace(f.server.URL, "http://", "ws://", 1)+requestPath, &websocket.DialOptions{HTTPHeader: header})
		cancel()
		if conn != nil {
			_ = conn.CloseNow()
		}
		if err == nil || response == nil || response.StatusCode < 400 {
			t.Fatalf("bad browser route accepted: %s", requestPath)
		}
	}
	controller, _ := f.controller(t, uuid.NewString())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := f.application.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	for _, conn := range []*websocket.Conn{browser, controller} {
		read, cancel := context.WithTimeout(context.Background(), time.Second)
		for {
			if _, _, err := conn.Read(read); err != nil {
				if read.Err() != nil {
					cancel()
					t.Fatalf("shutdown retained a websocket until its caller deadline: %v", err)
				}
				break
			}
		}
		cancel()
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	conn, response, err := websocket.Dial(ctx2, strings.Replace(f.server.URL, "http://", "ws://", 1)+path, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + f.handler.token}}})
	if conn != nil {
		_ = conn.CloseNow()
	}
	if err == nil || response == nil || response.StatusCode != 429 {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("shutdown accepted a new channel: status=%d error=%v", status, err)
	}
}
