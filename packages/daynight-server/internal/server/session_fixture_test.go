package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/api"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/google/uuid"
)

type sessionHTTPFixture struct {
	store              *sessionHTTPStore
	mu                 sync.Mutex
	record             store.SessionRecord
	sessionTask        store.SessionTask
	operations         []store.SessionOperation
	intentIDs          []string
	acceptedPlans      [][]string
	queryRevision      int64
	connectionCaptured chan struct{}
	connectionCommit   chan struct{}
	writes             sessionHTTPWrites
	calls              map[string]int
	credentialRevoked  bool
	handler            *resourceTestHandler
	server             *httptest.Server
	application        *sessionApplication
	task               api.Task
	base               string
	registration       sp.Registration
	snapshot           sp.Snapshot
	grant              sessioncore.GrantResult
}

func sessionHTTPSetup(t *testing.T) *sessionHTTPFixture {
	t.Helper()
	return sessionHTTPSetupMode(t, model.AgentControlModeWeb, true)
}

func sessionHTTPSetupMode(t *testing.T, mode model.WorkerAgentControlMode, prepare bool) *sessionHTTPFixture {
	t.Helper()
	f := &sessionHTTPFixture{calls: map[string]int{}}
	f.store = &sessionHTTPStore{httpTestStore: newHTTPTestStore(t), fixture: f}
	f.store.WriteSessionCall = f.store.run
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
	application, err := newTestHandler(Dependencies{Store: f.store, Files: attachmentTestFiles(t)}, configuredTestConfig(), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	f.application = application.(*sessionApplication)
	f.handler = &resourceTestHandler{Handler: httpx.RequestLogging(testLogger(), application), token: defaultHTTPToken(), principal: principal}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := f.application.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	extendedWorkerTestHandler(f.handler)
	f.server = httptest.NewServer(httpx.RequestLogging(testLogger(), f.application))
	t.Cleanup(f.server.Close)
	if prepare {
		registered := decodeResponse[struct {
			Session sp.Snapshot `json:"session"`
		}](t, projectRequest(f.handler, http.MethodPost, f.base, jsonBody(t, f.registration)), http.StatusOK)
		if registered.Session.SessionID != f.snapshot.SessionID || registered.Session.ClaimID != worker.ClaimID {
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
	out := decodeResponse[sessioncore.GrantResult](t, projectRequest(f.handler, http.MethodPost, f.base+"/"+f.snapshot.SessionID+"/controller-grant", jsonBody(t, g)), http.StatusOK)
	f.mu.Lock()
	defer f.mu.Unlock()
	h := sha256.Sum256([]byte(out.Token))
	if f.writes.grant == nil || !bytes.Equal(f.writes.grant.Hash, h[:]) || f.writes.grant.Kind != g.Kind || out.SessionID != f.snapshot.SessionID || out.ExecutionGeneration != g.ExecutionGeneration {
		t.Fatal("grant write changed declared intent")
	}
	f.record.GrantHash = h[:]
	f.record.GrantExpiry = &out.ExpiresAt
	f.record.GrantKind = g.Kind
	f.record.Parent = f.handler.principal.CredentialID
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
	conn := sessionDial(t, f.server.URL, "/api/v1/controller-channel", f.grant.Token, nil)
	f.mu.Lock()
	expectedEpoch, _ := strconv.ParseInt(f.record.Snapshot.ConnectionEpoch, 10, 64)
	captured, commit := make(chan struct{}), make(chan struct{})
	f.connectionCaptured, f.connectionCommit = captured, commit
	f.mu.Unlock()
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(commit) }) })
	sessionWSWrite(t, conn, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: f.snapshot.ControllerFence, SchemaVersion: 1, ProjectionVersion: 1, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: "0"})
	select {
	case <-captured:
	case <-time.After(5 * time.Second):
		t.Fatal("controller did not reach connection DAO")
	}
	f.mu.Lock()
	if f.writes.instance == "" || f.writes.seen == nil {
		f.mu.Unlock()
		t.Fatal("connection DAO did not capture relay identity")
	}
	f.record.Snapshot.ConnectionEpoch = strconv.FormatInt(expectedEpoch+1, 10)
	f.record.ServerInstance = new(f.writes.instance)
	f.record.ConnectionExpiry = f.record.GrantExpiry
	f.record.LastSeen = new(*f.writes.seen)
	f.record.ConnectionParent = f.handler.principal.CredentialID
	f.record.Consumed = true
	f.record.SourceEpoch = new(epoch)
	f.record.SourceEpochs = []string{epoch}
	f.mu.Unlock()
	release.Do(func() { close(commit) })
	frame := sessionWSKind(t, conn, "welcome")
	snapshot, err := sp.DecodeSnapshot(frame["session"])
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ConnectionEpoch != strconv.FormatInt(expectedEpoch+1, 10) || snapshot.Identity.WorkerID != f.registration.WorkerID || snapshot.Identity.ControllerInstanceID != f.registration.ControllerInstanceID {
		t.Fatal("welcome changed declared connection fence or owner")
	}
	f.mu.Lock()
	f.record.Snapshot.HistoryEpoch = snapshot.HistoryEpoch
	f.mu.Unlock()
	state := sp.State{NativeSessionID: snapshot.Identity.NativeSessionID, InitialInputState: snapshot.InitialInputState, Synchronized: true, Activity: "initializing"}
	sessionWSWrite(t, conn, sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}})
	sessionWSKind(t, conn, "sync_ack")
	return conn, snapshot
}
