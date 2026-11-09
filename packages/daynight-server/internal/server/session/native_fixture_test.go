package session_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"

	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

type sessionHTTPFixture struct {
	sessionHTTPShutdown
	backend                 *routeBackend
	authentication          *routeAuthentication
	inputMu                 sync.Mutex
	input                   nativeRouteInput
	writes                  nativeRouteWrites
	expectedConnectionEpoch string
	connectionStartedAt     time.Time
	connectGate             *nativeConnectGate
	selectedSessionWrites   int
	socketSequence          int
	socketPlans             map[*websocket.Conn]*nativeSocketPlan
	activeController        *websocket.Conn
	offerGate               *nativeOfferGate
	handler                 *resourceTestHandler
	server                  *httptest.Server
	application             sessionApplication
	task                    api.Task
	base                    string
	registration            sp.Registration
	snapshot                sp.Snapshot
	grant                   sessioncore.GrantResult
}

type nativeRouteInput struct {
	ProjectID            string
	TaskID               string
	SessionID            string
	Task                 store.SessionTask
	TaskDeleted          bool
	TaskError            error
	Session              *store.SessionRecord
	SessionError         error
	Location             store.SessionLocation
	LocationError        error
	RegistrationID       string
	RegistrationError    error
	CurrentSessionID     string
	CurrentSessionError  error
	Credentials          map[string]model.Principal
	CredentialErrors     map[string]error
	ProjectAccess        map[string]model.ProjectAccess
	ProjectAccessErrors  map[string]error
	GrantHash            []byte
	GrantLocationError   error
	Operation            *store.SessionOperation
	OperationID          string
	OperationError       error
	PendingCount         int
	AcceptedIDs          []string
	StoppingIDs          []string
	UnreconciledIDs      []string
	UnreconciledCount    int
	OtherFirstInput      bool
	InteractionResponse  bool
	ArchiveMetadata      store.ArchiveMetadata
	ArchiveMetadataError error
	Archive              sp.ArchiveStatus
	ArchivePath          string
	ArchiveError         error
}

type nativeRouteConnection struct {
	SessionID, Instance string
	Seen                time.Time
	Expiry              *time.Time
}

type nativeConnectGate struct {
	entered chan nativeRouteConnection
	release chan struct{}
	once    sync.Once
}

type nativeSocketPlan struct {
	names    []string
	profiles map[string]string
	uses     map[string]int
}

type nativeOfferGate struct {
	entered   chan struct{}
	release   chan struct{}
	once      sync.Once
	closeOnce sync.Once
}

func (g *nativeOfferGate) close() { g.closeOnce.Do(func() { close(g.release) }) }

func (g *nativeConnectGate) close() { g.once.Do(func() { close(g.release) }) }

type nativeRouteWrites struct {
	Registration       *store.SessionRegistration
	Grant              *store.SessionGrant
	Session            []store.SessionRecord
	Connection         *nativeRouteConnection
	Operations         []store.SessionOperation
	Receipts           []sp.Operation
	Epochs             []int64
	DisconnectAttempts []string
	DisconnectError    error
}

func (f *sessionHTTPFixture) InputSnapshot() nativeRouteInput {
	f.inputMu.Lock()
	defer f.inputMu.Unlock()
	input := f.input
	input.Task = routeCopy(input.Task)
	if input.Session != nil {
		input.Session = new(routeCopy(*input.Session))
	}
	if input.Operation != nil {
		input.Operation = new(routeCopy(*input.Operation))
	}
	input.GrantHash = slices.Clone(input.GrantHash)
	input.AcceptedIDs = slices.Clone(input.AcceptedIDs)
	input.StoppingIDs = slices.Clone(input.StoppingIDs)
	input.UnreconciledIDs = slices.Clone(input.UnreconciledIDs)
	input.Credentials = maps.Clone(input.Credentials)
	input.CredentialErrors = maps.Clone(input.CredentialErrors)
	input.ProjectAccess = maps.Clone(input.ProjectAccess)
	input.ProjectAccessErrors = maps.Clone(input.ProjectAccessErrors)
	input.Archive = routeCopy(input.Archive)
	return input
}

func (f *sessionHTTPFixture) SetInput(update func(*nativeRouteInput)) {
	f.backend.Configure(func(*routeDAO) {
		f.inputMu.Lock()
		defer f.inputMu.Unlock()
		update(&f.input)
	})
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

func sessionHTTPSetup(t *testing.T) *sessionHTTPFixture {
	return sessionHTTPSetupWithApplicationAndFiles(t, newSessionHTTPApplication, attachmentTestFiles(t))
}

func sessionHTTPSetupWithApplication(t *testing.T, application sessionApplicationFactory) *sessionHTTPFixture {
	return sessionHTTPSetupWithApplicationAndFiles(t, application, attachmentTestFiles(t))
}

func sessionHTTPSetupWithFiles(t *testing.T, files filestorage.Storage) *sessionHTTPFixture {
	return sessionHTTPSetupWithApplicationAndFiles(t, newSessionHTTPApplication, files)
}

func sessionHTTPSetupWithApplicationAndFiles(t *testing.T, factory sessionApplicationFactory, files filestorage.Storage) *sessionHTTPFixture {
	t.Helper()
	f := &sessionHTTPFixture{backend: newRouteBackend(t), authentication: newRouteAuthentication(t, "https://daynight.example")}
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	worker := &model.WorkerClaim{ClaimID: uuid.NewString(), UserID: principal.UserID, WorkerID: uuid.NewString(), WorktreeID: uuid.NewString(), State: model.WorkerActive, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, Platform: model.PlatformLinux, Phase: model.WorkerExecuting, Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "test"}, ClaimedAt: time.Now()}
	f.task = api.Task{ID: uuid.NewString(), ProjectID: uuid.NewString(), Title: "Web session", Status: "in_progress", Version: 1, Properties: api.TaskProperties{"worker": rawProperty(t, worker)}}
	f.base = taskPath(f.task) + "/sessions"
	f.registration = sp.Registration{Protocol: sp.Protocol, RegistrationID: uuid.NewString(), ClaimID: worker.ClaimID, WorkerID: worker.WorkerID, WorktreeID: worker.WorktreeID, Provider: "codex", ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString()}
	f.input = nativeRouteInput{ProjectID: f.task.ProjectID, TaskID: f.task.ID, Task: store.SessionTask{Worker: worker, Status: "in_progress"}, SessionError: model.ErrNotFound, LocationError: model.ErrNotFound, RegistrationError: model.ErrNotFound, CurrentSessionError: model.ErrNotFound, OperationError: model.ErrNotFound, Credentials: map[string]model.Principal{principal.CredentialID: principal}, CredentialErrors: map[string]error{}, ProjectAccess: map[string]model.ProjectAccess{principal.UserID: {UserID: principal.UserID, ProjectID: f.task.ProjectID, Role: model.ProjectAdmin}}, ProjectAccessErrors: map[string]error{}, AcceptedIDs: []string{}, UnreconciledIDs: []string{}, StoppingIDs: []string{}}
	f.configureNativeDAO()
	f.declareNativeContracts()
	f.application = factory(t, f.backend, f.authentication, files)
	f.handler = &resourceTestHandler{Handler: httpx.RequestLogging(testLogger(), f.application), token: f.authentication.Credential(principal), principal: principal, backend: f.backend, authentication: f.authentication, application: f.application}
	result := decodeResponse[struct {
		Session sp.Snapshot `json:"session"`
	}](t, projectRequest(f.handler, http.MethodPost, f.base, jsonBody(t, f.registration), "native.register"), http.StatusOK)
	f.snapshot = result.Session
	f.inputMu.Lock()
	registration := f.writes.Registration
	f.inputMu.Unlock()
	if registration == nil || registration.Location.SessionID != result.Session.SessionID || registration.OwnerID != principal.UserID || !bytes.Equal(registration.Registration, []byte(jsonBody(t, f.registration))) {
		t.Fatal("registration response did not preserve proposed native identity")
	}
	f.SetInput(func(input *nativeRouteInput) {
		input.SessionID = result.Session.SessionID
		input.Session = &store.SessionRecord{Snapshot: result.Session, Owner: principal.UserID, Parent: principal.CredentialID, Registration: []byte(jsonBody(t, f.registration))}
		input.SessionError, input.LocationError, input.RegistrationError, input.CurrentSessionError = nil, nil, nil, nil
		input.Location = store.SessionLocation{ProjectID: f.task.ProjectID, TaskID: f.task.ID, SessionID: result.Session.SessionID}
		input.RegistrationID, input.CurrentSessionID = result.Session.SessionID, result.Session.SessionID
	})
	f.grant = f.mint(t, "bootstrap")
	f.backend.Background("native.disconnect", "native.disconnect-failed", "native.credential-refusal", "native.controller-read")
	f.server = httptest.NewServer(httpx.RequestLogging(testLogger(), f.application))
	t.Cleanup(f.server.Close)
	f.sessionHTTPShutdown.register(t, f.application.Shutdown)
	return f
}
func (f *sessionHTTPFixture) mint(t *testing.T, kind string) sessioncore.GrantResult {
	t.Helper()
	result := decodeResponse[sessioncore.GrantResult](t, projectRequest(f.handler, http.MethodPost, f.base+"/"+f.snapshot.SessionID+"/controller-grant", jsonBody(t, sp.Grant{Protocol: sp.Protocol, ClaimID: f.snapshot.ClaimID, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, ExecutionGeneration: f.snapshot.ExecutionGeneration, Kind: kind}), "native.grant"), http.StatusOK)
	hash := sha256.Sum256([]byte(result.Token))
	f.inputMu.Lock()
	proposed := f.writes.Grant
	f.inputMu.Unlock()
	if proposed == nil || proposed.SessionID != result.SessionID || proposed.Kind != kind || !bytes.Equal(proposed.Hash, hash[:]) || !proposed.ExpiresAt.Equal(result.ExpiresAt) {
		t.Fatal("grant response lost proposed native authority")
	}
	f.SetInput(func(input *nativeRouteInput) {
		input.GrantHash = slices.Clone(hash[:])
		input.Session.GrantHash = slices.Clone(hash[:])
		input.Session.GrantExpiry = &result.ExpiresAt
		input.Session.GrantKind = kind
		input.Session.Parent = f.handler.principal.CredentialID
	})
	return result
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
func (f *sessionHTTPFixture) newControllerPlan() *nativeSocketPlan {
	f.inputMu.Lock()
	f.socketSequence++
	sequence := f.socketSequence
	f.inputMu.Unlock()
	input := func() any { return f.InputSnapshot() }
	controller := map[string]int{"SessionLocation": 1, "LockTask": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "ProjectAccess": 1}
	grant := map[string]int{"SessionLocationByGrant": 1, "LockTask": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "ProjectAccess": 1}
	merge := func(base, extra map[string]int) map[string]int {
		out := maps.Clone(base)
		for name, count := range extra {
			out[name] = count
		}
		return out
	}
	definitions := []struct {
		name     string
		counts   map[string]int
		variable bool
	}{
		{"authenticate", grant, false},
		{"connect", merge(grant, map[string]int{"ConnectSession": 1, "SaveSession": 1}), false},
		{"read", controller, true},
		{"write", merge(controller, map[string]int{"TouchSession": 1, "SaveSession": 1}), false},
		{"sync", merge(controller, map[string]int{"UnreconciledSessionOperationCount": 1, "TouchSession": 1, "SaveSession": 1}), false},
		{"idle", merge(controller, map[string]int{"AcceptedSessionOperations": 1}), true},
		{"offer", merge(controller, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "SaveSession": 1}), false},
		{"begin", merge(controller, map[string]int{"SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1}), false},
		{"receipt", merge(controller, map[string]int{"SessionOperation": 1, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1}), false},
		{"refused-credential", merge(controller, map[string]int{"ProjectAccess": 0}), true},
	}
	plan := &nativeSocketPlan{profiles: map[string]string{}, uses: map[string]int{}}
	for _, definition := range definitions {
		name := fmt.Sprintf("native.channel-%d.%s", sequence, definition.name)
		f.backend.Declare(name, definition.counts, input, true)
		if !definition.variable {
			f.backend.ExpectUses(name, 0)
		}
		plan.profiles[definition.name] = name
		plan.names = append(plan.names, name)
	}
	f.backend.Require(plan.profiles["read"], 1)
	plan.uses["authenticate"], plan.uses["connect"] = 1, 1
	f.backend.ExpectUses(plan.profiles["authenticate"], 1)
	f.backend.ExpectUses(plan.profiles["connect"], 1)
	return plan
}

func (f *sessionHTTPFixture) expectControllerScope(t *testing.T, conn *websocket.Conn, kind string) {
	t.Helper()
	f.inputMu.Lock()
	plan := f.socketPlans[conn]
	if plan == nil || plan.profiles[kind] == "" {
		f.inputMu.Unlock()
		t.Fatal("native controller has no declared foreground plan")
	}
	plan.uses[kind]++
	count := plan.uses[kind]
	name := plan.profiles[kind]
	f.inputMu.Unlock()
	f.backend.ExpectUses(name, count)
}

func (f *sessionHTTPFixture) ControllerWrite(t *testing.T, conn *websocket.Conn, message sp.ControllerMessage) {
	t.Helper()
	input := f.InputSnapshot()
	if message.Type != "hello" && message.ControllerFence != input.Session.Snapshot.ControllerFence {
		t.Fatal("native controller producer used another Session fence")
	}
	if (message.Type == "operation_begin" && message.OperationID != input.OperationID) || (message.Type == "operation_receipt" && (message.Operation == nil || message.Operation.OperationID != input.OperationID)) {
		t.Fatal("native controller producer used another operation")
	}
	switch message.Type {
	case "hello":
	case "sync_state":
		f.expectControllerScope(t, conn, "sync")
	case "events", "heartbeat", "content_response":
		f.expectControllerScope(t, conn, "write")
	case "operation_begin":
		f.expectControllerScope(t, conn, "begin")
	case "operation_receipt":
		f.expectControllerScope(t, conn, "receipt")
	default:
		t.Fatalf("native controller message %q has no foreground contract", message.Type)
	}
	sessionWSWrite(t, conn, message)
}

func nativeBackgroundPlans() []string {
	return []string{"native.disconnect", "native.disconnect-failed", "native.credential-refusal", "native.controller-read"}
}

func (f *sessionHTTPFixture) controller(t *testing.T, epoch string, extraPlans ...string) (*websocket.Conn, sp.Snapshot) {
	t.Helper()
	gate := &nativeConnectGate{entered: make(chan nativeRouteConnection, 1), release: make(chan struct{})}
	t.Cleanup(gate.close)
	f.backend.Configure(func(*routeDAO) {
		f.inputMu.Lock()
		defer f.inputMu.Unlock()
		f.connectGate = gate
		f.expectedConnectionEpoch = strconv.FormatInt(numberNativeEpoch(f.input.Session.Snapshot.ConnectionEpoch)+1, 10)
		f.connectionStartedAt = time.Now()
	})
	plan := f.newControllerPlan()
	plans := append(slices.Clone(plan.names), extraPlans...)
	conn := sessionDial(t, f.server.URL, "/api/v1/controller-channel", f.grant.Token, f.backend.PlanHeader(plans...))
	f.inputMu.Lock()
	if f.socketPlans == nil {
		f.socketPlans = map[*websocket.Conn]*nativeSocketPlan{}
	}
	f.socketPlans[conn] = plan
	f.activeController = conn
	f.inputMu.Unlock()
	f.ControllerWrite(t, conn, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: f.snapshot.ControllerFence, SchemaVersion: 1, ProjectionVersion: 1, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: "0"})
	var connection nativeRouteConnection
	select {
	case connection = <-gate.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("ConnectSession did not reach the native response barrier")
	}
	if connection.SessionID != f.snapshot.SessionID || connection.Instance == "" || connection.Expiry == nil || !connection.Expiry.Equal(f.grant.ExpiresAt) {
		t.Fatal("ConnectSession proposed another native lease")
	}
	f.SetInput(func(input *nativeRouteInput) {
		input.Session.Snapshot.ConnectionEpoch = f.expectedConnectionEpoch
		input.Session.Snapshot.ConnectionState = "disconnected"
		input.Session.Snapshot.Synchronized = false
		input.Session.ServerInstance = &connection.Instance
		input.Session.ConnectionParent = f.handler.principal.CredentialID
		input.Session.ConnectionExpiry = &f.grant.ExpiresAt
		input.Session.LastSeen = &f.connectionStartedAt
		input.Session.SourceEpoch = &epoch
		input.Session.SourceEpochs = []string{epoch}
		input.Session.Consumed = true
	})
	gate.close()
	frame := sessionWSKind(t, conn, "welcome")
	snapshot, err := sp.DecodeSnapshot(frame["session"])
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ConnectionEpoch != f.expectedConnectionEpoch || snapshot.SessionID != connection.SessionID || snapshot.Synchronized {
		t.Fatal("native welcome did not match the independently supplied connection facts")
	}
	f.snapshot = snapshot
	f.SetInput(func(input *nativeRouteInput) { input.Session.Snapshot = snapshot })
	state := sp.State{NativeSessionID: snapshot.Identity.NativeSessionID, InitialInputState: snapshot.InitialInputState, Synchronized: true, Activity: "initializing"}
	f.ControllerWrite(t, conn, sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}})
	sessionWSKind(t, conn, "sync_ack")
	f.SelectNativeState(t, epoch, f.InputSnapshot().Session.SourceSeq, &state)
	return conn, snapshot
}

func (f *sessionHTTPFixture) SelectNativeState(t *testing.T, epoch string, sequence int64, state *sp.State) {
	t.Helper()
	f.inputMu.Lock()
	count := len(f.writes.Session)
	if count <= f.selectedSessionWrites {
		f.inputMu.Unlock()
		t.Fatal("native acknowledgement omitted its proposed Session write")
	}
	proposed := routeCopy(f.writes.Session[count-1])
	f.selectedSessionWrites = count
	f.inputMu.Unlock()
	if proposed.Snapshot.SessionID != f.snapshot.SessionID || proposed.SourceEpoch == nil || *proposed.SourceEpoch != epoch || proposed.SourceSeq != sequence {
		t.Fatalf("native acknowledgement lost expected source facts: %#v", proposed)
	}
	if state != nil && (proposed.Snapshot.InitialInputState != state.InitialInputState || !reflect.DeepEqual(proposed.Snapshot.Identity.NativeSessionID, state.NativeSessionID)) {
		t.Fatal("native acknowledgement lost the expected stable state facts")
	}
	f.SetInput(func(input *nativeRouteInput) {
		input.Session.SourceEpoch = &epoch
		input.Session.SourceSeq = sequence
		if state != nil {
			input.Session.Snapshot.InitialInputState = state.InitialInputState
			input.Session.Snapshot.Identity.NativeSessionID = state.NativeSessionID
		}
	})
}

func (f *sessionHTTPFixture) configureNativeDAO() {
	d := f.backend.DAO
	check := func(ok bool, operation string) {
		if !ok {
			f.backend.fail(fmt.Errorf("native fixture %s changed expected arguments", operation))
		}
	}
	d.LockCredentialFn = func(ctx context.Context, principal model.Principal, now time.Time) error {
		input := routeInputFor[nativeRouteInput](ctx)
		if err, present := input.CredentialErrors[principal.CredentialID]; present {
			return err
		}
		expected, present := input.Credentials[principal.CredentialID]
		check(present && expected == principal && !now.IsZero(), "credential")
		return nil
	}
	d.ProjectAccessFn = func(ctx context.Context, user, project string) (model.ProjectAccess, error) {
		input := routeInputFor[nativeRouteInput](ctx)
		check(project == input.ProjectID, "project access")
		if err, present := input.ProjectAccessErrors[user]; present {
			return model.ProjectAccess{}, err
		}
		value, present := input.ProjectAccess[user]
		check(present && value.UserID == user && value.ProjectID == project, "project access facts")
		return value, nil
	}
	d.LockTaskFn = func(ctx context.Context, project, task string) (store.SessionTask, error) {
		input := routeInputFor[nativeRouteInput](ctx)
		check(project == input.ProjectID && task == input.TaskID, "task")
		return input.Task, input.TaskError
	}
	d.LockTaskRegistrationFn = func(ctx context.Context, project, task string) error {
		input := routeInputFor[nativeRouteInput](ctx)
		check(project == input.ProjectID && task == input.TaskID, "registration lock")
		return nil
	}
	d.FindTaskRegistrationFn = func(ctx context.Context, project, registration, task, claim string) (string, error) {
		input := routeInputFor[nativeRouteInput](ctx)
		check(project == input.ProjectID && task == input.TaskID && registration == f.registration.RegistrationID && claim == f.registration.ClaimID, "registration lookup")
		return input.RegistrationID, input.RegistrationError
	}
	d.InsertTaskSessionFn = func(ctx context.Context, proposed store.SessionRegistration) error {
		input := routeInputFor[nativeRouteInput](ctx)
		check(proposed.Location.ProjectID == input.ProjectID && proposed.Location.TaskID == input.TaskID && proposed.OwnerID == f.handler.principal.UserID && proposed.RegistrationID == f.registration.RegistrationID, "registration insert")
		f.inputMu.Lock()
		defer f.inputMu.Unlock()
		if f.writes.Registration != nil {
			f.backend.fail(errors.New("native registration inserted twice"))
		}
		f.writes.Registration = new(routeCopy(proposed))
		return nil
	}
	d.SessionBotIDFn = func(ctx context.Context, id string) (*string, error) {
		input := routeInputFor[nativeRouteInput](ctx)
		check(id == input.SessionID, "association")
		if input.SessionError != nil {
			return nil, input.SessionError
		}
		check(input.Session != nil, "configured association")
		return input.Session.BotID, nil
	}
	d.LockSessionFn = func(ctx context.Context, id string) (store.SessionRecord, error) {
		input := routeInputFor[nativeRouteInput](ctx)
		check(id == input.SessionID, "session")
		if input.SessionError != nil {
			return store.SessionRecord{}, input.SessionError
		}
		check(input.Session != nil && input.Session.Snapshot.SessionID == id, "session facts")
		return *input.Session, nil
	}
	d.SaveSessionFn = func(ctx context.Context, proposed store.SessionRecord) error {
		input := routeInputFor[nativeRouteInput](ctx)
		check(proposed.Snapshot.SessionID == input.SessionID, "session write")
		check(proposed.Snapshot.Controls == nil && proposed.Snapshot.CurrentTurnID == nil && proposed.Snapshot.Activity == "unknown", "redacted session write")
		f.inputMu.Lock()
		f.writes.Session = append(f.writes.Session, routeCopy(proposed))
		gate := f.offerGate
		f.inputMu.Unlock()
		if gate != nil {
			gate.once.Do(func() { close(gate.entered) })
			select {
			case <-gate.release:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return nil
	}
	d.SessionLocationFn = func(ctx context.Context, id string) (store.SessionLocation, error) {
		input := routeInputFor[nativeRouteInput](ctx)
		check(id == input.SessionID, "location")
		return input.Location, input.LocationError
	}
	d.SessionLocationByGrantFn = func(ctx context.Context, hash []byte) (store.SessionLocation, error) {
		input := routeInputFor[nativeRouteInput](ctx)
		check(bytes.Equal(hash, input.GrantHash), "grant hash")
		return input.Location, input.GrantLocationError
	}
	d.CurrentTaskSessionFn = func(ctx context.Context, project, task, claim string) (string, error) {
		input := routeInputFor[nativeRouteInput](ctx)
		check(project == input.ProjectID && task == input.TaskID && claim == input.Task.Worker.ClaimID, "current claim")
		return input.CurrentSessionID, input.CurrentSessionError
	}
	d.SetSessionGrantFn = func(ctx context.Context, proposed store.SessionGrant) error {
		input := routeInputFor[nativeRouteInput](ctx)
		check(proposed.SessionID == input.SessionID && proposed.ParentCredentialID == f.handler.principal.CredentialID && len(proposed.Hash) == sha256.Size, "grant write")
		f.inputMu.Lock()
		defer f.inputMu.Unlock()
		f.writes.Grant = new(routeCopy(proposed))
		return nil
	}
	d.ConnectSessionFn = func(ctx context.Context, id, instance string, seen time.Time, expiry *time.Time) error {
		input := routeInputFor[nativeRouteInput](ctx)
		check(id == input.SessionID && instance != "" && expiry != nil && seen.Before(*expiry), "connection write")
		f.inputMu.Lock()
		proposed := nativeRouteConnection{SessionID: id, Instance: instance, Seen: seen, Expiry: expiry}
		f.writes.Connection = new(routeCopy(proposed))
		gate := f.connectGate
		f.inputMu.Unlock()
		if gate == nil {
			f.backend.fail(errors.New("native Connect requires an explicit response barrier"))
		}
		gate.entered <- proposed
		select {
		case <-gate.release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	d.TouchSessionFn = func(ctx context.Context, id string, seen time.Time) error {
		input := routeInputFor[nativeRouteInput](ctx)
		check(id == input.SessionID && !seen.IsZero(), "heartbeat write")
		return nil
	}
	d.DisconnectSessionFn = func(ctx context.Context, id string) error {
		input := routeInputFor[nativeRouteInput](ctx)
		check(id == input.SessionID, "disconnect")
		f.inputMu.Lock()
		defer f.inputMu.Unlock()
		f.writes.DisconnectAttempts = append(f.writes.DisconnectAttempts, id)
		return f.writes.DisconnectError
	}
	d.SessionOperationFn = func(ctx context.Context, session, operation string) (store.SessionOperation, error) {
		input := routeInputFor[nativeRouteInput](ctx)
		check(session == input.SessionID && operation == input.OperationID, "operation query")
		if input.OperationError != nil {
			return store.SessionOperation{}, input.OperationError
		}
		check(input.Operation != nil && input.Operation.OperationID == operation, "operation facts")
		return *input.Operation, nil
	}
	d.InsertSessionOperationFn = func(ctx context.Context, proposed store.SessionOperation) error {
		input := routeInputFor[nativeRouteInput](ctx)
		check(proposed.SessionID == input.SessionID && proposed.OperationID == input.OperationID && proposed.Command.OperationID == input.OperationID && proposed.Actor == f.handler.principal, "operation insert")
		f.inputMu.Lock()
		defer f.inputMu.Unlock()
		f.writes.Operations = append(f.writes.Operations, routeCopy(proposed))
		return nil
	}
	d.SetSessionOperationReceiptFn = func(ctx context.Context, proposed sp.Operation) error {
		input := routeInputFor[nativeRouteInput](ctx)
		check(proposed.SessionID == input.SessionID && proposed.OperationID == input.OperationID, "receipt write")
		f.inputMu.Lock()
		defer f.inputMu.Unlock()
		f.writes.Receipts = append(f.writes.Receipts, routeCopy(proposed))
		return nil
	}
	d.SetSessionOperationEpochFn = func(ctx context.Context, session, operation string, epoch int64) error {
		input := routeInputFor[nativeRouteInput](ctx)
		check(session == input.SessionID && operation == input.OperationID && epoch == numberNativeEpoch(input.Session.Snapshot.ConnectionEpoch), "dispatch epoch")
		f.inputMu.Lock()
		defer f.inputMu.Unlock()
		f.writes.Epochs = append(f.writes.Epochs, epoch)
		return nil
	}
	d.PendingSessionOperationCountFn = func(ctx context.Context, id string) (int, error) {
		input := routeInputFor[nativeRouteInput](ctx)
		check(id == input.SessionID, "pending query")
		return input.PendingCount, nil
	}
	d.AcceptedSessionOperationsFn = func(ctx context.Context, id string) ([]string, error) {
		input := routeInputFor[nativeRouteInput](ctx)
		check(id == input.SessionID, "accepted query")
		return input.AcceptedIDs, nil
	}
	d.UnreconciledSessionOperationsFn = func(ctx context.Context, id string, epoch int64) ([]string, error) {
		input := routeInputFor[nativeRouteInput](ctx)
		check(id == input.SessionID && epoch == numberNativeEpoch(input.Session.Snapshot.ConnectionEpoch), "unreconciled query")
		return input.UnreconciledIDs, nil
	}
	d.UnreconciledSessionOperationCountFn = func(ctx context.Context, id string, epoch int64) (int, error) {
		input := routeInputFor[nativeRouteInput](ctx)
		check(id == input.SessionID && epoch == numberNativeEpoch(input.Session.Snapshot.ConnectionEpoch), "unreconciled count")
		return input.UnreconciledCount, nil
	}
}

func numberNativeEpoch(value string) int64 {
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		panic(err)
	}
	return n
}

func (f *sessionHTTPFixture) declareNativeContracts() {
	input := func() any { return f.InputSnapshot() }
	browser := map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "SessionBotID": 1, "LockSession": 1}
	controller := map[string]int{"SessionLocation": 1, "LockTask": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "ProjectAccess": 1}
	merge := func(base, extra map[string]int) map[string]int {
		out := maps.Clone(base)
		for name, count := range extra {
			out[name] = count
		}
		return out
	}
	f.backend.Declare("native.register", map[string]int{"LockTaskRegistration": 1, "LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTaskRegistration": 1, "InsertTaskSession": 1}, input, false)
	f.backend.Declare("native.grant", merge(browser, map[string]int{"SetSessionGrant": 1, "SaveSession": 1}), input, false)
	f.backend.Declare("native.current", map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "CurrentTaskSession": 1, "SessionBotID": 1, "LockSession": 1}, input, false)
	f.backend.Declare("native.browser", browser, input, true)
	f.backend.Require("native.browser", 1)
	f.backend.Declare("native.browser-request", browser, input, false)
	f.backend.Declare("native.local-content", browser, input, true)
	f.backend.ExpectUses("native.local-content", 2)
	f.backend.Declare("native.operation", merge(browser, map[string]int{"SessionOperation": 1}), input, false)
	f.backend.Declare("native.submit", merge(browser, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1}), input, false)
	f.backend.Declare("native.submit-offline", merge(browser, map[string]int{"SessionOperation": 1}), input, false)
	f.backend.Declare("native.controller-read", controller, input, true)
	f.backend.Declare("native.disconnect", merge(controller, map[string]int{"DisconnectSession": 1, "SaveSession": 1}), input, true)
	f.backend.Declare("native.disconnect-failed", merge(controller, map[string]int{"DisconnectSession": 1}), input, true)
	f.backend.Declare("native.credential-refusal", merge(controller, map[string]int{"ProjectAccess": 0}), input, true)
}

func (f *sessionHTTPFixture) assertNoNativeContent(t *testing.T, markers ...string) {
	t.Helper()
	f.inputMu.Lock()
	writes := struct {
		Sessions   []store.SessionRecord
		Operations []store.SessionOperation
		Receipts   []sp.Operation
	}{routeCopy(f.writes.Session), routeCopy(f.writes.Operations), routeCopy(f.writes.Receipts)}
	f.inputMu.Unlock()
	raw, err := json.Marshal(writes)
	if err != nil {
		t.Fatal(err)
	}
	if len(writes.Sessions) == 0 {
		t.Fatal("native content test observed no proposed Session writes")
	}
	for _, marker := range markers {
		if bytes.Contains(raw, []byte(marker)) {
			t.Fatalf("private native content entered a proposed durable write: %q", marker)
		}
	}
}

func nativeIntentHash(command sp.Command) []byte {
	var payload any
	if err := json.Unmarshal(command.Payload, &payload); err != nil {
		panic(err)
	}
	body, err := json.Marshal(sp.BindingFields(command.Fence, map[string]any{"sessionId": command.SessionID, "claimId": command.ClaimID, "executionGeneration": command.ExecutionGeneration, "operationId": command.OperationID, "kind": command.Kind, "payload": payload}))
	if err != nil {
		panic(err)
	}
	hash := sha256.Sum256(body)
	return hash[:]
}

func (f *sessionHTTPFixture) SelectNativeOperation(t *testing.T, command sp.Command, receipt sp.Operation) {
	t.Helper()
	f.inputMu.Lock()
	if len(f.writes.Operations) == 0 {
		f.inputMu.Unlock()
		t.Fatal("accepted native operation omitted its proposed insert")
	}
	proposed := routeCopy(f.writes.Operations[len(f.writes.Operations)-1])
	f.inputMu.Unlock()
	hash := nativeIntentHash(command)
	if proposed.SessionID != command.SessionID || proposed.OperationID != command.OperationID || proposed.Actor != f.handler.principal || !bytes.Equal(proposed.Hash, hash) || receipt.State != "accepted" || !reflect.DeepEqual(proposed.Receipt, receipt) {
		t.Fatal("native accepted operation lost its actor, intent or receipt")
	}
	summary := command
	summary.RequestID = ""
	summary.Payload = json.RawMessage(`{}`)
	if !reflect.DeepEqual(proposed.Command, summary) {
		t.Fatal("native durable operation retained private command body or lost targeting fields")
	}
	response := store.SessionOperation{SessionID: command.SessionID, OperationID: command.OperationID, Command: summary, Receipt: receipt, Actor: f.handler.principal, Hash: hash, Deadline: time.Now().Add(time.Minute), Seq: 1}
	gate := &nativeOfferGate{entered: make(chan struct{}), release: make(chan struct{})}
	t.Cleanup(gate.close)
	f.inputMu.Lock()
	controller := f.activeController
	f.inputMu.Unlock()
	f.expectControllerScope(t, controller, "offer")
	f.SetInput(func(input *nativeRouteInput) {
		f.offerGate = gate
		input.OperationID = command.OperationID
		input.Operation = &response
		input.OperationError = nil
		input.PendingCount = 1
		input.AcceptedIDs = []string{command.OperationID}
		input.Session.OperationSeq = 1
	})
	select {
	case <-gate.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("native offer did not reach its declared write barrier")
	}
	f.SelectNativeReceipt(t, command.OperationID, "offered", numberNativeEpoch(f.snapshot.ConnectionEpoch))
	gate.close()
}

func (f *sessionHTTPFixture) SelectNativeReceipt(t *testing.T, operation, state string, epoch int64) {
	t.Helper()
	f.inputMu.Lock()
	if len(f.writes.Receipts) == 0 {
		f.inputMu.Unlock()
		t.Fatal("native operation acknowledgement omitted its proposed receipt")
	}
	proposed := routeCopy(f.writes.Receipts[len(f.writes.Receipts)-1])
	var proposedEpoch int64
	if len(f.writes.Epochs) != 0 {
		proposedEpoch = f.writes.Epochs[len(f.writes.Epochs)-1]
	}
	f.inputMu.Unlock()
	if proposed.OperationID != operation || proposed.State != state || proposedEpoch != epoch {
		t.Fatalf("native operation acknowledgement lost state/epoch: %#v %d", proposed, proposedEpoch)
	}
	f.SetInput(func(input *nativeRouteInput) {
		if input.Operation == nil || input.Operation.OperationID != operation {
			t.Fatal("native operation response was not selected before receipt")
		}
		input.Operation.Receipt.State = state
		input.Operation.Epoch = &epoch
		input.AcceptedIDs = []string{}
	})
}
