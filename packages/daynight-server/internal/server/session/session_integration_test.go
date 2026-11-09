package session_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestSessionRoutesContentRequiresItsOnlineController(t *testing.T) {
	f := sessionHTTPSetup(t)
	epoch := uuid.NewString()
	controller, snapshot := f.controller(t, epoch)
	online := &resourceTestHandler{Handler: f.application, token: f.handler.token, principal: f.handler.principal}
	path := f.base + "/" + snapshot.SessionID
	browser := sessionDial(t, f.server.URL, path+"/channel", f.handler.token, f.backend.PlanHeader("native.browser"))
	first := sessionWSKind(t, browser, "snapshot")
	var initialCursor string
	_ = json.Unmarshal(first["cursor"], &initialCursor)
	native := "native-session"
	entryID, resourceID := uuid.NewString(), uuid.NewString()
	content := []byte("local resource")
	digest := sha256.Sum256(content)
	hash := hex.EncodeToString(digest[:])
	media, size := "text/plain", strconv.Itoa(len(content))
	descriptor := sp.Resource{ResourceID: resourceID, Status: "available", Name: "output.txt", MediaType: &media, ByteLength: &size, SHA256: &hash}
	entry, err := sp.DecodeTimeline([]byte(jsonBody(t, map[string]any{"entryId": entryID, "entrySeq": "1", "revision": "1", "kind": "assistant_message", "content": []any{map[string]any{"type": "text", "text": "Local output"}, map[string]any{"type": "resource", "resourceId": resourceID, "label": "Output"}}})))
	if err != nil {
		t.Fatal(err)
	}
	state := sp.State{NativeSessionID: &native, InitialInputState: "provider_accepted", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true, Cancel: true, Respond: true}}
	events := sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: json.RawMessage(jsonBody(t, state))}, {SourceSeq: "2", Kind: "timeline_upsert", Payload: json.RawMessage(jsonBody(t, entry))}, {SourceSeq: "3", Kind: "resource", Payload: json.RawMessage(jsonBody(t, descriptor))}}}
	f.ControllerWrite(t, controller, events)
	sessionWSKind(t, controller, "events_ack")
	f.SelectNativeState(t, epoch, 3, &state)
	f.ControllerWrite(t, controller, events)
	sessionWSKind(t, controller, "events_ack")
	f.SelectNativeState(t, epoch, 3, &state)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- projectRequest(online, http.MethodGet, path+"/timeline?direction=tail&limit=10", "", "native.local-content")
	}()
	request := sessionWSKind(t, controller, "content_request")
	var requestedKind string
	if err := json.Unmarshal(request["kind"], &requestedKind); err != nil || requestedKind != "timeline" {
		t.Fatalf("timeline read requested the wrong content kind: %q, %v", requestedKind, err)
	}
	var requestID, historyEpoch string
	_ = json.Unmarshal(request["requestId"], &requestID)
	_ = json.Unmarshal(request["historyEpoch"], &historyEpoch)
	f.ControllerWrite(t, controller, sp.ControllerMessage{Type: "content_response", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, RequestID: requestID, SourceThrough: "3", ContentResult: &sp.ContentResult{Kind: "timeline", HistoryEpoch: historyEpoch, Items: []sp.TimelineEntry{entry}, Resources: []sp.Resource{descriptor}}})
	page := decodeResponse[struct {
		Items []json.RawMessage `json:"items"`
	}](t, <-done, http.StatusOK)
	if len(page.Items) != 1 {
		t.Fatal("local page missing")
	}
	go func() {
		done <- projectRequest(online, http.MethodGet, path+"/resources/"+resourceID+"/content", "", "native.local-content")
	}()
	request = sessionWSKind(t, controller, "content_request")
	_ = json.Unmarshal(request["requestId"], &requestID)
	f.ControllerWrite(t, controller, sp.ControllerMessage{Type: "content_response", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, RequestID: requestID, SourceThrough: "3", ContentResult: &sp.ContentResult{Kind: "resource", Resource: &descriptor, Offset: "0", Data: base64.StdEncoding.EncodeToString(content), EOF: true}})
	download := <-done
	if download.Code != http.StatusOK || download.Body.String() != string(content) || download.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("local resource %d %s", download.Code, download.Body)
	}
	otherApplication := newSessionHTTPApplication(t, f.backend, f.authentication, f.application.(*routeApplication).Files)
	t.Cleanup(func() {
		if err := otherApplication.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	})
	other := &resourceTestHandler{Handler: otherApplication, token: f.handler.token, principal: f.handler.principal}
	if response := projectRequest(other, http.MethodGet, path+"/timeline?direction=tail&limit=10", "", "native.browser-request"); response.Code != http.StatusServiceUnavailable {
		t.Fatalf("another instance exposed local history: %d", response.Code)
	}
	f.assertNoNativeContent(t, "Local output", "local resource")
	command := sp.Command{Fence: snapshot.Fence, Protocol: sp.Protocol, RequestID: "session-http", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"Continue"}],"expectedTurnId":null}`)}
	f.SetInput(func(input *nativeRouteInput) {
		input.OperationID = command.OperationID
		input.OperationError = model.ErrNotFound
	})
	accepted := decodeResponse[struct {
		Operation sp.Operation `json:"operation"`
		URL       string       `json:"operationUrl"`
	}](t, projectRequest(online, http.MethodPost, path+"/commands", jsonBody(t, command), "native.submit"), http.StatusAccepted)
	f.SelectNativeOperation(t, command, accepted.Operation)
	offer := sessionWSKind(t, controller, "operation_offer")
	var offered sp.Command
	if json.Unmarshal(offer["command"], &offered) != nil || offered.OperationID != command.OperationID {
		t.Fatal("wrong native intent")
	}
	f.SelectNativeReceipt(t, command.OperationID, "offered", numberNativeEpoch(snapshot.ConnectionEpoch))
	f.ControllerWrite(t, controller, sp.ControllerMessage{Type: "operation_begin", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, OperationID: command.OperationID})
	authorized := sessionWSKind(t, controller, "operation_authorized")
	var authorizedID string
	if err := json.Unmarshal(authorized["operationId"], &authorizedID); err != nil || authorizedID != offered.OperationID {
		t.Fatalf("authorized operation differs from offered intent: %q, %v", authorizedID, err)
	}
	f.SelectNativeReceipt(t, command.OperationID, "dispatching", numberNativeEpoch(snapshot.ConnectionEpoch))
	accepted.Operation.State = "confirmed"
	f.ControllerWrite(t, controller, sp.ControllerMessage{Type: "operation_receipt", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, Operation: &accepted.Operation})
	sessionWSKind(t, controller, "receipt_ack")
	f.SelectNativeReceipt(t, command.OperationID, "confirmed", numberNativeEpoch(snapshot.ConnectionEpoch))
	got := decodeResponse[struct {
		Operation sp.Operation `json:"operation"`
	}](t, projectRequest(other, http.MethodGet, accepted.URL, "", "native.operation"), http.StatusOK)
	if got.Operation.State != "confirmed" {
		t.Fatal("receipt ledger missing")
	}
	f.assertNoNativeContent(t, "Local output", "local resource", "Continue")
	reconnected := sessionDial(t, f.server.URL, path+"/channel?after="+initialCursor, f.handler.token, f.backend.PlanHeader("native.browser"))
	sessionWSKind(t, reconnected, "snapshot")
	frame := sessionWSKind(t, reconnected, "event")
	if _, err = sp.DecodeEvent(frame["event"]); err != nil {
		t.Fatal(err)
	}
	f.expectShutdownError = func(err error) bool { return shutdownFaultMatches(err, "unauthenticated") }
	f.SetInput(func(input *nativeRouteInput) {
		input.CredentialErrors[f.handler.principal.CredentialID] = model.ErrNotFound
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		if _, _, err = controller.Read(ctx); err != nil {
			break
		}
	}
	if ctx.Err() != nil {
		t.Fatal("revoked controller retained access")
	}
}

func TestSessionShutdownRetainsDisconnectFailure(t *testing.T) {
	f := sessionHTTPSetup(t)
	_, snapshot := f.controller(t, uuid.NewString())
	failure := errors.New("injected disconnect failure")
	f.inputMu.Lock()
	f.writes.DisconnectError = failure
	writesBefore := len(f.writes.Session)
	f.inputMu.Unlock()
	f.expectShutdownError = func(err error) bool { return shutdownDisconnectFailureMatches(err, failure) }
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for i := 0; i < 2; i++ {
		err := f.application.Shutdown(ctx)
		if !errors.Is(err, failure) {
			t.Fatalf("shutdown %d lost disconnect cause: %v", i, err)
		}
	}
	f.inputMu.Lock()
	attempts := slices.Clone(f.writes.DisconnectAttempts)
	writesAfter := len(f.writes.Session)
	f.inputMu.Unlock()
	if len(attempts) != 1 || attempts[0] != snapshot.SessionID || writesAfter != writesBefore {
		t.Fatalf("failed disconnect proposed a successful release or repeated shutdown work: attempts=%v sessionWrites=%d→%d", attempts, writesBefore, writesAfter)
	}
}
