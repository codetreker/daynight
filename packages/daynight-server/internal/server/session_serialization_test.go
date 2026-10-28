package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
)

// The controller uses JSON.stringify, which does not HTML-escape tool text.
func sessionNativeJSON(t *testing.T, v any) []byte {
	t.Helper()
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		t.Fatal(err)
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}
func sessionNativeWrite(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	raw := sessionNativeJSON(t, v)
	if len(raw) > sp.MaxFrameBytes {
		t.Fatalf("native input too large: %d", len(raw))
	}
	if err := c.Write(ctx, websocket.MessageText, raw); err != nil {
		t.Fatal(err)
	}
}
func TestSessionNativeHTMLTextSurvivesRelayAndReconnect(t *testing.T) {
	f := sessionHTTPSetup(t)
	epoch := uuid.NewString()
	controller, snapshot := f.controller(t, epoch)
	path := f.base + "/" + snapshot.SessionID
	browser := sessionDial(t, f.server.URL, path+"/channel", f.handler.token, nil)
	browser.SetReadLimit(sp.MaxFrameBytes)
	sessionWSKind(t, browser, "snapshot")
	entry := map[string]any{"entryId": uuid.NewString(), "entrySeq": "1", "revision": "1", "kind": "tool_call", "callId": "tool-1", "name": "shell", "input": strings.Repeat("<", 200000), "output": []any{map[string]any{"type": "text", "text": strings.Repeat(">", 200000)}}, "status": "completed", "truncated": false}
	envelope := func(kind string) map[string]any {
		return map[string]any{"type": kind, "protocol": sp.Protocol, "sessionId": snapshot.SessionID, "claimId": snapshot.ClaimID, "executionGeneration": snapshot.ExecutionGeneration, "connectionEpoch": snapshot.ConnectionEpoch}
	}
	send := func(seq string) {
		message := envelope("events")
		message["batchId"] = uuid.NewString()
		message["sourceEpoch"] = epoch
		message["events"] = []any{map[string]any{"sourceSeq": seq, "kind": "timeline_upsert", "payload": entry}}
		sessionNativeWrite(t, controller, message)
		ack := sessionWSKind(t, controller, "events_ack")
		if string(ack["lastAckedSourceSeq"]) != "\""+seq+"\"" {
			t.Fatalf("source did not advance: %s", ack["lastAckedSourceSeq"])
		}
	}
	send("1")
	frame := sessionWSKind(t, browser, "event")
	if len(frame["event"]) > 500000 || !bytes.Contains(frame["event"], []byte(strings.Repeat("<", 100))) {
		t.Fatalf("wire event expanded: %d", len(frame["event"]))
	}
	online := &resourceTestHandler{Handler: f.application, token: f.handler.token, principal: f.handler.principal}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- projectRequest(online, http.MethodGet, path+"/timeline?direction=tail&limit=10", "") }()
	request := sessionWSKind(t, controller, "content_request")
	var requestID, historyEpoch string
	_ = json.Unmarshal(request["requestId"], &requestID)
	_ = json.Unmarshal(request["historyEpoch"], &historyEpoch)
	response := envelope("content_response")
	response["requestId"] = requestID
	response["sourceThrough"] = "1"
	response["error"] = nil
	response["result"] = map[string]any{"kind": "timeline", "historyEpoch": historyEpoch, "items": []any{entry}, "resources": []any{}, "beforeCursor": nil, "afterCursor": nil, "hasMoreBefore": false, "hasMoreAfter": false}
	sessionNativeWrite(t, controller, response)
	page := <-done
	if page.Code != http.StatusOK || page.Body.Len() > 500000 || !bytes.Contains(page.Body.Bytes(), []byte(strings.Repeat("<", 100))) {
		t.Fatalf("HTTP history status=%d bytes=%d", page.Code, page.Body.Len())
	}
	controller.CloseNow()
	f.grant = f.mint(t, "reconnect")
	controller, snapshot = f.controller(t, epoch)
	send("2")
}

func TestSessionResultHandlesCancellationEncodingAndWriteFailure(t *testing.T) {
	routes := &sessionRoutes{logger: testLogger()}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/test-sessions", nil)
	ctx, cancel := context.WithCancel(request.Context())
	cancel()
	canceled := httptest.NewRecorder()
	routes.result(canceled, request.WithContext(ctx), http.StatusOK, map[string]string{"text": "unused"}, nil)
	if canceled.Body.Len() != 0 || len(canceled.Header()) != 0 {
		t.Fatal("canceled request wrote a response")
	}
	invalid := httptest.NewRecorder()
	routes.result(invalid, request, http.StatusOK, make(chan int), nil)
	if invalid.Code != http.StatusInternalServerError {
		t.Fatal("encoding failure did not become a response error")
	}
	routes.result(&failingResponseWriter{header: make(http.Header)}, request, http.StatusOK, map[string]string{"text": "<>&"}, nil)
}
