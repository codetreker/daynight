package session_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

type terminalHTTPFixture struct {
	sessionHTTPShutdown
	h              *resourceTestHandler
	app            sessionApplication
	calls          *routeBackend
	authentication *routeAuthentication
	routes         *sessionhttp.Routes
	server         *httptest.Server
	base           string
	message        v2.Message
}

func terminalHTTPSetup(t *testing.T) *terminalHTTPFixture {
	t.Helper()
	calls := newRouteBackend(t)
	authentication := newRouteAuthentication(t, "https://daynight.example")
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	handler := newResourceTestHandler(t, calls, authentication, principal, io.Discard)
	app := handler.application.(*routeApplication)
	project, task, claim, worker, worktree := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	pane := "pane_1"
	message := v2.Message{Envelope: v2.Envelope{Protocol: v2.Protocol, SchemaVersion: 2, ProjectionVersion: 1, Type: "registration", SessionID: uuid.NewString(), ClaimID: claim, ExecutionGeneration: "1", AgentControlMode: "herdr", ContentKind: "terminal_recording"}, Payload: v2.Registration{RegistrationID: uuid.NewString(), Mode: "register", Owner: v2.Owner{ProjectID: project, TaskID: task, WorkerID: worker, WorktreeID: worktree, OwnerUserID: principal.UserID, ServerOrigin: "https://daynight.example", Provider: "codex"}, Binding: v2.Binding{InstanceID: "daemon", SessionID: "native", WorkspaceID: "workspace", PaneID: v2.NativePaneID{Text: &pane}, TerminalID: "term_test"}, Capabilities: v2.Capabilities{Observe: true, Control: true, Archive: true}}}
	f := &terminalHTTPFixture{h: handler, app: app, calls: calls, authentication: authentication, routes: app.Routes, base: "/api/v1/projects/" + project + "/tasks/" + task + "/sessions", message: message}
	f.server = httptest.NewServer(handler.Handler)
	t.Cleanup(f.server.Close)
	f.sessionHTTPShutdown.register(t, app.Shutdown)
	return f
}

func terminalRequest(handler http.Handler, method, path, body, protocol string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(handler, request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "project-test")
	if protocol != "" {
		request.Header.Set(v2.ProtocolHeader, protocol)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func terminalMessage(t *testing.T, response *httptest.ResponseRecorder) v2.Message {
	t.Helper()
	if response.Code != http.StatusOK && response.Code != http.StatusAccepted {
		t.Fatalf("terminal response: %d %s", response.Code, response.Body.String())
	}
	message, err := v2.DecodeMessage(response.Body.Bytes())
	if err != nil {
		t.Fatalf("terminal response %s: %v", response.Body.String(), err)
	}
	return message
}

func (f *terminalHTTPFixture) ack(epoch string) v2.Message {
	message := f.message
	message.Type = "registration_ack"
	message.Payload = v2.RegistrationAck{RegistrationID: f.message.Payload.(v2.Registration).RegistrationID, ConnectionEpoch: epoch}
	return message
}

func (f *terminalHTTPFixture) knownState(epoch string) map[string]any {
	registration := f.message.Payload.(v2.Registration)
	return map[string]any{"status": "registered", "protocol": v2.Protocol, "schemaVersion": 2, "projectionVersion": 1, "sessionId": f.message.SessionID, "claimId": f.message.ClaimID, "executionGeneration": "1", "agentControlMode": "herdr", "contentKind": "terminal_recording", "owner": registration.Owner, "binding": registration.Binding, "connectionEpoch": epoch, "connected": true, "capabilities": registration.Capabilities, "control": v2.ControlState{ConnectionEpoch: epoch, ControlEpoch: "1", State: "automation", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}, "snapshot": nil, "ledger": v2.GenerationLedger{Runs: []v2.Run{}}, "archive": v2.ArchiveStatus{State: "pending"}, "recording": []any{}}
}

func (f *terminalHTTPFixture) scope(t *testing.T, ctx context.Context, p model.Principal, project, task, id string) {
	t.Helper()
	owner := f.message.Payload.(v2.Registration).Owner
	if ctx.Err() != nil || p != f.h.principal || project != owner.ProjectID || task != owner.TaskID || id != f.message.SessionID {
		t.Errorf("terminal use-case arguments changed: %v %v %s/%s/%s", ctx.Err(), p, project, task, id)
	}
}

func (f *terminalHTTPFixture) register(t *testing.T) v2.Message {
	t.Helper()
	expected, ack := f.message, f.ack("1")
	f.calls.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.RegisterTerminal = func(ctx context.Context, p model.Principal, project, task string, message v2.Message) (v2.Message, error) {
			f.scope(t, ctx, p, project, task, message.SessionID)
			if !reflect.DeepEqual(message, expected) {
				t.Error("HTTP registration changed the parsed message")
			}
			return ack, nil
		}
	})
	result := terminalMessage(t, terminalRequest(f.h, http.MethodPost, f.base, jsonBody(t, expected), v2.Protocol))
	if !reflect.DeepEqual(result, ack) {
		t.Fatal("HTTP registration changed the service acknowledgement", result)
	}
	return result
}

func (f *terminalHTTPFixture) workerHeaders() http.Header {
	header := make(http.Header)
	header.Set("Authorization", "Bearer "+f.h.token)
	header.Set(v2.ProtocolHeader, v2.Protocol)
	return header
}

func (f *terminalHTTPFixture) viewerHeaders(handler *resourceTestHandler) http.Header {
	header := make(http.Header)
	header.Set("Authorization", "Bearer "+handler.token)
	header.Set("Origin", "https://daynight.example")
	header.Set(v2.ProtocolHeader, v2.Protocol)
	return header
}

func (f *terminalHTTPFixture) handshake(t *testing.T, conn *websocket.Conn) v2.Message {
	t.Helper()
	return f.workerMessage(t, conn, f.message)
}

func (f *terminalHTTPFixture) workerMessage(t *testing.T, conn *websocket.Conn, message v2.Message) v2.Message {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte(jsonBody(t, message))); err != nil {
		t.Fatal(err)
	}
	kind, raw, err := conn.Read(ctx)
	if err != nil || kind != websocket.MessageText {
		t.Fatalf("terminal worker acknowledgement: kind=%v error=%v", kind, err)
	}
	ack, err := v2.DecodeMessage(raw)
	if err != nil {
		t.Fatalf("terminal worker response %s: %v", raw, err)
	}
	return ack
}

func (f *terminalHTTPFixture) waitConnections(t *testing.T, want int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for f.routes.ActiveConnections() != want {
		select {
		case <-ctx.Done():
			t.Fatalf("terminal routes did not drain to %d active connections", want)
		case <-ticker.C:
		}
	}
}
