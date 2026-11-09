package session_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestSessionRoutesExposeOnlyCurrentClaim(t *testing.T) {
	f := sessionHTTPSetup(t)
	f.SetInput(func(input *nativeRouteInput) {
		input.Task.Worker = nil
		input.Task.Status = "todo"
	})
	f.backend.Declare("native.no-worker", map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1}, func() any { return f.InputSnapshot() }, false)
	response := decodeResponse[map[string]any](t, projectRequest(f.handler, http.MethodGet, f.base+"/current", "", "native.no-worker"), http.StatusOK)
	if response["status"] != "not_applicable" || response["claimId"] != nil {
		t.Fatalf("unexpected current session: %v", response)
	}
}

func TestSessionRoutesCapabilitiesRequireAuthentication(t *testing.T) {
	backend := newRouteBackend(t)
	authentication := newRouteAuthentication(t, "https://daynight.example")
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	handler := newResourceTestHandler(t, backend, authentication, principal, attachmentTestFiles(t), io.Discard)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := handler.application.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	response := decodeResponse[map[string]any](t, projectRequest(handler, http.MethodGet, "/api/v1/session-capabilities", ""), http.StatusOK)
	if response["protocol"] != sp.Protocol || response["schemaVersion"] != float64(1) || response["projectionVersion"] != float64(1) || len(response) != 5 || response["startupReportVersion"] != float64(1) {
		t.Fatalf("unexpected capabilities: %v", response)
	}
	providers, ok := response["providers"].([]any)
	if !ok || len(providers) != 3 || providers[0] != "codex" || providers[1] != "claude" || providers[2] != "copilot" {
		t.Fatalf("unexpected providers: %v", providers)
	}
	for _, method := range []string{http.MethodHead, http.MethodPost, http.MethodDelete} {
		response := projectRequest(handler, method, "/api/v1/session-capabilities", "")
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET" {
			t.Fatalf("capability method %s: %d", method, response.Code)
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/session-capabilities", nil)
	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, request)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatal("anonymous capability discovery accepted")
	}
	if response := projectRequest(handler, http.MethodGet, "/api/v1/session-capabilities?unknown=1", ""); response.Code != http.StatusBadRequest {
		t.Fatal("unknown capability query accepted")
	}
}

func TestSessionRoutesRejectInvalidHTTPInputs(t *testing.T) {
	f := sessionHTTPSetup(t)
	path := f.base + "/" + f.snapshot.SessionID
	offlineResource := path + "/resources/" + uuid.NewString() + "/content"
	for _, input := range []struct {
		method, path, body string
		status             int
	}{
		{http.MethodPost, f.base, `{}`, 400}, {http.MethodPost, f.base + "?unknown=1", `{}`, 400},
		{http.MethodPost, path + "/controller-grant", `{}`, 400}, {http.MethodPost, path + "/controller-grant?x=1", `{}`, 400},
		{http.MethodPost, path + "/commands", `{}`, 400}, {http.MethodPost, path + "/commands?x=1", `{}`, 400},
		{http.MethodGet, f.base + "/current?x=1", "", 400},
		{http.MethodGet, path + "/timeline?limit=201", "", 400}, {http.MethodGet, path + "/timeline?direction=before", "", 400}, {http.MethodGet, path + "/timeline?x=1", "", 400},
		{http.MethodGet, path + "/operations/" + uuid.NewString() + "?x=1", "", 400},
		{http.MethodGet, path + "/resources/" + uuid.NewString() + "/content?x=1", "", 400},
		{http.MethodGet, offlineResource, "", 503},
		{http.MethodGet, strings.Replace(f.base, "/projects/"+f.task.ProjectID, "/projects/invalid", 1) + "/current", "", 400},
		{http.MethodDelete, f.base, "", 405}, {http.MethodHead, f.base + "/current", "", 405},
	} {
		plans := []string{}
		if input.path == offlineResource {
			plans = []string{"native.browser-request"}
		}
		response := projectRequest(f.handler, input.method, input.path, input.body, plans...)
		if response.Code != input.status {
			t.Fatalf("%s %s: %d %s", input.method, input.path, response.Code, response.Body)
		}
	}
	for _, test := range []struct {
		body        io.Reader
		contentType string
		status      int
	}{
		{strings.NewReader("{}"), "text/plain", 400},
		{strings.NewReader(strings.Repeat("x", sp.MaxFrameBytes+1)), "application/json", 413},
		{&attachmentFailingBody{readErr: errors.New("broken body")}, "application/json", 400},
	} {
		request := httptest.NewRequest(http.MethodPost, f.base, test.body)
		request.Header.Set("Authorization", "Bearer "+f.handler.token)
		request.Header.Set("Content-Type", test.contentType)
		response := httptest.NewRecorder()
		f.handler.ServeHTTP(response, request)
		if response.Code != test.status {
			t.Fatalf("body rejection: %d %s", response.Code, response.Body)
		}
	}
	command := sp.Command{Fence: f.snapshot.Fence, Protocol: sp.Protocol, RequestID: "initial", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"Too soon"}],"expectedTurnId":null}`)}
	f.SetInput(func(input *nativeRouteInput) {
		input.OperationID = command.OperationID
		input.OperationError = model.ErrNotFound
	})
	response := projectRequest(f.handler, http.MethodPost, path+"/commands", jsonBody(t, command), "native.submit-offline")
	if response.Code != 503 {
		t.Fatalf("initial gate HTTP status: %d %s", response.Code, response.Body)
	}
	for _, test := range []struct {
		path, token, epoch string
		body               io.Reader
		status             int
	}{
		{"/api/v1/controller-resources/" + uuid.NewString(), "", "1", strings.NewReader(""), 401},
		{"/api/v1/controller-resources/" + uuid.NewString(), f.handler.token, "1", strings.NewReader(""), 401},
		{"/api/v1/controller-resources/invalid", f.grant.Token, "1", strings.NewReader(""), 400},
		{"/api/v1/controller-resources/" + uuid.NewString() + "?x=1", f.grant.Token, "1", strings.NewReader(""), 400},
		{"/api/v1/controller-resources/" + uuid.NewString(), f.grant.Token, "", strings.NewReader(""), 400},
		{"/api/v1/controller-resources/" + uuid.NewString(), f.grant.Token, "01", strings.NewReader(""), 400},
		{"/api/v1/controller-resources/" + uuid.NewString(), f.grant.Token, "1", strings.NewReader(strings.Repeat("x", sp.MaxResourceBytes+1)), 404},
		{"/api/v1/controller-resources/" + uuid.NewString(), f.grant.Token, "1", &attachmentFailingBody{readErr: errors.New("broken body")}, 404},
	} {
		request := httptest.NewRequest(http.MethodPut, test.path, test.body)
		if test.token != "" {
			request.Header.Set("Authorization", "Bearer "+test.token)
		}
		if test.epoch != "" {
			request.Header.Set("Daynight-Connection-Epoch", test.epoch)
		}
		response := httptest.NewRecorder()
		f.handler.ServeHTTP(response, request)
		if response.Code != test.status {
			t.Fatalf("upload rejection %s: %d %s", test.path, response.Code, response.Body)
		}
	}
	for _, code := range []string{"session_conflict", "operation_conflict", "source_gap", "reconcile_required", "reset_required", "resource_conflict"} {
		request := httptest.NewRequest(http.MethodGet, "/", nil)
		response := httptest.NewRecorder()
		httpx.WriteError(response, request, testLogger(), "session", "test", &model.Fault{Code: code, Message: "Conflict"})
		if response.Code != 409 {
			t.Fatalf("%s mapped to %d", code, response.Code)
		}
	}
}

func TestSessionRoutesControllerRejectsInvalidHandshakesAndFences(t *testing.T) {
	f := sessionHTTPSetup(t)
	f.backend.Declare("validation.authenticate", map[string]int{"SessionLocationByGrant": 1, "LockTask": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "ProjectAccess": 1}, func() any { return f.InputSnapshot() }, false)
	invalidGrantHash := sha256.Sum256([]byte("dncontroller_invalid"))
	f.backend.Declare("validation.invalid-grant", map[string]int{"SessionLocationByGrant": 1}, func() any {
		input := f.InputSnapshot()
		input.GrantHash = invalidGrantHash[:]
		input.GrantLocationError = model.ErrNotFound
		return input
	}, false)
	for _, input := range []struct {
		path, token, origin string
		status              int
	}{
		{"/api/v1/controller-channel", "", "", 401},
		{"/api/v1/controller-channel", f.handler.token, "", 401},
		{"/api/v1/controller-channel?token=forbidden", f.grant.Token, "", 400},
		{"/api/v1/controller-channel", f.grant.Token, "https://evil.example", 403},
	} {
		request := httptest.NewRequest(http.MethodGet, input.path, nil)
		if input.token != "" {
			request.Header.Set("Authorization", "Bearer "+input.token)
		}
		if input.origin != "" {
			request.Header.Set("Origin", input.origin)
		}
		response := httptest.NewRecorder()
		f.application.ServeHTTP(response, request)
		if response.Code != input.status {
			t.Fatalf("controller rejection: %d %s", response.Code, response.Body)
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/controller-channel", nil)
	request.Header.Set("Authorization", "Bearer "+f.grant.Token)
	request.Header.Set(routePlanHeader, "validation.authenticate")
	response := httptest.NewRecorder()
	f.application.ServeHTTP(response, request)
	if response.Code < 400 {
		t.Fatal("accepted missing websocket upgrade")
	}
	assertClosed := func(conn *websocket.Conn) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_, _, err := conn.Read(ctx)
		if err == nil || ctx.Err() != nil {
			t.Fatalf("invalid controller not closed promptly: %v", err)
		}
		waitNativeValidationDrain(t, f)
	}
	for _, kind := range []websocket.MessageType{websocket.MessageBinary, websocket.MessageText} {
		conn := sessionDial(t, f.server.URL, "/api/v1/controller-channel", f.grant.Token, f.backend.PlanHeader("validation.authenticate"))
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		err := conn.Write(ctx, kind, []byte(`{}`))
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		assertClosed(conn)
	}
	wrongFirst := sessionDial(t, f.server.URL, "/api/v1/controller-channel", f.grant.Token, f.backend.PlanHeader("validation.authenticate"))
	fence := f.snapshot.ControllerFence
	fence.ConnectionEpoch = "1"
	sessionWSWrite(t, wrongFirst, sp.ControllerMessage{Type: "heartbeat", Protocol: sp.Protocol, ControllerFence: fence})
	assertClosed(wrongFirst)
	invalidToken := httptest.NewRequest(http.MethodGet, "/api/v1/controller-channel", nil)
	invalidToken.Header.Set("Authorization", "Bearer dncontroller_invalid")
	invalidToken.Header.Set(routePlanHeader, "validation.invalid-grant")
	invalidResponse := httptest.NewRecorder()
	f.application.ServeHTTP(invalidResponse, invalidToken)
	if invalidResponse.Code != http.StatusForbidden {
		t.Fatal("invalid controller grant was not refused before upgrade", invalidResponse.Code)
	}
	epoch := uuid.NewString()
	controller, snapshot := f.controller(t, epoch)
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "2", Kind: "gap", Payload: json.RawMessage(`{"reason":"Skipped source sequence"}`)}}})
	sessionWSKind(t, controller, "error")
	assertClosed(controller)
	f.SetInput(func(input *nativeRouteInput) {
		input.Session.ConnectionExpiry = nil
		input.Session.LastSeen = nil
	})
	f.grant = f.mint(t, "reconnect")
	controller, snapshot = f.controller(t, epoch)
	stale := snapshot.ControllerFence
	stale.ConnectionEpoch = "999"
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "heartbeat", Protocol: sp.Protocol, ControllerFence: stale})
	sessionWSKind(t, controller, "error")
	assertClosed(controller)
	f.SetInput(func(input *nativeRouteInput) {
		input.Session.ConnectionExpiry = nil
		input.Session.LastSeen = nil
	})
	f.grant = f.mint(t, "reconnect")
	controller, snapshot = f.controller(t, epoch)
	f.ControllerWrite(t, controller, sp.ControllerMessage{Type: "heartbeat", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence})
	sessionWSKind(t, controller, "heartbeat_ack")
	f.SelectNativeState(t, epoch, f.InputSnapshot().Session.SourceSeq, nil)
	if err := f.application.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertClosed(controller)
	request = httptest.NewRequest(http.MethodGet, "/api/v1/controller-channel", nil)
	request.Header.Set("Authorization", "Bearer "+f.grant.Token)
	response = httptest.NewRecorder()
	f.application.ServeHTTP(response, request)
	if response.Code != 429 {
		t.Fatalf("closing controller response: %d %s", response.Code, response.Body)
	}
}

func waitNativeValidationDrain(t *testing.T, f *sessionHTTPFixture) {
	t.Helper()
	routes := f.application.(*routeApplication).Routes
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for routes.ActiveConnections() != 0 {
		select {
		case <-tick.C:
		case <-ctx.Done():
			t.Fatal("closed native controller did not finish its route cleanup")
		}
	}
}
