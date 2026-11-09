package session_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestSessionRoutesExposeOnlyCurrentClaim(t *testing.T) {
	f := sessionHTTPSetup(t)
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.Current = func(ctx context.Context, principal model.Principal, project, task string) (map[string]any, error) {
			assertNativeValidationScope(t, f, ctx, principal, project, task)
			return map[string]any{"status": "not_applicable", "claimId": nil, "agentControlMode": nil}, nil
		}
	})
	response := decodeResponse[map[string]any](t, projectRequest(f.handler, http.MethodGet, f.base+"/current", ""), http.StatusOK)
	if response["status"] != "not_applicable" || response["claimId"] != nil {
		t.Fatalf("unexpected current session: %v", response)
	}
}

func TestSessionRoutesCapabilitiesRequireAuthentication(t *testing.T) {
	backend := newRouteBackend(t)
	authentication := newRouteAuthentication(t, "https://daynight.example")
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	handler := newResourceTestHandler(t, backend, authentication, principal, io.Discard)
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
	if backend.TotalCalls() != 0 {
		t.Fatal("capability discovery invoked a Session usecase")
	}
}

func TestSessionRoutesRejectInvalidHTTPInputs(t *testing.T) {
	f := sessionHTTPSetup(t)
	path := f.base + "/" + f.snapshot.SessionID
	offlineResourceID := uuid.NewString()
	offlineResource := path + "/resources/" + offlineResourceID + "/content"
	offline := &model.Fault{Code: "controller_offline", Message: "The given Controller is offline."}
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.Resource = func(ctx context.Context, principal model.Principal, project, task, session, resource string) ([]byte, sp.Resource, error) {
			assertNativeValidationScope(t, f, ctx, principal, project, task)
			if session != f.snapshot.SessionID || resource != offlineResourceID {
				t.Fatal("resource request changed canonical identifiers")
			}
			return nil, sp.Resource{}, offline
		}
	})
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
		before := f.backend.TotalCalls()
		response := projectRequest(f.handler, input.method, input.path, input.body)
		if response.Code != input.status {
			t.Fatalf("%s %s: %d %s", input.method, input.path, response.Code, response.Body)
		}
		calls := 0
		if input.path == offlineResource {
			calls = 1
		}
		if f.backend.TotalCalls()-before != calls {
			t.Fatalf("%s %s invoked unexpected Session usecases", input.method, input.path)
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
		before := f.backend.TotalCalls()
		request := httptest.NewRequest(http.MethodPost, f.base, test.body)
		request.Header.Set("Authorization", "Bearer "+f.handler.token)
		request.Header.Set("Content-Type", test.contentType)
		response := httptest.NewRecorder()
		f.handler.ServeHTTP(response, request)
		if response.Code != test.status {
			t.Fatalf("body rejection: %d %s", response.Code, response.Body)
		}
		if f.backend.TotalCalls() != before {
			t.Fatal("invalid HTTP body reached a Session usecase")
		}
	}
	command := sp.Command{Fence: f.snapshot.Fence, Protocol: sp.Protocol, RequestID: "initial", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"Too soon"}],"expectedTurnId":null}`)}
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.Submit = func(ctx context.Context, principal model.Principal, project, task, session string, input sp.Command) (sp.Operation, error) {
			assertNativeValidationScope(t, f, ctx, principal, project, task)
			if session != f.snapshot.SessionID || !reflect.DeepEqual(input, command) {
				t.Fatal("command request changed decoded intent or canonical identifiers")
			}
			return sp.Operation{}, offline
		}
	})
	response := projectRequest(f.handler, http.MethodPost, path+"/commands", jsonBody(t, command))
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
		before := f.backend.TotalCalls()
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
		if f.backend.TotalCalls() != before {
			t.Fatal("deprecated controller upload reached a Session usecase")
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
	permitAuthentication := func(token string, result error) {
		f.backend.ExpectCalls("AuthenticateController", f.backend.Called("AuthenticateController")+1)
		f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
			calls.AuthenticateController = func(ctx context.Context, actual string) error {
				if err := f.require(ctx != nil && ctx.Err() == nil && actual == token, "Controller authentication changed token or request context"); err != nil {
					return err
				}
				return result
			}
		})
	}
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
	permitAuthentication(f.grant.Token, nil)
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
		permitAuthentication(f.grant.Token, nil)
		conn := sessionDial(t, f.server.URL, "/api/v1/controller-channel", f.grant.Token, nil)
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		err := conn.Write(ctx, kind, []byte(`{}`))
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		assertClosed(conn)
	}
	permitAuthentication(f.grant.Token, nil)
	wrongFirst := sessionDial(t, f.server.URL, "/api/v1/controller-channel", f.grant.Token, nil)
	fence := f.snapshot.ControllerFence
	fence.ConnectionEpoch = "1"
	sessionWSWrite(t, wrongFirst, sp.ControllerMessage{Type: "heartbeat", Protocol: sp.Protocol, ControllerFence: fence})
	assertClosed(wrongFirst)
	invalidToken := httptest.NewRequest(http.MethodGet, "/api/v1/controller-channel", nil)
	invalidToken.Header.Set("Authorization", "Bearer dncontroller_invalid")
	permitAuthentication("dncontroller_invalid", &model.Fault{Code: "forbidden", Message: "The given Controller grant is invalid."})
	invalidResponse := httptest.NewRecorder()
	f.application.ServeHTTP(invalidResponse, invalidToken)
	if invalidResponse.Code != http.StatusForbidden {
		t.Fatal("invalid controller grant was not refused before upgrade", invalidResponse.Code)
	}
	epoch := uuid.NewString()
	controller, snapshot := f.controller(t, epoch)
	gap := sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "2", Kind: "gap", Payload: json.RawMessage(`{"reason":"Skipped source sequence"}`)}}}
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.Handle = func(ctx context.Context, input sp.ControllerMessage) (map[string]any, error) {
			if err := f.require(ctx != nil && ctx.Err() == nil && input.Type == gap.Type && input.Protocol == gap.Protocol && input.ControllerFence == gap.ControllerFence && input.SourceEpoch == gap.SourceEpoch && input.BatchID == gap.BatchID && reflect.DeepEqual(input.Events, gap.Events) && bytes.Equal(input.Raw, []byte(jsonBody(t, gap))), "source gap frame changed before the usecase boundary"); err != nil {
				return nil, err
			}
			return nil, &model.Fault{Code: "source_gap", Message: "The given source sequence has a gap."}
		}
	})
	f.ControllerWrite(t, controller, gap)
	sessionWSKind(t, controller, "error")
	assertClosed(controller)
	f.grant = f.mint(t, "reconnect")
	controller, snapshot = f.controller(t, epoch)
	stale := snapshot.ControllerFence
	stale.ConnectionEpoch = "999"
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "heartbeat", Protocol: sp.Protocol, ControllerFence: stale})
	sessionWSKind(t, controller, "error")
	assertClosed(controller)
	f.grant = f.mint(t, "reconnect")
	controller, snapshot = f.controller(t, epoch)
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.Handle = func(ctx context.Context, input sp.ControllerMessage) (map[string]any, error) {
			if err := f.require(ctx != nil && ctx.Err() == nil && input.Type == "heartbeat" && input.Protocol == sp.Protocol && input.ControllerFence == snapshot.ControllerFence, "heartbeat changed before the usecase boundary"); err != nil {
				return nil, err
			}
			return sp.BindingFields(snapshot.Fence, map[string]any{"type": "heartbeat_ack", "protocol": sp.Protocol, "connectionEpoch": snapshot.ConnectionEpoch}), nil
		}
	})
	f.ControllerWrite(t, controller, sp.ControllerMessage{Type: "heartbeat", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence})
	sessionWSKind(t, controller, "heartbeat_ack")
	if err := f.application.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertClosed(controller)
	request = httptest.NewRequest(http.MethodGet, "/api/v1/controller-channel", nil)
	request.Header.Set("Authorization", "Bearer "+f.grant.Token)
	permitAuthentication(f.grant.Token, nil)
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

func assertNativeValidationScope(t *testing.T, f *sessionHTTPFixture, ctx context.Context, principal model.Principal, project, task string) {
	t.Helper()
	if ctx == nil || ctx.Err() != nil || principal != f.handler.principal || project != f.task.ProjectID || task != f.task.ID {
		t.Fatal("HTTP request changed principal, canonical scope or live context")
	}
}
