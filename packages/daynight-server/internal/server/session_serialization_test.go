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

func TestSessionNativeHTMLCommandReachesControllerAndDoesNotStarveFollowingOffer(t *testing.T) {
	f := sessionHTTPSetup(t)
	controller, snapshot := f.controller(t, uuid.NewString())
	controller.SetReadLimit(sp.MaxFrameBytes)
	native := "offer-session"
	state := sp.State{NativeSessionID: &native, InitialInputState: "provider_accepted", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true, Cancel: true, Respond: true}}
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}})
	sessionWSKind(t, controller, "sync_ack")
	path := f.base + "/" + snapshot.SessionID
	command := func(text string) sp.Command {
		payload, err := sp.MarshalWire(sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: text}}})
		if err != nil {
			t.Fatal(err)
		}
		return sp.Command{Fence: snapshot.Fence, Protocol: sp.Protocol, RequestID: "offer-wire", OperationID: uuid.NewString(), Kind: "send_message", Payload: payload}
	}
	commands := []sp.Command{command(strings.Repeat("<", 400000)), command("following operation")}
	for _, c := range commands {
		response := projectRequest(f.handler, http.MethodPost, path+"/commands", string(sessionNativeJSON(t, c)))
		if response.Code != http.StatusAccepted {
			t.Fatalf("command submission status=%d", response.Code)
		}
	}
	for _, expected := range commands {
		frame := sessionWSKind(t, controller, "operation_offer")
		actual, err := sp.DecodeCommand(frame["command"])
		if err != nil || actual.OperationID != expected.OperationID || string(actual.Payload) != string(expected.Payload) {
			t.Fatalf("controller did not receive original offered intent: %v", err)
		}
		if len(frame["command"]) > 500000 {
			t.Fatal("controller command expanded during transport")
		}
	}
	tooLarge := command(strings.Repeat("x", sp.MaxFrameBytes))
	refused := projectRequest(f.handler, http.MethodPost, path+"/commands", string(sessionNativeJSON(t, tooLarge)))
	if refused.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized HTTP command status=%d", refused.Code)
	}
	following := command("after size refusal")
	accepted := projectRequest(f.handler, http.MethodPost, path+"/commands", string(sessionNativeJSON(t, following)))
	if accepted.Code != http.StatusAccepted {
		t.Fatalf("following command submission status=%d", accepted.Code)
	}
	frame := sessionWSKind(t, controller, "operation_offer")
	actual, err := sp.DecodeCommand(frame["command"])
	if err != nil || actual.OperationID != following.OperationID {
		t.Fatal("refused request blocked following offer", err)
	}
}
