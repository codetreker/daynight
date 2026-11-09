package session_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func independentRegistration(provider string) sp.TestRegistration {
	return sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: provider, InitialInput: "none"}
}

func testController(t *testing.T, f *testSessionRouteFixture, snapshot sp.Snapshot, registration sp.TestRegistration, scopes ...string) (*websocket.Conn, sp.Snapshot) {
	t.Helper()
	grant := f.grant(t, snapshot, registration.ControllerID, registration.ControllerInstanceID)
	epoch := uuid.NewString()
	f.prepareConnection(t, snapshot, epoch)
	plans := append([]string{"test-controller-auth", "test-controller-connect", "test-controller-read", "test-controller-idle", "test-controller-revoked"}, scopes...)
	controller := sessionDial(t, f.server.URL, "/api/v1/controller-channel", grant.Token, f.backend.PlanHeader(plans...))
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, SchemaVersion: 1, ProjectionVersion: 1, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, Provider: registration.Provider, SourceEpoch: epoch, LastAckedSourceSeq: "0"})
	f.admitConnection(t)
	welcome := sessionWSKind(t, controller, "welcome")
	connected, err := sp.DecodeSnapshot(welcome["session"])
	if err != nil {
		t.Fatal(err)
	}
	f.selectConnection(t, connected)
	f.expectControllerCleanup(t)
	return controller, connected
}

func TestTestSessionHTTPAndChannelRequireOwnerCredential(t *testing.T) {
	f := newTestSessionRouteFixture(t)
	registration := independentRegistration("claude")
	v := f.registration(t, registration)
	path := "/api/v1/test-sessions/" + v.SessionID
	if v.Identity.OwnerUserID != f.handler.principal.UserID || v.Identity.ProjectID != "" || v.TestExecutionID != registration.TestExecutionID {
		t.Fatal("wrong Test identity", v)
	}
	for _, route := range []string{"/api/v1/test-session-capabilities", path, path + "/timeline", path + "/operations/" + uuid.NewString(), path + "/resources/" + uuid.NewString() + "/content", path + "/channel"} {
		response := httptest.NewRecorder()
		f.handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, route, nil))
		if response.Code != http.StatusUnauthorized {
			t.Fatal("anonymous route", route, response.Code)
		}
	}
	decodeResponse[map[string]any](t, f.request(http.MethodGet, "/api/v1/test-session-capabilities", ""), http.StatusOK)
	decodeResponse[struct {
		Session sp.Snapshot `json:"session"`
	}](t, f.request(http.MethodGet, path, "", "test-read"), http.StatusOK)
	assertProjectError(t, f.request(http.MethodGet, path+"/timeline", "", "test-offline-content"), http.StatusServiceUnavailable, "controller_offline")
	taskPath := "/api/v1/projects/" + f.project + "/tasks/" + f.task + "/sessions/" + v.SessionID + "/timeline"
	assertProjectError(t, f.request(http.MethodGet, taskPath, "", "test-task-route"), http.StatusConflict, "session_conflict")
	f.mu.Lock()
	original := f.facts.record
	nativeID := f.native.Snapshot.SessionID
	f.facts.record = routeCopy(f.native)
	f.mu.Unlock()
	assertProjectError(t, f.request(http.MethodGet, "/api/v1/test-sessions/"+nativeID, "", "test-wrong-scope"), http.StatusConflict, "session_conflict")
	f.mu.Lock()
	f.facts.record = original
	f.mu.Unlock()
	controller, v := testController(t, f, v, registration, "test-controller-sync", "test-controller-events", "test-controller-offer")
	browser := sessionDial(t, f.server.URL, path+"/channel", f.handler.token, f.backend.PlanHeader("test-browser", "test-browser-revoked"))
	sessionWSKind(t, browser, "snapshot")
	state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}})
	sessionWSKind(t, controller, "sync_ack")
	f.selectSession(t, true)
	f.mu.Lock()
	f.facts = f.connected
	epoch := *f.connected.record.SourceEpoch
	f.mu.Unlock()
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: raw}}})
	sessionWSKind(t, controller, "events_ack")
	f.selectSession(t, true)
	f.mu.Lock()
	f.facts = f.connected
	f.mu.Unlock()
	command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "first", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"hello"}],"expectedTurnId":null}`)}
	response := f.request(http.MethodPost, path+"/commands", jsonBody(t, command), "test-command")
	if response.Code != http.StatusAccepted || response.Header().Get("Location") != path+"/operations/"+command.OperationID {
		t.Fatal("command Location", response.Code, response.Body.String())
	}
	f.selectSession(t, true)
	f.prepareOffer(t)
	f.mu.Lock()
	operation := f.writes.operation
	if operation == nil || operation.OperationID != command.OperationID || operation.Command.Kind != "send_message" || operation.Actor != f.handler.principal {
		f.mu.Unlock()
		t.Fatal("command did not propose its original operation/actor")
	}
	f.connected.operation, f.connected.operationError, f.connected.accepted = routeCopy(*operation), nil, []string{command.OperationID}
	f.connected.operation.Deadline = time.Now().Add(30 * time.Second)
	f.facts = f.connected
	f.writes.operation = nil
	f.mu.Unlock()
	f.admitOffer(t)
	offer := sessionWSKind(t, controller, "operation_offer")
	if string(offer["testExecutionId"]) != "\""+v.TestExecutionID+"\"" || offer["claimId"] != nil {
		t.Fatal("offer scope", offer)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	controllerClosed, browserClosed := watchDeletedChannel(ctx, controller), watchDeletedChannel(ctx, browser)
	if err := controller.Ping(ctx); err != nil {
		t.Fatal("controller unavailable before credential revocation", err)
	}
	if err := browser.Ping(ctx); err != nil {
		t.Fatal("browser unavailable before credential revocation", err)
	}
	f.revoke(t)
	requireDeletedChannelClosed(t, ctx, controllerClosed)
	requireDeletedChannelClosed(t, ctx, browserClosed)
	f.requireRevokedControllerCleanup(t)
	assertProjectError(t, f.request(http.MethodGet, path, ""), http.StatusUnauthorized, "unauthenticated")
}

func TestTestSessionHTTPStopRequiresValidProofOwnerAndScope(t *testing.T) {
	f := newTestSessionRouteFixture(t)
	registration := independentRegistration("codex")
	v := f.registration(t, registration)
	path := "/api/v1/test-sessions/" + v.SessionID
	proof := sp.TestStop{Protocol: sp.Protocol, Fence: v.Fence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, StopProof: sp.StopProof{Kind: "never_started", RecordID: uuid.NewString(), PreviousControllerInstanceID: registration.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	for _, input := range []struct {
		path, body string
		status     int
	}{
		{path + "/stop?unknown=1", jsonBody(t, proof), http.StatusBadRequest},
		{path + "/stop", "{}", http.StatusBadRequest},
		{path + "/stop", `{"protocol":"daynight.session.v1"`, http.StatusBadRequest},
		{"/api/v1/test-sessions?unknown=1", jsonBody(t, registration), http.StatusBadRequest},
		{"/api/v1/test-sessions", "{}", http.StatusBadRequest},
	} {
		assertProjectError(t, f.request(http.MethodPost, input.path, input.body), input.status, "invalid_input")
	}
	f.mu.Lock()
	testRecord := f.facts.record
	f.facts.record = routeCopy(f.native)
	f.mu.Unlock()
	assertProjectError(t, f.request(http.MethodPost, "/api/v1/test-sessions/"+f.native.Snapshot.SessionID+"/stop", jsonBody(t, proof), "test-wrong-scope"), http.StatusConflict, "session_conflict")
	f.mu.Lock()
	f.facts.record = testRecord
	f.mu.Unlock()
	for _, route := range []string{path + "?unknown=1", "/api/v1/test-session-capabilities?unknown=1"} {
		assertProjectError(t, f.request(http.MethodGet, route, ""), http.StatusBadRequest, "invalid_input")
	}
	capability := decodeResponse[map[string]any](t, f.request(http.MethodGet, "/api/v1/test-session-capabilities", ""), http.StatusOK)
	if len(capability) != 4 || capability["protocol"] != sp.Protocol {
		t.Fatal("Test capability contract", capability)
	}
	for _, route := range []string{path, path + "/stop", "/api/v1/test-session-capabilities"} {
		if response := f.request(http.MethodDelete, route, ""); response.Code != http.StatusMethodNotAllowed {
			t.Fatal("method admission", route, response.Code)
		}
	}
	anonymous := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, path+"/stop", strings.NewReader(jsonBody(t, proof)))
	request.Header.Set("X-Request-ID", "project-test")
	f.handler.ServeHTTP(anonymous, request)
	assertProjectError(t, anonymous, http.StatusUnauthorized, "unauthenticated")
	outsiderPrincipal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	outsider := &resourceTestHandler{Handler: f.handler.Handler, token: f.auth.Credential(outsiderPrincipal), principal: outsiderPrincipal}
	f.mu.Lock()
	f.facts.actor = outsiderPrincipal
	f.mu.Unlock()
	assertProjectError(t, f.requestAs(outsider, http.MethodPost, path+"/stop", jsonBody(t, proof), "test-foreign-owner"), http.StatusForbidden, "forbidden")
	assertProjectError(t, f.requestAs(outsider, http.MethodGet, path, "", "test-foreign-owner"), http.StatusForbidden, "forbidden")
	f.mu.Lock()
	f.facts.actor = f.handler.principal
	f.mu.Unlock()
	archived := decodeResponse[struct {
		Session sp.Snapshot `json:"session"`
	}](t, f.request(http.MethodPost, path+"/stop", jsonBody(t, proof), "test-stop"), http.StatusOK).Session
	if archived.Lifecycle != "archived" || archived.Operations.CanSend {
		t.Fatal("stop did not archive", archived)
	}
	f.selectStop(t, archived)
	decodeResponse[struct {
		Session sp.Snapshot `json:"session"`
	}](t, f.request(http.MethodPost, path+"/stop", jsonBody(t, proof), "test-stop-repeat"), http.StatusOK)
	f.requireNoControllerCleanup(t)
	registration.RegistrationID, registration.TestExecutionID = uuid.NewString(), uuid.NewString()
	v = f.registration(t, registration)
	path = "/api/v1/test-sessions/" + v.SessionID
	controller, v := testController(t, f, v, registration)
	proof.Fence = v.Fence
	assertProjectError(t, f.request(http.MethodPost, path+"/stop", jsonBody(t, proof), "test-stop-conflict"), http.StatusConflict, "session_conflict")
	previousSaves := f.sessionSaveCount()
	_ = controller.CloseNow()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	if err := f.routes.Shutdown(ctx); err != nil {
		cancel()
		t.Fatal("controller disconnect did not drain", err)
	}
	cancel()
	f.requireControllerCleanup(t, previousSaves)
	proof.StopProof.Kind = ""
	archived = decodeResponse[struct {
		Session sp.Snapshot `json:"session"`
	}](t, f.request(http.MethodPost, path+"/stop", jsonBody(t, proof), "test-stop"), http.StatusOK).Session
	f.selectStop(t, archived)
	if archived.Lifecycle != "archived" {
		t.Fatal("normal stop proof not recorded")
	}
}
