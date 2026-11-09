package session_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

type testRouteFacts struct {
	actor, parent     model.Principal
	record            store.SessionRecord
	registration      sp.TestRegistration
	registrationID    string
	registrationError error
	credentialError   error
	operation         store.SessionOperation
	operationError    error
	accepted          []string
}

type testRouteWrites struct {
	registration    *store.SessionRegistration
	session         *store.SessionRecord
	grant           *store.SessionGrant
	connection      *testRouteConnection
	operation       *store.SessionOperation
	receipt         *sp.Operation
	epoch           *int64
	stop            []byte
	disconnects     []string
	sessionSaves    int
	cleanupRefusals []error
	cleanupOutcomes []store.TransactionOutcome
}
type testRouteConnection struct {
	id, instance string
	seen         time.Time
	expiry       *time.Time
}

type testRouteGate struct {
	entered, release chan struct{}
	once             sync.Once
}

type testSessionRouteFixture struct {
	sessionHTTPShutdown
	t                *testing.T
	mu               sync.Mutex
	backend          *routeBackend
	auth             *routeAuthentication
	routes           *sessionhttp.Routes
	engine           *sessioncore.Engine
	handler          *resourceTestHandler
	server           *httptest.Server
	facts, connected testRouteFacts
	writes           testRouteWrites
	connectGate      *testRouteGate
	offerGate        *testRouteGate
	native           store.SessionRecord
	project, task    string
	controllerKnown  bool
	revokedSaves     int
}

func newTestSessionRouteFixture(t *testing.T) *testSessionRouteFixture {
	t.Helper()
	f := &testSessionRouteFixture{t: t, backend: newRouteBackend(t), project: uuid.NewString(), task: uuid.NewString()}
	f.server = httptest.NewUnstartedServer(nil)
	origin := "http://" + f.server.Listener.Addr().String()
	f.auth = newRouteAuthentication(t, origin)
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	f.facts.actor, f.facts.parent = principal, principal
	f.native = store.SessionRecord{Owner: principal.UserID, Snapshot: sp.Snapshot{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), ClaimID: uuid.NewString(), ExecutionGeneration: "1"}, ConnectionEpoch: "0"}, Identity: sp.Identity{ProjectID: f.project, TaskID: f.task, WorkerID: uuid.NewString(), WorktreeID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", AgentControlMode: "web"}, SessionRevision: "1", HistoryEpoch: uuid.NewString(), LastEventSeq: "0", LastTimelineSeq: "0", InitialInputState: "not_submitted", Lifecycle: "active", ConnectionState: "disconnected", Activity: "initializing"}}
	f.facts.registrationError, f.facts.operationError = model.ErrNotFound, model.ErrNotFound
	application := newRouteApplication(t, f.backend, f.auth, nil, testLogger(), 0)
	f.engine, f.routes = application.Engine, application.Routes
	f.handler = &resourceTestHandler{Handler: httpx.RequestLogging(testLogger(), application), principal: principal, token: f.auth.Credential(principal), backend: f.backend, authentication: f.auth, application: application}
	f.server.Config.Handler = f.handler.Handler
	f.configure()
	f.server.Start()
	t.Cleanup(f.server.Close)
	f.sessionHTTPShutdown.register(t, application.Shutdown)
	f.backend.OnFailure = func(error) { f.engine.CancelWork() }
	f.auth.OnFailure = f.backend.OnFailure
	return f
}

func (f *testSessionRouteFixture) input(connected bool) any {
	f.mu.Lock()
	defer f.mu.Unlock()
	value := f.facts
	if connected {
		value = f.connected
	}
	value.record = routeCopy(value.record)
	value.operation = routeCopy(value.operation)
	value.accepted = append([]string(nil), value.accepted...)
	return value
}

func (f *testSessionRouteFixture) declare(name string, calls map[string]int, connected, repeat bool) {
	f.backend.Declare(name, calls, func() any { return f.input(connected) }, repeat)
}

func (f *testSessionRouteFixture) configure() {
	read := map[string]int{"SessionBotID": 1, "LockSession": 1, "LockCredential": 2}
	f.declare("test-register", map[string]int{"LockCredential": 1, "LockTestOwner": 1, "FindTestRegistration": 1, "InsertTestSession": 1}, false, false)
	f.declare("test-read", read, false, false)
	f.declare("test-foreign-owner", map[string]int{"SessionBotID": 1, "LockSession": 1, "LockCredential": 1}, false, false)
	f.declare("test-wrong-scope", map[string]int{"SessionBotID": 1, "LockSession": 1}, false, false)
	f.declare("test-task-route", map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "SessionBotID": 1, "LockSession": 1}, false, false)
	f.declare("test-grant", mergeFixtureCalls(read, map[string]int{"SetSessionGrant": 1, "SaveSession": 1}), false, false)
	f.declare("test-stop", mergeFixtureCalls(read, map[string]int{"StoppingTestOperations": 1, "SetTestSessionStop": 1, "SaveSession": 1}), false, false)
	f.declare("test-stop-repeat", read, false, false)
	f.declare("test-stop-conflict", read, true, false)
	f.declare("test-offline-content", read, false, false)
	f.declare("test-browser", read, true, true)
	f.declare("test-browser-revoked", map[string]int{"SessionBotID": 1, "LockSession": 1, "LockCredential": 1}, true, true)
	grant := map[string]int{"SessionLocationByGrant": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 2}
	f.declare("test-controller-auth", grant, false, false)
	f.declare("test-controller-connect", mergeFixtureCalls(grant, map[string]int{"ConnectSession": 1, "SaveSession": 1}), false, false)
	controller := map[string]int{"SessionLocation": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 2}
	f.declare("test-controller-read", controller, true, true)
	f.declare("test-controller-idle", mergeFixtureCalls(controller, map[string]int{"AcceptedSessionOperations": 1}), true, true)
	f.declare("test-controller-sync", mergeFixtureCalls(controller, map[string]int{"UnreconciledSessionOperationCount": 1, "TouchSession": 1, "SaveSession": 1}), true, false)
	f.declare("test-controller-events", mergeFixtureCalls(controller, map[string]int{"TouchSession": 1, "SaveSession": 1}), true, false)
	f.declare("test-controller-revoked", map[string]int{"SessionLocation": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1}, true, true)
	f.declare("test-controller-disconnect", mergeFixtureCalls(controller, map[string]int{"DisconnectSession": 1, "SaveSession": 1}), true, false)
	f.declare("test-controller-revoked-cleanup", map[string]int{"SessionLocation": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1}, true, false)
	f.declare("test-command", mergeFixtureCalls(read, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1}), true, false)
	f.declare("test-controller-offer", mergeFixtureCalls(controller, map[string]int{"LockCredential": 4, "AcceptedSessionOperations": 1, "SessionOperation": 1, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "SaveSession": 1}), true, false)
	f.backend.ExpectUses("test-controller-disconnect", 0)
	f.backend.ExpectUses("test-controller-revoked-cleanup", 0)
	f.backend.Outcome("test-controller-revoked-cleanup", func(ctx context.Context, cause error) (store.Completion, error) {
		completion, err := f.backend.CompletionFn(ctx, cause)
		f.mu.Lock()
		f.writes.cleanupRefusals = append(f.writes.cleanupRefusals, cause)
		f.writes.cleanupOutcomes = append(f.writes.cleanupOutcomes, completion.Outcome)
		f.mu.Unlock()
		return completion, err
	})
	f.backend.Background("test-controller-disconnect", "test-controller-revoked-cleanup")
	f.backend.Configure(func(d *routeDAO) {
		d.LockCredentialFn = func(ctx context.Context, p model.Principal, now time.Time) error {
			in := routeInputFor[testRouteFacts](ctx)
			if (p != in.actor && p != in.parent) || now.IsZero() {
				f.t.Fatal("Test credential identity/time changed")
			}
			return in.credentialError
		}
		d.LockTestOwnerFn = func(ctx context.Context, id string) error {
			if id != routeInputFor[testRouteFacts](ctx).actor.UserID {
				f.t.Fatal("Test owner lock changed")
			}
			return nil
		}
		d.FindTestRegistrationFn = func(ctx context.Context, owner, registration, execution string) (string, *string, error) {
			in := routeInputFor[testRouteFacts](ctx)
			if owner != in.actor.UserID || registration != in.registration.RegistrationID || execution != in.registration.TestExecutionID {
				f.t.Fatal("Test registration lookup changed")
			}
			return in.registrationID, nil, in.registrationError
		}
		d.InsertTestSessionFn = func(ctx context.Context, in store.SessionRegistration) error {
			facts := routeInputFor[testRouteFacts](ctx)
			if in.OwnerID != facts.actor.UserID || in.ParentCredentialID != facts.actor.CredentialID || in.RegistrationID != facts.registration.RegistrationID || in.TestExecutionID != facts.registration.TestExecutionID || in.Location.ProjectID != "" || in.Location.TaskID != "" {
				f.t.Fatal("Test insertion lost independent identity")
			}
			f.mu.Lock()
			f.writes.registration = new(routeCopy(in))
			f.mu.Unlock()
			return nil
		}
		d.SessionBotIDFn = func(ctx context.Context, id string) (*string, error) { f.checkID(ctx, id); return nil, nil }
		d.LockSessionFn = func(ctx context.Context, id string) (store.SessionRecord, error) {
			f.checkID(ctx, id)
			return routeInputFor[testRouteFacts](ctx).record, nil
		}
		d.SessionLocationFn = func(ctx context.Context, id string) (store.SessionLocation, error) {
			f.checkID(ctx, id)
			return store.SessionLocation{SessionID: id}, nil
		}
		d.SessionLocationByGrantFn = func(ctx context.Context, hash []byte) (store.SessionLocation, error) {
			in := routeInputFor[testRouteFacts](ctx)
			if !bytes.Equal(hash, in.record.GrantHash) {
				f.t.Fatal("grant hash changed")
			}
			return store.SessionLocation{SessionID: in.record.Snapshot.SessionID}, nil
		}
		d.SaveSessionFn = func(ctx context.Context, in store.SessionRecord) error {
			f.checkID(ctx, in.Snapshot.SessionID)
			f.mu.Lock()
			f.writes.session = new(routeCopy(in))
			f.writes.sessionSaves++
			f.mu.Unlock()
			return nil
		}
		d.SetSessionGrantFn = func(ctx context.Context, in store.SessionGrant) error {
			f.checkID(ctx, in.SessionID)
			f.mu.Lock()
			f.writes.grant = new(routeCopy(in))
			f.mu.Unlock()
			return nil
		}
		d.ConnectSessionFn = func(ctx context.Context, id, instance string, seen time.Time, expiry *time.Time) error {
			f.checkID(ctx, id)
			f.mu.Lock()
			f.writes.connection = &testRouteConnection{id: id, instance: instance, seen: seen, expiry: expiry}
			gate := f.connectGate
			f.mu.Unlock()
			if gate == nil {
				f.t.Fatal("connection write has no observed gate")
			}
			close(gate.entered)
			select {
			case <-gate.release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		d.TouchSessionFn = func(ctx context.Context, id string, now time.Time) error {
			f.checkID(ctx, id)
			if now.IsZero() {
				f.t.Fatal("zero heartbeat")
			}
			return nil
		}
		d.DisconnectSessionFn = func(ctx context.Context, id string) error {
			f.checkID(ctx, id)
			f.mu.Lock()
			f.writes.disconnects = append(f.writes.disconnects, id)
			f.mu.Unlock()
			return nil
		}
		d.UnreconciledSessionOperationCountFn = func(ctx context.Context, id string, epoch int64) (int, error) {
			f.checkID(ctx, id)
			if epoch != 1 {
				f.t.Fatal("wrong Test connection epoch")
			}
			return 0, nil
		}
		d.StoppingTestOperationsFn = func(ctx context.Context, id string) ([]string, error) { f.checkID(ctx, id); return []string{}, nil }
		d.SetTestSessionStopFn = func(ctx context.Context, id string, proof []byte) error {
			f.checkID(ctx, id)
			f.mu.Lock()
			f.writes.stop = bytes.Clone(proof)
			f.mu.Unlock()
			return nil
		}
		d.LockTaskFn = func(_ context.Context, project, id string) (store.SessionTask, error) {
			if project != f.project || id != f.task {
				f.t.Fatal("Task route scope changed")
			}
			return store.SessionTask{Status: "in_progress"}, nil
		}
		d.ProjectAccessFn = func(ctx context.Context, user, project string) (model.ProjectAccess, error) {
			if user != routeInputFor[testRouteFacts](ctx).actor.UserID || project != f.project {
				f.t.Fatal("Task access identity changed")
			}
			return model.ProjectAccess{UserID: user, ProjectID: project, Role: model.ProjectAdmin}, nil
		}
		d.SessionOperationFn = func(ctx context.Context, session, id string) (store.SessionOperation, error) {
			f.checkID(ctx, session)
			in := routeInputFor[testRouteFacts](ctx)
			if in.operationError == nil && id != in.operation.OperationID {
				f.t.Fatal("operation read identity changed")
			}
			return in.operation, in.operationError
		}
		d.PendingSessionOperationCountFn = func(ctx context.Context, id string) (int, error) { f.checkID(ctx, id); return 0, nil }
		d.InsertSessionOperationFn = func(ctx context.Context, in store.SessionOperation) error {
			f.checkID(ctx, in.SessionID)
			if in.Actor != routeInputFor[testRouteFacts](ctx).actor {
				f.t.Fatal("command actor changed")
			}
			f.mu.Lock()
			f.writes.operation = new(routeCopy(in))
			f.mu.Unlock()
			return nil
		}
		d.AcceptedSessionOperationsFn = func(ctx context.Context, id string) ([]string, error) {
			f.checkID(ctx, id)
			return routeInputFor[testRouteFacts](ctx).accepted, nil
		}
		d.SetSessionOperationEpochFn = func(ctx context.Context, session, id string, epoch int64) error {
			f.checkID(ctx, session)
			if id != routeInputFor[testRouteFacts](ctx).operation.OperationID || epoch != 1 {
				f.t.Fatal("offer epoch identity changed")
			}
			f.mu.Lock()
			f.writes.epoch = &epoch
			f.mu.Unlock()
			return nil
		}
		d.SetSessionOperationReceiptFn = func(ctx context.Context, receipt sp.Operation) error {
			if receipt.OperationID != routeInputFor[testRouteFacts](ctx).operation.OperationID {
				f.t.Fatal("offer receipt identity changed")
			}
			f.mu.Lock()
			f.writes.receipt = new(routeCopy(receipt))
			gate := f.offerGate
			f.mu.Unlock()
			if gate == nil {
				f.t.Fatal("operation receipt has no observed gate")
			}
			close(gate.entered)
			select {
			case <-gate.release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	})
}

func mergeFixtureCalls(a, b map[string]int) map[string]int {
	result := make(map[string]int, len(a)+len(b))
	for k, v := range a {
		result[k] = v
	}
	for k, v := range b {
		result[k] = v
	}
	return result
}

func (f *testSessionRouteFixture) checkID(ctx context.Context, id string) {
	if id != routeInputFor[testRouteFacts](ctx).record.Snapshot.SessionID {
		f.t.Fatal("Test Session identity changed")
	}
}

func (f *testSessionRouteFixture) request(method, path, body string, scopes ...string) *httptest.ResponseRecorder {
	return f.requestAs(f.handler, method, path, body, scopes...)
}
func (f *testSessionRouteFixture) requestAs(h *resourceTestHandler, method, path, body string, scopes ...string) *httptest.ResponseRecorder {
	return projectRequest(h, method, path, body, scopes...)
}

func (f *testSessionRouteFixture) registration(t *testing.T, input sp.TestRegistration) sp.Snapshot {
	t.Helper()
	f.mu.Lock()
	f.facts.registration = input
	f.facts.registrationID, f.facts.registrationError = "", model.ErrNotFound
	f.mu.Unlock()
	result := decodeResponse[struct {
		Session sp.Snapshot `json:"session"`
	}](t, f.request(http.MethodPost, "/api/v1/test-sessions", jsonBody(t, input), "test-register"), http.StatusOK).Session
	f.mu.Lock()
	defer f.mu.Unlock()
	in := f.writes.registration
	if in == nil || in.Location.SessionID != result.SessionID || in.TestExecutionID != result.TestExecutionID {
		t.Fatal("registration result did not match proposed independent Session")
	}
	f.facts.record = store.SessionRecord{Snapshot: routeCopy(in.Snapshot), Owner: in.OwnerID, Parent: in.ParentCredentialID, Registration: bytes.Clone(in.Registration)}
	f.facts.registrationID, f.facts.registrationError = result.SessionID, nil
	f.writes.registration = nil
	return result
}

func (f *testSessionRouteFixture) selectSession(t *testing.T, connected bool) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	in := f.writes.session
	target := &f.facts
	if connected {
		target = &f.connected
	}
	if in == nil || in.Snapshot.SessionID != target.record.Snapshot.SessionID {
		t.Fatal("ledger proposal changed selected Test identity")
	}
	target.record.Snapshot = routeCopy(in.Snapshot)
	target.record.SourceEpoch, target.record.SourceEpochs = in.SourceEpoch, append([]string(nil), in.SourceEpochs...)
	target.record.SourceSeq, target.record.OperationSeq = in.SourceSeq, in.OperationSeq
	f.writes.session = nil
}

func (f *testSessionRouteFixture) grant(t *testing.T, snapshot sp.Snapshot, controller, instance string) sessioncore.GrantResult {
	t.Helper()
	path := "/api/v1/test-sessions/" + snapshot.SessionID + "/controller-grant"
	result := decodeResponse[sessioncore.GrantResult](t, f.request(http.MethodPost, path, jsonBody(t, sp.Grant{Protocol: sp.Protocol, TestExecutionID: snapshot.TestExecutionID, ControllerID: controller, ControllerInstanceID: instance, ExecutionGeneration: "1", Kind: "bootstrap"}), "test-grant"), http.StatusOK)
	f.selectSession(t, false)
	f.mu.Lock()
	defer f.mu.Unlock()
	in := f.writes.grant
	hash := sha256.Sum256([]byte(result.Token))
	if in == nil || !bytes.Equal(in.Hash, hash[:]) || in.SessionID != snapshot.SessionID {
		t.Fatal("grant result changed captured identity/hash")
	}
	f.facts.record.GrantHash, f.facts.record.GrantExpiry, f.facts.record.GrantKind = bytes.Clone(in.Hash), &in.ExpiresAt, in.Kind
	f.writes.grant = nil
	return result
}

func (f *testSessionRouteFixture) prepareConnection(t *testing.T, snapshot sp.Snapshot, epoch string) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.facts.record.Snapshot.SessionID != snapshot.SessionID || f.facts.record.GrantExpiry == nil {
		t.Fatal("connection facts require the asserted grant")
	}
	now := time.Now()
	f.connected = f.facts
	f.connected.record = routeCopy(f.facts.record)
	f.connected.record.Snapshot.ConnectionEpoch = "1"
	f.connected.record.SourceEpoch, f.connected.record.SourceEpochs = &epoch, []string{epoch}
	f.connected.record.LastSeen = &now
	f.connected.record.ConnectionExpiry = f.facts.record.GrantExpiry
	f.connected.record.ConnectionParent, f.connected.record.Consumed = f.facts.parent.CredentialID, true
	gate := &testRouteGate{entered: make(chan struct{}), release: make(chan struct{})}
	f.connectGate = gate
	t.Cleanup(func() { gate.once.Do(func() { close(gate.release) }) })
}

func (f *testSessionRouteFixture) admitConnection(t *testing.T) {
	t.Helper()
	// SourceSeq runs before welcome; its next scope needs the relay identity
	// observed at ConnectSession before that callback can return.
	f.mu.Lock()
	gate := f.connectGate
	f.mu.Unlock()
	select {
	case <-gate.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("controller did not propose a connection")
	}
	f.mu.Lock()
	in := f.writes.connection
	if in == nil || in.id != f.connected.record.Snapshot.SessionID || in.instance == "" || in.expiry == nil {
		f.mu.Unlock()
		t.Fatal("connection proposal lost relay identity/expiry")
	}
	f.connected.record.ServerInstance = &in.instance
	f.connected.record.LastSeen, f.connected.record.ConnectionExpiry = &in.seen, in.expiry
	f.mu.Unlock()
	gate.once.Do(func() { close(gate.release) })
}

func (f *testSessionRouteFixture) selectConnection(t *testing.T, snapshot sp.Snapshot) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	connection, saved := f.writes.connection, f.writes.session
	if connection == nil || saved == nil || connection.id != snapshot.SessionID || saved.Snapshot.ControllerFence != snapshot.ControllerFence || connection.expiry == nil {
		t.Fatal("controller welcome did not match proposed connection")
	}
	f.connected.record.Snapshot = routeCopy(saved.Snapshot)
	f.connected.record.SourceEpoch, f.connected.record.SourceEpochs = saved.SourceEpoch, append([]string(nil), saved.SourceEpochs...)
	f.connected.record.SourceSeq = saved.SourceSeq
	f.connected.record.ServerInstance = &connection.instance
	f.connected.record.LastSeen, f.connected.record.ConnectionExpiry = &connection.seen, connection.expiry
	f.facts = f.connected
	f.writes.connection, f.writes.session = nil, nil
}

func (f *testSessionRouteFixture) selectStop(t *testing.T, result sp.Snapshot) {
	t.Helper()
	f.selectSession(t, false)
	f.mu.Lock()
	defer f.mu.Unlock()
	if result.Lifecycle != "archived" || f.facts.record.Snapshot.Lifecycle != "archived" || len(f.writes.stop) == 0 {
		t.Fatal("stop result did not match archived ledger and stop proof")
	}
	f.facts.record.StopProof = bytes.Clone(f.writes.stop)
	f.writes.stop = nil
}

func (f *testSessionRouteFixture) revoke(t *testing.T) {
	t.Helper()
	f.backend.ExpectUses("test-controller-disconnect", 0)
	f.backend.ExpectUses("test-controller-revoked-cleanup", 1)
	f.mu.Lock()
	if !f.controllerKnown {
		f.mu.Unlock()
		t.Fatal("credential revocation requires the observed controller")
	}
	f.revokedSaves = f.writes.sessionSaves
	f.facts.credentialError, f.connected.credentialError = model.ErrNotFound, model.ErrNotFound
	f.mu.Unlock()
	f.auth.RejectCredential(f.handler.token, model.ErrNotFound)
	f.expectShutdownError = func(err error) bool { return shutdownFaultMatches(err, "unauthenticated") }
}

func (f *testSessionRouteFixture) expectControllerCleanup(t *testing.T) {
	t.Helper()
	f.mu.Lock()
	if f.controllerKnown {
		f.mu.Unlock()
		t.Fatal("controller cleanup is already configured")
	}
	f.controllerKnown = true
	f.mu.Unlock()
	f.backend.ExpectUses("test-controller-disconnect", 1)
}

func (f *testSessionRouteFixture) requireNoControllerCleanup(t *testing.T) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.controllerKnown || len(f.writes.disconnects) != 0 {
		t.Fatal("never-connected Session performed controller cleanup")
	}
}

func (f *testSessionRouteFixture) sessionSaveCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.writes.sessionSaves
}

func (f *testSessionRouteFixture) requireControllerCleanup(t *testing.T, previousSaves int) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.controllerKnown || len(f.writes.disconnects) != 1 || f.writes.disconnects[0] != f.connected.record.Snapshot.SessionID || f.writes.sessionSaves != previousSaves+1 || f.writes.session == nil || f.writes.session.Snapshot.ControllerFence != f.connected.record.Snapshot.ControllerFence {
		t.Fatalf("controller cleanup did not propose exactly one disconnect and ledger save: disconnects=%v saves=%d previous=%d", f.writes.disconnects, f.writes.sessionSaves, previousSaves)
	}
}

func (f *testSessionRouteFixture) requireRevokedControllerCleanup(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	if err := f.routes.Shutdown(ctx); err != nil && !shutdownFaultMatches(err, "unauthenticated") {
		t.Fatalf("revoked controller drain failed: %v", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.writes.disconnects) != 0 || f.writes.sessionSaves != f.revokedSaves {
		t.Fatal("revoked controller cleanup proposed a disconnect or ledger save")
	}
	if len(f.writes.cleanupRefusals) != 1 || !shutdownFaultMatches(f.writes.cleanupRefusals[0], "unauthenticated") || len(f.writes.cleanupOutcomes) != 1 || f.writes.cleanupOutcomes[0] != store.TransactionNotCommitted {
		t.Fatal("revoked controller cleanup did not observe exactly one refused, uncommitted callback")
	}
}

func (f *testSessionRouteFixture) prepareOffer(t *testing.T) {
	t.Helper()
	f.mu.Lock()
	gate := &testRouteGate{entered: make(chan struct{}), release: make(chan struct{})}
	f.offerGate = gate
	f.mu.Unlock()
	t.Cleanup(func() { gate.once.Do(func() { close(gate.release) }) })
}

func (f *testSessionRouteFixture) admitOffer(t *testing.T) {
	t.Helper()
	// The offer is written after the polling transaction. Selecting the next
	// query reply at this barrier keeps delayed readers from enabling a replay.
	f.mu.Lock()
	gate := f.offerGate
	f.mu.Unlock()
	select {
	case <-gate.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("controller did not propose the offered operation")
	}
	f.mu.Lock()
	if f.writes.receipt == nil || f.writes.receipt.State != "offered" || f.writes.epoch == nil || *f.writes.epoch != 1 {
		f.mu.Unlock()
		t.Fatal("offer did not propose the matching receipt/epoch")
	}
	f.connected.operation.Receipt, f.connected.operation.Epoch = routeCopy(*f.writes.receipt), f.writes.epoch
	f.connected.accepted = nil
	f.facts = f.connected
	f.mu.Unlock()
	gate.once.Do(func() { close(gate.release) })
}
