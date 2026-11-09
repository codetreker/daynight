package session_test

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

type testRouteContextKey struct{}

type testSessionRouteFixture struct {
	sessionHTTPShutdown
	t                 *testing.T
	calls             *routeBackend
	auth              *routeAuthentication
	routes            *sessionhttp.Routes
	handler           *resourceTestHandler
	server            *httptest.Server
	contextMarker     *int
	mu                sync.Mutex
	controllerContext context.Context
	disconnectErrors  []error
}

func newTestSessionRouteFixture(t *testing.T) *testSessionRouteFixture {
	t.Helper()
	f := &testSessionRouteFixture{t: t, calls: newRouteBackend(t), contextMarker: new(int)}
	f.server = httptest.NewUnstartedServer(nil)
	origin := "http://" + f.server.Listener.Addr().String()
	f.auth = newRouteAuthentication(t, origin)
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	app := newRouteApplication(t, f.calls, f.auth, testLogger(), 0)
	f.routes = app.Routes
	f.handler = &resourceTestHandler{Handler: httpx.RequestLogging(testLogger(), app), token: f.auth.Credential(principal), principal: principal, backend: f.calls, authentication: f.auth, application: app}
	f.server.Config.Handler = f.handler.Handler
	f.calls.ExpectCalls("Disconnect", 0)
	f.server.Start()
	t.Cleanup(f.server.Close)
	f.sessionHTTPShutdown.register(t, app.Shutdown)
	return f
}

func (f *testSessionRouteFixture) argument(valid bool, label string) {
	f.t.Helper()
	if valid {
		return
	}
	err := fmt.Errorf("Test Session usecase arguments changed: %s", label)
	f.t.Error(err)
	f.calls.mu.Lock()
	failure := f.calls.OnFailure
	f.calls.mu.Unlock()
	if failure != nil {
		failure(err)
	}
	panic(err)
}
func (f *testSessionRouteFixture) requestContext(ctx context.Context, p, expected model.Principal) {
	f.argument(ctx != nil && ctx.Err() == nil && ctx.Value(testRouteContextKey{}) == f.contextMarker, "request context")
	f.argument(p == expected, "principal")
}
func (f *testSessionRouteFixture) expectNext(name string) {
	f.calls.ExpectCalls(name, f.calls.Called(name)+1)
}
func (f *testSessionRouteFixture) request(method, path, body string) *httptest.ResponseRecorder {
	return f.requestAs(f.handler, method, path, body)
}
func (f *testSessionRouteFixture) requestAs(h *resourceTestHandler, method, path, body string) *httptest.ResponseRecorder {
	f.auth.ExpectCalls(1)
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r = r.WithContext(context.WithValue(r.Context(), testRouteContextKey{}, f.contextMarker))
	authorizeResourceRequest(h, r)
	r.Header.Set("Content-Type", "application/json; charset=UTF-8")
	r.Header.Set("X-Request-ID", "project-test")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func suppliedTestSnapshot(p model.Principal, registration sp.TestRegistration) sp.Snapshot {
	return sp.Snapshot{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), TestExecutionID: registration.TestExecutionID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"}, Identity: sp.Identity{OwnerUserID: p.UserID, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, Provider: registration.Provider, AgentControlMode: "web"}, SessionRevision: "1", HistoryEpoch: uuid.NewString(), LastEventSeq: "0", LastTimelineSeq: "0", InitialInputState: "not_required", Lifecycle: "active", ConnectionState: "disconnected", Activity: "initializing"}
}

func (f *testSessionRouteFixture) registration(t *testing.T, input sp.TestRegistration, reply sp.Snapshot) sp.Snapshot {
	t.Helper()
	f.expectNext("RegisterTest")
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.RegisterTest = func(ctx context.Context, p model.Principal, actual sp.TestRegistration) (sp.Snapshot, error) {
			f.requestContext(ctx, p, f.handler.principal)
			f.argument(reflect.DeepEqual(actual, input), "registration")
			return routeCopy(reply), nil
		}
	})
	result := decodeResponse[struct {
		Session sp.Snapshot `json:"session"`
	}](t, f.request(http.MethodPost, "/api/v1/test-sessions", jsonBody(t, input)), http.StatusOK).Session
	if !reflect.DeepEqual(result, reply) {
		t.Fatalf("registration response changed supplied snapshot: %+v", result)
	}
	return result
}

func (f *testSessionRouteFixture) controller(t *testing.T, snapshot, connected sp.Snapshot, registration sp.TestRegistration) (*websocket.Conn, sp.Snapshot) {
	t.Helper()
	grantInput := sp.Grant{Protocol: sp.Protocol, TestExecutionID: snapshot.TestExecutionID, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"}
	grant := sessioncore.GrantResult{TestExecutionID: snapshot.TestExecutionID, Token: "dncontroller_" + uuid.NewString(), ExpiresAt: time.Now().UTC().Add(2 * time.Minute), SessionID: snapshot.SessionID, ExecutionGeneration: "1", ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID}
	f.expectNext("Grant")
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.Grant = func(ctx context.Context, p model.Principal, project, task, id string, actual sp.Grant) (sessioncore.GrantResult, error) {
			f.requestContext(ctx, p, f.handler.principal)
			f.argument(project == "" && task == "" && id == snapshot.SessionID && reflect.DeepEqual(actual, grantInput), "independent grant scope/body")
			return grant, nil
		}
	})
	got := decodeResponse[sessioncore.GrantResult](t, f.request(http.MethodPost, "/api/v1/test-sessions/"+snapshot.SessionID+"/controller-grant", jsonBody(t, grantInput)), http.StatusOK)
	if !reflect.DeepEqual(got, grant) {
		t.Fatal("grant response changed supplied usecase result")
	}
	sourceEpoch := uuid.NewString()
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, SchemaVersion: 1, ProjectionVersion: 1, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, Provider: registration.Provider, SourceEpoch: sourceEpoch, LastAckedSourceSeq: "0"}
	helloWire := []byte(jsonBody(t, hello))
	f.calls.ExpectCalls("Disconnect", 1)
	f.calls.AllowRepeated("Poll")
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.AuthenticateController = func(ctx context.Context, token string) error {
			f.argument(ctx != nil && ctx.Err() == nil && token == grant.Token, "controller authentication")
			return nil
		}
		c.Connect = func(ctx context.Context, token string, actual sp.ControllerMessage, instance string) (sp.Snapshot, error) {
			nonce, err := uuid.Parse(instance)
			f.argument(ctx != nil && ctx.Err() == nil && token == grant.Token && actual.Type == "hello" && actual.Protocol == hello.Protocol && actual.Fence == hello.Fence && actual.ConnectionEpoch == "" && actual.SchemaVersion == 1 && actual.ProjectionVersion == 1 && actual.ControllerID == hello.ControllerID && actual.ControllerInstanceID == hello.ControllerInstanceID && actual.Provider == hello.Provider && actual.SourceEpoch == hello.SourceEpoch && actual.LastAckedSourceSeq == "0" && bytes.Equal(actual.Raw, helloWire) && err == nil && nonce.String() == instance, "controller hello/instance")
			f.mu.Lock()
			f.controllerContext = ctx
			f.mu.Unlock()
			return routeCopy(connected), nil
		}
		c.SourceSeq = func(ctx context.Context, fence sp.ControllerFence) (int64, error) {
			f.controllerScope(ctx, fence, connected.ControllerFence)
			return 0, nil
		}
		c.Poll = func(ctx context.Context, fence sp.ControllerFence) ([]map[string]any, error) {
			f.controllerScope(ctx, fence, connected.ControllerFence)
			return []map[string]any{}, nil
		}
		c.Disconnect = func(ctx context.Context, fence sp.ControllerFence) error {
			f.disconnectScope(ctx, fence, connected.ControllerFence, nil)
			return nil
		}
	})
	controller := sessionDial(t, f.server.URL, "/api/v1/controller-channel", grant.Token, nil)
	sessionWSWrite(t, controller, hello)
	welcome := sessionWSKind(t, controller, "welcome")
	actual, err := sp.DecodeSnapshot(welcome["session"])
	if err != nil || !reflect.DeepEqual(actual, connected) {
		t.Fatal("welcome changed supplied connection snapshot", err)
	}
	return controller, actual
}

func (f *testSessionRouteFixture) controllerScope(ctx context.Context, fence, expected sp.ControllerFence) {
	f.mu.Lock()
	expectedContext := f.controllerContext
	f.mu.Unlock()
	f.argument(ctx != nil && ctx == expectedContext && fence == expected, "controller context/fence")
}
func (f *testSessionRouteFixture) disconnectScope(ctx context.Context, fence, expected sp.ControllerFence, result error) {
	f.argument(ctx != nil, "disconnect context")
	f.mu.Lock()
	controllerContext := f.controllerContext
	f.mu.Unlock()
	deadline, bounded := ctx.Deadline()
	f.argument(ctx.Err() == nil && ctx != controllerContext && bounded && deadline.After(time.Now()) && fence == expected, "bounded disconnect context/fence")
	f.mu.Lock()
	f.disconnectErrors = append(f.disconnectErrors, result)
	f.mu.Unlock()
}
func (f *testSessionRouteFixture) requireCleanup(t *testing.T, expected error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	if err := f.routes.Shutdown(ctx); err != nil && (expected == nil || !shutdownFaultMatches(err, "unauthenticated")) {
		t.Fatal("controller drain failed", err)
	}
	count := f.calls.Called("Disconnect")
	f.mu.Lock()
	defer f.mu.Unlock()
	if count != 1 || len(f.disconnectErrors) != 1 || f.disconnectErrors[0] != expected {
		t.Fatal("connected controller did not perform exactly one configured cleanup")
	}
}
func (f *testSessionRouteFixture) revokeAuthentication() {
	f.auth.RejectCredential(f.handler.token, authhttp.Failure())
	f.expectShutdownError = func(err error) bool { return shutdownFaultMatches(err, "unauthenticated") }
}
