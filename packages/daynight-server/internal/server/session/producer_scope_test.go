package session_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

func TestProducerRoutesClassifyActualRegistrations(t *testing.T) {
	f := newTestSessionRouteFixture(t)
	got := map[string]sessionhttp.ProducerRoute{}
	f.routes.RegisterRoutesWithProducerObserver(http.NewServeMux(), func(route sessionhttp.ProducerRoute) {
		if _, ok := got[route.Pattern]; ok {
			t.Fatalf("duplicate registration classification: %s", route.Pattern)
		}
		got[route.Pattern] = route
	})
	want := map[string]sessionhttp.ProducerRoute{}
	add := func(pattern string, route sessionhttp.ProducerRoute) { route.Pattern = pattern; want[pattern] = route }
	producer := sessionhttp.ProducerRoute{Operations: []scopepolicy.Operation{scopepolicy.SessionProduce}}
	independent := sessionhttp.ProducerRoute{IndependentProfile: true}
	fallback := sessionhttp.ProducerRoute{Fallback: true}
	for _, base := range []string{"/api/v1/projects/{projectId}/tasks/{taskId}/sessions", "/api/v1/test-sessions"} {
		add("POST "+base, producer)
		add("POST "+base+"/{sessionId}/controller-grant", producer)
		add(base, fallback)
		add(base+"/{sessionId}/controller-grant", fallback)
		if base == "/api/v1/test-sessions" {
			add("HEAD "+base, fallback)
		}
		session := base + "/{sessionId}"
		for _, suffix := range []string{"/image-uploads/{uploadId}", "/image-uploads/{uploadId}/content", "/image-uploads/{uploadId}/chunks"} {
			add("PUT "+session+suffix, producer)
		}
		add("POST "+session+"/image-uploads/{uploadId}/complete", producer)
		archive := session + "/archive"
		add("POST "+archive, producer)
		add("PUT "+archive, producer)
		add(archive, fallback)
		add("HEAD "+archive, fallback)
		for _, suffix := range []string{"/prepare", "/source-tail", "/seal"} {
			add("POST "+archive+suffix, producer)
		}
		for _, suffix := range []string{"/content", "/prepare/history/{fileId}", "/files/{fileId}"} {
			add("PUT "+archive+suffix, producer)
		}
		add("PUT "+session+"/image-history-ledger/{fileId}", independent)
		for _, method := range []string{"GET", "HEAD"} {
			add(method+" "+session+"/image-history-ledger/{fileId}/status", independent)
		}
	}
	add("GET /api/v1/controller-channel", independent)
	add("HEAD /api/v1/controller-channel", fallback)
	add("/api/v1/controller-channel", fallback)
	add("PUT /api/v1/controller-resources/{resourceId}", independent)
	add("/api/v1/controller-resources/{resourceId}", fallback)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("producer classifications: got %#v; want %#v", got, want)
	}
}

func TestProducerScopeRefusalsDoNotDeliverRegistrationOrGrant(t *testing.T) {
	f := newTestSessionRouteFixture(t)
	registration := independentRegistration("codex")
	sessionID := uuid.NewString()
	grant := sp.Grant{Protocol: sp.Protocol, TestExecutionID: registration.TestExecutionID, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"}
	denied := &model.Fault{Code: "insufficient_scope", Message: "The credential has insufficient scope."}
	f.expectNext("RegisterTest")
	f.expectNext("Grant")
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.RegisterTest = func(ctx context.Context, p model.Principal, input sp.TestRegistration) (sp.Snapshot, error) {
			f.requestContext(ctx, p, f.handler.principal)
			f.argument(input.RegistrationID == registration.RegistrationID, "registration identity")
			return sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: sessionID}}}, denied
		}
		c.Grant = func(ctx context.Context, p model.Principal, project, task, id string, input sp.Grant) (sessioncore.GrantResult, error) {
			f.requestContext(ctx, p, f.handler.principal)
			f.argument(project == "" && task == "" && id == sessionID && input.TestExecutionID == registration.TestExecutionID, "grant identity")
			return sessioncore.GrantResult{Token: "secret-not-delivered"}, denied
		}
	})
	for _, req := range []struct{ path, body string }{
		{"/api/v1/test-sessions", jsonBody(t, registration)},
		{"/api/v1/test-sessions/" + sessionID + "/controller-grant", jsonBody(t, grant)},
	} {
		w := f.request(http.MethodPost, req.path, req.body)
		if w.Code != http.StatusForbidden || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || !strings.Contains(w.Body.String(), `"code":"forbidden"`) || strings.Contains(w.Body.String(), sessionID) || strings.Contains(w.Body.String(), "secret-not-delivered") {
			t.Fatalf("scope refusal %s: %d %v %s", req.path, w.Code, w.Header(), w.Body.String())
		}
	}
}

func TestControllerScopeRefusalPrecedesUpgrade(t *testing.T) {
	f := newTestSessionRouteFixture(t)
	token := "dncontroller_" + uuid.NewString()
	f.expectNext("AuthenticateController")
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.AuthenticateController = func(_ context.Context, got string) error {
			f.argument(got == token, "controller token")
			return &model.Fault{Code: "insufficient_scope", Message: "The credential has insufficient scope."}
		}
	})
	r := httptest.NewRequest(http.MethodGet, "/api/v1/controller-channel", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || f.routes.ActiveConnections() != 0 {
		t.Fatalf("controller preflight: %d %v active=%d", w.Code, w.Header(), f.routes.ActiveConnections())
	}
}
