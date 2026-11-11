package session_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestControllerChannelRejectsInvalidGrantsBeforeUpgrade(t *testing.T) {
	for _, kind := range []string{"unknown", "expired", "consumed", "revoked"} {
		t.Run(kind, func(t *testing.T) {
			f := realSessionSetup(t)
			token := f.grant.Token
			switch kind {
			case "unknown":
				token = "dncontroller_invalid"
			case "expired":
				expired := time.Now().Add(-time.Second)
				f.record.GrantExpiry = &expired
			case "consumed":
				f.record.Consumed = true
			case "revoked":
				f.credentialRevoked = true
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			conn, response, err := websocket.Dial(ctx, strings.Replace(f.server.URL, "http://", "ws://", 1)+"/api/v1/controller-channel", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + token}}})
			if conn != nil {
				_ = conn.CloseNow()
			}
			if err == nil || response == nil || (response.StatusCode != http.StatusUnauthorized && response.StatusCode != http.StatusForbidden) {
				t.Fatalf("invalid grant upgraded: response=%v error=%v", response, err)
			}
			if count := f.application.routes.ActiveConnections(); count != 0 {
				t.Fatal("invalid grant occupied channel capacity", count)
			}
		})
	}
}

func TestControllerChannelStaleOfferRejectsOnlyOperation(t *testing.T) {
	f := realSessionSetup(t)
	epoch := uuid.NewString()
	conn, snapshot := f.controller(t, epoch)
	native := "native-session"
	state := sp.State{NativeSessionID: &native, InitialInputState: "provider_accepted", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	publish := func(seq string) {
		sessionWSWrite(t, conn, sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: seq, Kind: "state", Payload: json.RawMessage(jsonBody(t, state))}}})
		sessionWSKind(t, conn, "events_ack")
		f.supplyState(state)
		source, _ := strconv.ParseInt(seq, 10, 64)
		f.supplySource(source)
	}
	publish("1")
	submit := func() sp.Command {
		command := sp.Command{Protocol: sp.Protocol, RequestID: "stale-offer", Fence: snapshot.Fence, OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"bounded test input"}],"expectedTurnId":null}`)}
		f.expectCommand(t, command)
		receipt := decodeResponse[struct {
			Operation sp.Operation `json:"operation"`
		}](t, projectRequest(f.handler, http.MethodPost, f.base+"/"+snapshot.SessionID+"/commands", jsonBody(t, command)), http.StatusAccepted).Operation
		f.suppliedOperation(t, command, receipt)
		f.selectOffers(t, command.OperationID)
		sessionWSKind(t, conn, "operation_offer")
		f.suppliedOffer(t, command.OperationID, snapshot.ConnectionEpoch)
		return command
	}
	command := submit()
	state.Activity = "unknown"
	publish("2")
	sessionWSWrite(t, conn, sp.ControllerMessage{Type: "operation_begin", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, OperationID: command.OperationID})
	frame := sessionWSKind(t, conn, "receipt_ack")
	var receipt sp.Operation
	if err := json.Unmarshal(frame["operation"], &receipt); err != nil || receipt.State != "rejected" || receipt.OperationID != command.OperationID {
		t.Fatal(receipt, err)
	}
	f.supplyReceipt(t, receipt)
	sessionWSWrite(t, conn, sp.ControllerMessage{Type: "heartbeat", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence})
	sessionWSKind(t, conn, "heartbeat_ack")
	state.Activity = "idle"
	publish("3")
	command = submit()
	sessionWSWrite(t, conn, sp.ControllerMessage{Type: "operation_begin", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, OperationID: command.OperationID})
	sessionWSKind(t, conn, "operation_authorized")
}

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
	f := realSessionSetup(t)
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
		parsed, _ := strconv.ParseInt(seq, 10, 64)
		f.supplySource(parsed)
	}
	send("1")
	frame := sessionWSKind(t, browser, "event")
	if len(frame["event"]) > 500000 || !bytes.Contains(frame["event"], []byte(strings.Repeat("<", 100))) {
		t.Fatalf("wire event expanded: %d", len(frame["event"]))
	}
	online := &resourceTestHandler{Handler: f.application, token: f.handler.token, principal: f.handler.principal}
	done := make(chan *httptest.ResponseRecorder, 1)
	requestContext, cancelRequest := context.WithCancel(t.Context())
	finished := make(chan struct{})
	t.Cleanup(func() {
		cancelRequest()
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			t.Error("HTTP history request did not drain")
		}
	})
	go func() {
		defer close(finished)
		request := httptest.NewRequestWithContext(requestContext, http.MethodGet, path+"/timeline?direction=tail&limit=10", nil)
		authorizeResourceRequest(online, request)
		request.Header.Set("Content-Type", "application/json; charset=UTF-8")
		request.Header.Set("X-Request-ID", "project-test")
		response := httptest.NewRecorder()
		online.ServeHTTP(response, request)
		done <- response
	}()
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
	var page *httptest.ResponseRecorder
	select {
	case page = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("HTTP history request did not complete")
	}
	if page.Code != http.StatusOK || page.Body.Len() > 500000 || !bytes.Contains(page.Body.Bytes(), []byte(strings.Repeat("<", 100))) {
		t.Fatalf("HTTP history status=%d bytes=%d", page.Code, page.Body.Len())
	}
	controller.CloseNow()
	f.grant = f.mint(t, "reconnect")
	controller, snapshot = f.controller(t, epoch)
	send("2")
}

func TestSessionNativeHTMLCommandReachesControllerAndDoesNotStarveFollowingOffer(t *testing.T) {
	f := realSessionSetup(t)
	controller, snapshot := f.controller(t, uuid.NewString())
	controller.SetReadLimit(sp.MaxFrameBytes)
	native := "offer-session"
	state := sp.State{NativeSessionID: &native, InitialInputState: "provider_accepted", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true, Cancel: true, Respond: true}}
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}})
	sessionWSKind(t, controller, "sync_ack")
	f.supplyState(state)
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
		f.expectCommand(t, c)
		response := projectRequest(f.handler, http.MethodPost, path+"/commands", string(sessionNativeJSON(t, c)))
		if response.Code != http.StatusAccepted {
			t.Fatalf("command submission status=%d", response.Code)
		}
		receipt := decodeResponse[struct {
			Operation sp.Operation `json:"operation"`
		}](t, response, http.StatusAccepted).Operation
		f.suppliedOperation(t, c, receipt)
	}
	f.selectOffers(t, commands[0].OperationID, commands[1].OperationID)
	for _, expected := range commands {
		frame := sessionWSKind(t, controller, "operation_offer")
		actual, err := sp.DecodeCommand(frame["command"])
		if err != nil || actual.OperationID != expected.OperationID || string(actual.Payload) != string(expected.Payload) {
			t.Fatalf("controller did not receive original offered intent: %v", err)
		}
		if len(frame["command"]) > 500000 {
			t.Fatal("controller command expanded during transport")
		}
		f.suppliedOffer(t, expected.OperationID, snapshot.ConnectionEpoch)
	}
	tooLarge := command(strings.Repeat("x", sp.MaxFrameBytes))
	refused := projectRequest(f.handler, http.MethodPost, path+"/commands", string(sessionNativeJSON(t, tooLarge)))
	if refused.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized HTTP command status=%d", refused.Code)
	}
	following := command("after size refusal")
	f.expectCommand(t, following)
	accepted := projectRequest(f.handler, http.MethodPost, path+"/commands", string(sessionNativeJSON(t, following)))
	if accepted.Code != http.StatusAccepted {
		t.Fatalf("following command submission status=%d", accepted.Code)
	}
	followingReceipt := decodeResponse[struct {
		Operation sp.Operation `json:"operation"`
	}](t, accepted, http.StatusAccepted).Operation
	f.suppliedOperation(t, following, followingReceipt)
	f.selectOffers(t, following.OperationID)
	frame := sessionWSKind(t, controller, "operation_offer")
	actual, err := sp.DecodeCommand(frame["command"])
	if err != nil || actual.OperationID != following.OperationID {
		t.Fatal("refused request blocked following offer", err)
	}
	f.suppliedOffer(t, following.OperationID, snapshot.ConnectionEpoch)
}
func startupCurrent(t *testing.T, f *realSessionFixture, version bool) map[string]any {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, f.base+"/current", nil)
	authorizeResourceRequest(f.handler, r)
	if version {
		r.Header.Set("X-Daynight-Startup-Version", "1")
	}
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	return decodeResponse[map[string]any](t, w, http.StatusOK)
}

func TestSessionCurrentStartupEvidenceNegotiationAndGeneration(t *testing.T) {
	f := realSessionSetup(t)
	current := startupCurrent(t, f, true)
	if value, exists := current["startupReport"]; !exists || value != nil {
		t.Fatal("missing evidence is not explicit null")
	}
	report := map[string]any{
		"schemaVersion": 1, "source": "worker", "sessionId": f.snapshot.SessionID, "claimId": f.snapshot.ClaimID,
		"executionGeneration": f.snapshot.ExecutionGeneration, "controllerInstanceId": f.registration.ControllerInstanceID,
		"revision": "1", "observedAt": "2026-11-05T00:00:00Z",
		"startup":  map[string]any{"state": "unknown", "reasonCode": "native_timeout"},
		"recovery": map[string]any{"state": "blocked", "reasonCode": "native_identity_missing"},
	}
	old, err := sp.DecodeStartupReport([]byte(jsonBody(t, report)))
	if err != nil {
		t.Fatal(err)
	}
	f.sessionTask.StartupReport = &old
	current = startupCurrent(t, f, true)
	var expected map[string]any
	if err := json.Unmarshal([]byte(jsonBody(t, report)), &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(current["startupReport"], expected) {
		t.Fatalf("current lost startup evidence: %#v", current)
	}
	legacy := startupCurrent(t, f, false)
	if _, exists := legacy["startupReport"]; exists || len(legacy) != 2 {
		t.Fatal("legacy current response changed shape")
	}

	previous, nextInstance := "1", uuid.NewString()
	grant := sp.Grant{Protocol: sp.Protocol, ClaimID: f.snapshot.ClaimID, ControllerID: f.registration.ControllerID, ControllerInstanceID: nextInstance, ExecutionGeneration: "2", Kind: "reconnect", PreviousGeneration: &previous, StopProof: &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: f.registration.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	f.mediaRecoveryRead = func(context.Context) ([]store.SessionResourceLease, error) {
		return []store.SessionResourceLease{}, nil
	}
	f.mintGrant(t, grant)
	f.mu.Lock()
	f.record.Snapshot.ExecutionGeneration = "2"
	f.record.Snapshot.Identity.ControllerInstanceID = nextInstance
	recoveryReads := f.calls["ListSessionMediaLeases"]
	f.mu.Unlock()
	if recoveryReads != 1 {
		t.Fatalf("generation grant recovery listings=%d, want 1", recoveryReads)
	}
	current = startupCurrent(t, f, true)
	if current["startupReport"] != nil {
		t.Fatal("new generation displays previous startup evidence")
	}
	report["executionGeneration"], report["controllerInstanceId"] = "2", nextInstance
	next, err := sp.DecodeStartupReport([]byte(jsonBody(t, report)))
	if err != nil {
		t.Fatal(err)
	}
	f.sessionTask.StartupReport = &next
	current = startupCurrent(t, f, true)
	if current["startupReport"] == nil {
		t.Fatal("current generation evidence not readable")
	}
}
