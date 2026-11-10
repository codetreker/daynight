package server

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	"github.com/google/uuid"
)

type sessionHTTPFixture struct {
	t                  *testing.T
	mu                 sync.Mutex
	record             store.SessionRecord
	credentialRevoked  bool
	sessionTask        store.SessionTask
	handler            *resourceTestHandler
	server             *httptest.Server
	application        *sessionApplication
	identity           *operationHTTPIdentity
	taskOperations     taskhttp.TaskService
	startup            *startupHTTPOperations
	ops                *sessionhttp.Operations
	task               api.Task
	base               string
	registration       sp.Registration
	snapshot           sp.Snapshot
	grant              sessioncore.GrantResult
	connectedSnapshot  sp.Snapshot
	connectionContext  context.Context
	connections        map[sp.ControllerFence]context.Context
	connectionCaptured chan struct{}
	connectionCommit   chan struct{}
	writes             sessionHTTPWrites
	handles            []sessionHTTPHandle
	pollFrames         [][]map[string]any
	browserFrames      [][]map[string]any
	browserSnapshot    sp.Snapshot
	browserCursor      string
	browserCalls       int
	sourceSeq          int64
	commands           map[string]*sessionHTTPCommand
	offered            map[string]int
}

func sessionHTTPSetup(t *testing.T) *sessionHTTPFixture {
	t.Helper()
	return sessionHTTPSetupMode(t, model.AgentControlModeWeb, true)
}

func sessionHTTPSetupMode(t *testing.T, mode model.WorkerAgentControlMode, prepare bool) *sessionHTTPFixture {
	t.Helper()
	f := &sessionHTTPFixture{t: t, commands: map[string]*sessionHTTPCommand{}, offered: map[string]int{}, connections: map[sp.ControllerFence]context.Context{}, browserCursor: "opaque-session-http-position"}
	principal := defaultHTTPPrincipal()
	now := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	worker := model.WorkerClaim{ClaimID: uuid.NewString(), State: model.WorkerActive, UserID: principal.UserID, WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "Session test"}, Platform: model.TaskPlatform("linux"), Agent: model.AgentCodex, AgentControlMode: mode, WorktreeID: uuid.NewString(), Phase: model.WorkerExecuting, ClaimedAt: now}
	f.task = api.Task{ID: uuid.NewString(), ProjectID: uuid.NewString(), Title: "Web session", Description: "", Status: "in_progress", AllowAgents: true, CreatedAt: now, UpdatedAt: now, Version: 1, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Properties: map[string]json.RawMessage{}, AssignedTo: &principal.UserID}
	f.task.Properties["worker"] = json.RawMessage(jsonBody(t, api.WorkerClaim{ClaimID: worker.ClaimID, State: "active", UserID: worker.UserID, WorkerID: worker.WorkerID, Machine: api.WorkerMachine{ID: worker.Machine.ID, Name: worker.Machine.Name}, Platform: "linux", Agent: "codex", AgentControlMode: string(mode), WorktreeID: worker.WorktreeID, Phase: "executing", ClaimedAt: now}))
	f.sessionTask = store.SessionTask{Worker: &worker, Status: "in_progress"}
	f.base = taskPath(f.task) + "/sessions"
	f.registration = sp.Registration{Protocol: sp.Protocol, RegistrationID: uuid.NewString(), ClaimID: worker.ClaimID, WorkerID: worker.WorkerID, WorktreeID: worker.WorktreeID, Provider: "codex", ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString()}
	f.snapshot = sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), ClaimID: worker.ClaimID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"}, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, Identity: sp.Identity{ProjectID: f.task.ProjectID, TaskID: f.task.ID, WorkerID: worker.WorkerID, WorktreeID: worker.WorktreeID, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, AgentControlMode: "web", Provider: "codex"}, SessionRevision: "1", HistoryEpoch: uuid.NewString(), LastEventSeq: "0", LastTimelineSeq: "0", InitialInputState: "not_submitted", Lifecycle: "active", ConnectionState: "disconnected", Activity: "initializing"}
	f.record = store.SessionRecord{Snapshot: f.snapshot, Owner: principal.UserID, Registration: []byte(jsonBody(t, f.registration))}
	f.identity = newOperationHTTPIdentity(t, principal)
	f.taskOperations = startupTaskOperations(t, f)
	operations := strictSessionHTTPOperations(t)
	f.ops = &operations
	f.configureOperations()
	f.handler = newOperationHTTPServerWithIdentity(t, f.identity, func(deps *httpDependencies) {
		deps.Tasks = f.taskOperations
		deps.Relay = sessionhttp.NewRoutesWithOperations(forwardSessionHTTPOperations(f.ops), deps.Auth.RequestAuthentication, testLogger())
		f.application = &sessionApplication{relay: deps.Relay}
	}, io.Discard, principal)
	f.application.Handler = f.handler.Handler
	extendedWorkerTestHandler(f.handler)
	f.server = httptest.NewServer(f.application)
	t.Cleanup(func() {
		closeSessionHTTPServer(t, f.server, f.application)
		f.mu.Lock()
		defer f.mu.Unlock()
		if len(f.handles) != 0 || len(f.pollFrames) != 0 || len(f.browserFrames) != 0 {
			t.Errorf("unconsumed Session operation plans: handles=%d polls=%d browser=%d", len(f.handles), len(f.pollFrames), len(f.browserFrames))
		}
	})
	if prepare {
		want := sessionHTTPCopy(f.snapshot)
		called := sessionHTTPOnce(t)
		f.ops.Register = func(ctx context.Context, p model.Principal, project, task string, input sp.Registration) (sp.Snapshot, error) {
			called()
			f.requireBrowser(ctx, p, project, task, want.SessionID)
			if !reflect.DeepEqual(input, f.registration) {
				unexpectedHTTPCall(t, "Session Register input")
			}
			return sessionHTTPCopy(want), nil
		}
		registered := decodeResponse[struct {
			Session sp.Snapshot `json:"session"`
		}](t, projectRequest(f.handler, http.MethodPost, f.base, jsonBody(t, f.registration)), http.StatusOK)
		if !reflect.DeepEqual(registered.Session, want) {
			t.Fatal("registered Session changed declared identity")
		}
		f.grant = f.mint(t, "bootstrap")
	}
	return f
}

func (f *sessionHTTPFixture) mint(t *testing.T, kind string) sessioncore.GrantResult {
	t.Helper()
	return f.mintGrant(t, sp.Grant{Protocol: sp.Protocol, ClaimID: f.snapshot.ClaimID, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, ExecutionGeneration: f.snapshot.ExecutionGeneration, Kind: kind})
}
func (f *sessionHTTPFixture) mintGrant(t *testing.T, g sp.Grant) sessioncore.GrantResult {
	t.Helper()
	expected := sessionHTTPCopy(g)
	want := sessioncore.GrantResult{Token: "dncontroller_" + uuid.NewString(), ExpiresAt: time.Now().UTC().Add(time.Hour), SessionID: f.snapshot.SessionID, ClaimID: g.ClaimID, ExecutionGeneration: g.ExecutionGeneration, ControllerID: g.ControllerID, ControllerInstanceID: g.ControllerInstanceID}
	called := sessionHTTPOnce(t)
	f.ops.Grant = func(ctx context.Context, p model.Principal, project, task, id string, actual sp.Grant) (sessioncore.GrantResult, error) {
		called()
		f.requireBrowser(ctx, p, project, task, id)
		if !reflect.DeepEqual(actual, expected) {
			unexpectedHTTPCall(t, "Session Grant full input")
		}
		return want, nil
	}
	out := decodeResponse[sessioncore.GrantResult](t, projectRequest(f.handler, http.MethodPost, f.base+"/"+f.snapshot.SessionID+"/controller-grant", jsonBody(t, g)), http.StatusOK)
	if !reflect.DeepEqual(out, want) {
		t.Fatal("controller grant response changed declared result")
	}
	f.mu.Lock()
	hash := sha256.Sum256([]byte(want.Token))
	f.record.GrantHash = append([]byte(nil), hash[:]...)
	expiry := want.ExpiresAt
	f.record.GrantExpiry = &expiry
	f.record.GrantKind = g.Kind
	f.record.Parent = f.handler.principal.CredentialID
	f.record.Consumed = false
	f.mu.Unlock()
	return out
}
func sessionDial(t *testing.T, serverURL, path, token string, extra http.Header) *websocket.Conn {
	t.Helper()
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
	if json.Unmarshal(data, &result) != nil {
		t.Fatalf("invalid frame %s", data)
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
func (f *sessionHTTPFixture) controller(t *testing.T, epoch string) (*websocket.Conn, sp.Snapshot) {
	t.Helper()
	f.mu.Lock()
	prior, _ := strconv.ParseInt(f.record.Snapshot.ConnectionEpoch, 10, 64)
	want := sessionHTTPCopy(f.record.Snapshot)
	want.ConnectionEpoch = strconv.FormatInt(prior+1, 10)
	want.ConnectionState = "synchronizing"
	want.Synchronized = false
	want.Activity = "initializing"
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: f.snapshot.ControllerFence, SchemaVersion: 1, ProjectionVersion: 1, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: "0"}
	captured, commit := make(chan struct{}), make(chan struct{})
	f.connectionCaptured, f.connectionCommit = captured, commit
	f.mu.Unlock()
	called := sessionHTTPOnce(t)
	f.ops.Connect = func(ctx context.Context, token string, actual sp.ControllerMessage, instance string, version int) (sp.Snapshot, error) {
		called()
		raw := []byte(jsonBody(t, hello))
		expected := sessionHTTPCopy(hello)
		expected.Raw = append(json.RawMessage(nil), raw...)
		if token != f.grant.Token || !reflect.DeepEqual(actual, expected) || instance == "" || version != 0 || ctx.Err() != nil {
			unexpectedHTTPCall(t, "Session Connect full hello/identity/version")
		}
		f.mu.Lock()
		f.connectionContext = ctx
		f.connections[want.ControllerFence] = ctx
		f.writes.instance = instance
		expires := f.grant.ExpiresAt
		f.writes.connectionExpiry = &expires
		f.connectedSnapshot = sessionHTTPCopy(want)
		f.browserSnapshot = sessionHTTPCopy(want)
		f.mu.Unlock()
		close(captured)
		select {
		case <-commit:
			return sessionHTTPCopy(want), nil
		case <-ctx.Done():
			return sp.Snapshot{}, ctx.Err()
		}
	}
	conn := sessionDial(t, f.server.URL, "/api/v1/controller-channel", f.grant.Token, nil)
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(commit) }) })
	sessionWSWrite(t, conn, hello)
	select {
	case <-captured:
	case <-time.After(5 * time.Second):
		t.Fatal("controller did not reach connection operation")
	}
	f.mu.Lock()
	if f.writes.instance == "" || f.writes.connectionExpiry == nil {
		f.mu.Unlock()
		t.Fatal("connection operation did not capture relay identity")
	}
	f.record.Snapshot = sessionHTTPCopy(want)
	instance := f.writes.instance
	f.record.ServerInstance = &instance
	expiry := f.grant.ExpiresAt
	f.record.ConnectionExpiry = &expiry
	seen := time.Now().UTC()
	f.record.LastSeen = &seen
	f.record.ConnectionParent = f.handler.principal.CredentialID
	f.record.Consumed = true
	f.record.SourceEpoch = &epoch
	f.record.SourceEpochs = []string{epoch}
	f.mu.Unlock()
	release.Do(func() { close(commit) })
	frame := sessionWSKind(t, conn, "welcome")
	snapshot, err := sp.DecodeSnapshot(frame["session"])
	if err != nil || !reflect.DeepEqual(snapshot, want) {
		t.Fatal("welcome changed complete declared connection snapshot", err)
	}
	state := sp.State{NativeSessionID: snapshot.Identity.NativeSessionID, InitialInputState: snapshot.InitialInputState, Synchronized: true, Activity: "initializing"}
	message := sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}
	f.expectHandle(t, message, f.frame(snapshot, "sync_ack"))
	sessionWSWrite(t, conn, message)
	sessionWSKind(t, conn, "sync_ack")
	f.mu.Lock()
	f.browserSnapshot = sessionHTTPCopy(want)
	f.browserSnapshot.Synchronized = true
	f.browserSnapshot.ConnectionState = "connected"
	f.browserSnapshot.SessionRevision = "3"
	f.browserSnapshot.LastEventSeq = "2"
	f.mu.Unlock()
	return conn, snapshot
}

func closeSessionHTTPServer(t *testing.T, server *httptest.Server, application Handler) bool {
	t.Helper()
	application.BeginShutdown()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	err := application.Shutdown(ctx)
	cancel()
	drained := err == nil
	if err != nil {
		t.Error(err)
		server.CloseClientConnections()
		retry, retryCancel := context.WithTimeout(context.Background(), 5*time.Second)
		err = application.Shutdown(retry)
		retryCancel()
		drained = err == nil
		if err != nil {
			t.Error(err)
		}
	}
	closed := make(chan struct{})
	go func() { server.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Error("Session HTTP server did not join")
		return false
	}
	return drained
}
