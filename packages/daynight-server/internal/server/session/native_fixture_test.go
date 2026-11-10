package session_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

type sessionHTTPFixture struct {
	sessionHTTPShutdown
	backend        *routeBackend
	authentication *routeAuthentication
	handler        *resourceTestHandler
	server         *httptest.Server
	application    sessionApplication
	task           api.Task
	base           string
	registration   sp.Registration
	snapshot       sp.Snapshot
	grant          sessioncore.GrantResult
	mu             sync.Mutex
	routesInstance string
}

func nativeSnapshotForTest(project, task string, registration sp.Registration) sp.Snapshot {
	return sp.Snapshot{
		ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), ClaimID: registration.ClaimID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"},
		Protocol:        sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1,
		Identity:        sp.Identity{ProjectID: project, TaskID: task, WorkerID: registration.WorkerID, WorktreeID: registration.WorktreeID, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, AgentControlMode: "web", Provider: "codex"},
		SessionRevision: "1", HistoryEpoch: uuid.NewString(), LastEventSeq: "0", LastTimelineSeq: "0", InitialInputState: "not_submitted", Lifecycle: "active", ConnectionState: "disconnected", Activity: "unknown",
	}
}

func nativeFrame(fence sp.ControllerFence, fields map[string]any) map[string]any {
	frame := map[string]any{"protocol": sp.Protocol, "sessionId": fence.SessionID, "claimId": fence.ClaimID, "executionGeneration": fence.ExecutionGeneration, "connectionEpoch": fence.ConnectionEpoch}
	for name, value := range fields {
		frame[name] = value
	}
	return sp.BindingFields(fence.Fence, frame)
}

func sessionHTTPSetup(t *testing.T) *sessionHTTPFixture {
	return sessionHTTPSetupWithApplication(t, newSessionHTTPApplication)
}

func sessionHTTPSetupWithApplication(t *testing.T, factory sessionApplicationFactory) *sessionHTTPFixture {
	t.Helper()
	f := &sessionHTTPFixture{backend: newRouteBackend(t), authentication: newRouteAuthentication(t, "https://daynight.example")}
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	f.task = api.Task{ID: uuid.NewString(), ProjectID: uuid.NewString(), Title: "Web session", Status: "in_progress", Version: 1}
	f.base = taskPath(f.task) + "/sessions"
	f.registration = sp.Registration{Protocol: sp.Protocol, RegistrationID: uuid.NewString(), ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), WorktreeID: uuid.NewString(), Provider: "codex", ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString()}
	f.snapshot = nativeSnapshotForTest(f.task.ProjectID, f.task.ID, f.registration)
	f.grant = sessioncore.GrantResult{Token: "dncontroller_" + uuid.NewString(), ExpiresAt: time.Now().Add(2 * time.Minute).UTC(), SessionID: f.snapshot.SessionID, ClaimID: f.snapshot.ClaimID, ExecutionGeneration: f.snapshot.ExecutionGeneration, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID}
	f.application = factory(t, f.backend, f.authentication)
	f.handler = &resourceTestHandler{Handler: httpx.RequestLogging(testLogger(), f.application), token: f.authentication.Credential(principal), principal: principal, backend: f.backend, authentication: f.authentication, application: f.application}
	f.server = httptest.NewServer(httpx.RequestLogging(testLogger(), f.application))
	t.Cleanup(f.server.Close)
	f.sessionHTTPShutdown.register(t, f.application.Shutdown)
	return f
}

func (f *sessionHTTPFixture) require(ok bool, message string) error {
	if ok {
		return nil
	}
	err := errors.New(message)
	f.backend.t.Error(err)
	f.backend.mu.Lock()
	onFailure := f.backend.OnFailure
	f.backend.mu.Unlock()
	if onFailure != nil {
		onFailure(err)
	}
	return err
}

func (f *sessionHTTPFixture) scopeArguments(ctx context.Context, p model.Principal, project, task, id string) error {
	return f.require(ctx != nil && p == f.handler.principal && project == f.task.ProjectID && task == f.task.ID && id == f.snapshot.SessionID, "native usecase received wrong context, principal or scoped IDs")
}

func (f *sessionHTTPFixture) nextCall(name string) {
	f.backend.ExpectCalls(name, f.backend.Called(name)+1)
}

func (f *sessionHTTPFixture) mint(t *testing.T, kind string) sessioncore.GrantResult {
	t.Helper()
	input := sp.Grant{Protocol: sp.Protocol, ClaimID: f.snapshot.ClaimID, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, ExecutionGeneration: f.snapshot.ExecutionGeneration, Kind: kind}
	result := sessioncore.GrantResult{Token: "dncontroller_" + uuid.NewString(), ExpiresAt: time.Now().Add(time.Minute).UTC(), SessionID: f.snapshot.SessionID, ClaimID: f.snapshot.ClaimID, ExecutionGeneration: f.snapshot.ExecutionGeneration, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID}
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.Grant = func(ctx context.Context, p model.Principal, project, task, id string, actual sp.Grant) (sessioncore.GrantResult, error) {
			if err := f.scopeArguments(ctx, p, project, task, id); err != nil {
				return sessioncore.GrantResult{}, err
			}
			if err := f.require(reflect.DeepEqual(actual, input), "Grant changed decoded native request"); err != nil {
				return sessioncore.GrantResult{}, err
			}
			return result, nil
		}
	})
	f.nextCall("Grant")
	got := decodeResponse[sessioncore.GrantResult](t, projectRequest(f.handler, http.MethodPost, f.base+"/"+f.snapshot.SessionID+"/controller-grant", jsonBody(t, input)), http.StatusOK)
	if !reflect.DeepEqual(got, result) {
		t.Fatal("Grant response changed supplied result")
	}
	return got
}

func (f *sessionHTTPFixture) ControllerWrite(t *testing.T, conn *websocket.Conn, message sp.ControllerMessage) {
	t.Helper()
	if message.Type != "hello" {
		f.nextCall("Handle")
	}
	sessionWSWrite(t, conn, message)
}

func (f *sessionHTTPFixture) controller(t *testing.T, epoch string, contentVersions ...int) (*websocket.Conn, sp.Snapshot) {
	t.Helper()
	token := f.grant.Token
	contentVersion := 0
	if len(contentVersions) > 0 {
		contentVersion = contentVersions[0]
	}
	snapshot := routeCopy(f.snapshot)
	number, err := strconv.ParseInt(snapshot.ConnectionEpoch, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.ConnectionEpoch = strconv.FormatInt(number+1, 10)
	snapshot.ConnectionState = "synchronizing"
	snapshot.Synchronized = false
	snapshot.HistoryEpoch = uuid.NewString()
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: f.snapshot.ControllerFence, SchemaVersion: 1, ProjectionVersion: 1, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: "0"}
	helloWire := []byte(jsonBody(t, hello))
	state := sp.State{NativeSessionID: snapshot.Identity.NativeSessionID, InitialInputState: snapshot.InitialInputState, Synchronized: true, Activity: "initializing"}
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.AuthenticateController = func(ctx context.Context, actual string) error {
			return f.require(ctx != nil && actual == token, "AuthenticateController changed native token")
		}
		calls.Connect = func(ctx context.Context, actual string, decoded sp.ControllerMessage, instance string, actualVersion int) (sp.Snapshot, error) {
			if err := f.require(ctx != nil && actualVersion == contentVersion && actual == token && decoded.Type == "hello" && decoded.Protocol == hello.Protocol && decoded.Fence == hello.Fence && decoded.ControllerID == hello.ControllerID && decoded.ControllerInstanceID == hello.ControllerInstanceID && decoded.Provider == hello.Provider && decoded.SourceEpoch == epoch && decoded.LastAckedSourceSeq == "0" && decoded.SchemaVersion == 1 && decoded.ProjectionVersion == 1 && bytes.Equal(decoded.Raw, helloWire) && instance != "", "Connect changed decoded hello, grant or Routes instance"); err != nil {
				return sp.Snapshot{}, err
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.routesInstance != "" && f.routesInstance != instance {
				return sp.Snapshot{}, f.require(false, "one Routes instance changed its controller identity")
			}
			f.routesInstance = instance
			return snapshot, nil
		}
		calls.SourceSeq = func(ctx context.Context, fence sp.ControllerFence) (int64, error) {
			return 0, f.require(ctx != nil && fence == snapshot.ControllerFence, "SourceSeq changed connected fence")
		}
		calls.Handle = func(ctx context.Context, message sp.ControllerMessage) (map[string]any, error) {
			if err := f.require(ctx != nil && message.Type == "sync_state" && message.ControllerFence == snapshot.ControllerFence && reflect.DeepEqual(message.State, &state) && len(message.PendingInteractions) == 0, "Handle changed decoded synchronization frame"); err != nil {
				return nil, err
			}
			return nativeFrame(snapshot.ControllerFence, map[string]any{"type": "sync_ack", "protocol": sp.Protocol, "connectionEpoch": snapshot.ConnectionEpoch}), nil
		}
		calls.Poll = func(ctx context.Context, fence sp.ControllerFence) ([]map[string]any, error) {
			if err := f.require(ctx != nil && fence == snapshot.ControllerFence, "Poll changed connected fence"); err != nil {
				return nil, err
			}
			return []map[string]any{}, nil
		}
		calls.Disconnect = func(ctx context.Context, fence sp.ControllerFence) error {
			_, bounded := ctx.Deadline()
			return f.require(ctx.Err() == nil && bounded && fence == snapshot.ControllerFence, "Disconnect lost bounded cleanup context or controller fence")
		}
	})
	for _, name := range []string{"AuthenticateController", "Connect", "SourceSeq", "Disconnect"} {
		f.nextCall(name)
	}
	f.backend.AllowRepeated("Poll")
	header := make(http.Header)
	if contentVersion != 0 {
		header.Set("X-Daynight-Content-Read-Version", strconv.Itoa(contentVersion))
	}
	conn := sessionDial(t, f.server.URL, "/api/v1/controller-channel", token, header)
	f.ControllerWrite(t, conn, hello)
	frame := sessionWSKind(t, conn, "welcome")
	actual, err := sp.DecodeSnapshot(frame["session"])
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, snapshot) || string(frame["lastAckedSourceSeq"]) != `"0"` {
		t.Fatal("welcome changed supplied Snapshot or source sequence")
	}
	f.snapshot = snapshot
	f.ControllerWrite(t, conn, sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}})
	sessionWSKind(t, conn, "sync_ack")
	return conn, snapshot
}

func sessionDial(t *testing.T, serverURL, path, token string, extra http.Header) *websocket.Conn {
	return sessionDialOptions(t, serverURL, path, token, extra, websocket.DialOptions{})
}
func sessionDialOptions(t *testing.T, serverURL, path, token string, extra http.Header, options websocket.DialOptions) *websocket.Conn {
	t.Helper()
	header := extra.Clone()
	if header == nil {
		header = make(http.Header)
	}
	if token != "" {
		header.Set("Authorization", "Bearer "+token)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	options.HTTPHeader = header
	conn, response, err := websocket.Dial(ctx, strings.Replace(serverURL, "http://", "ws://", 1)+path, &options)
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("WebSocket upgrade %d: %v", status, err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	return conn
}
func sessionWSWrite(t *testing.T, conn *websocket.Conn, value any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte(jsonBody(t, value))); err != nil {
		t.Fatal(err)
	}
}
func sessionWSRead(t *testing.T, conn *websocket.Conn) map[string]json.RawMessage {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]json.RawMessage
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("invalid frame %s: %v", data, err)
	}
	return result
}
func sessionWSKind(t *testing.T, conn *websocket.Conn, kind string) map[string]json.RawMessage {
	t.Helper()
	for range 30 {
		frame := sessionWSRead(t, conn)
		var actual string
		_ = json.Unmarshal(frame["type"], &actual)
		if actual == kind {
			return frame
		}
	}
	t.Fatalf("missing frame %s", kind)
	return nil
}

func shutdownDisconnectFailureMatches(err, target error) bool {
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		causes := joined.Unwrap()
		if len(causes) == 0 {
			return false
		}
		for _, cause := range causes {
			if !shutdownDisconnectFailureMatches(cause, target) {
				return false
			}
		}
		return true
	}
	if wrapped, ok := err.(interface{ Unwrap() error }); ok {
		return shutdownDisconnectFailureMatches(wrapped.Unwrap(), target)
	}
	return target != nil && err == target
}
