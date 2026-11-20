package task

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type threadForwardProbe struct {
	auth  model.CredentialAuthorization
	read  bool
	write bool
	cause error
}

func (s *threadForwardProbe) List(_ context.Context, a model.CredentialAuthorization, project, task string, input service.ThreadListRequest) (service.ThreadPageDocument, error) {
	if a != s.auth || project != "project" || task != "task" || input.Count != 3 {
		panic("read arguments changed")
	}
	s.read = true
	return service.ThreadPageDocument{JSON: []byte("page")}, s.cause
}
func (s *threadForwardProbe) Post(_ context.Context, a model.CredentialAuthorization, project, task string, input service.CreateThreadMessage) (service.ThreadMessageDocument, error) {
	if a != s.auth || project != "project" || task != "task" || input.Body != "body" {
		panic("write arguments changed")
	}
	s.write = true
	return service.ThreadMessageDocument{JSON: []byte("message")}, s.cause
}

func TestThreadHTTPAdapterPropagatesAuthorizationAndErrors(t *testing.T) {
	cause := errors.New("underlying refusal")
	auth := model.CredentialAuthorization{Principal: model.Principal{UserID: "caller"}}
	probe := &threadForwardProbe{auth: auth, cause: cause}
	adapter := authorizedThreadService{service: probe, auth: auth}
	page, err := adapter.List(t.Context(), auth.Principal, "project", "task", service.ThreadListRequest{Count: 3})
	if !probe.read || !errors.Is(err, cause) || string(page.JSON) != "page" {
		t.Fatalf("read: %+v %v", page, err)
	}
	message, err := adapter.Post(t.Context(), auth.Principal, "project", "task", service.CreateThreadMessage{Body: "body"})
	if !probe.write || !errors.Is(err, cause) || string(message.JSON) != "message" {
		t.Fatalf("post: %+v %v", message, err)
	}
	probe.read, probe.write = false, false
	foreign := model.Principal{UserID: "foreign"}
	_, readErr := adapter.List(t.Context(), foreign, "project", "task", service.ThreadListRequest{})
	_, postErr := adapter.Post(t.Context(), foreign, "project", "task", service.CreateThreadMessage{})
	if probe.read || probe.write || readErr == nil || postErr == nil {
		t.Fatalf("foreign identity reached service: %v %v", readErr, postErr)
	}
}

func TestScopedThreadHTTPReadAndFallback(t *testing.T) {
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"thread:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	auth := model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: "44444444-4444-4444-8444-444444444444", CredentialID: "55555555-5555-4555-8555-555555555555"}, Profile: model.ScopedPATProfile, Policy: &policy}
	probe := &httpThreadReadProbe{auth: auth}
	mux := http.NewServeMux()
	ScopedTaskThreadRoutes(mux, probe, threadScopedTestAuth{auth}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	path := "/api/v1/projects/11111111-1111-4111-8111-111111111111/tasks/22222222-2222-4222-8222-222222222222/thread/messages"
	for _, method := range []string{"GET", "HEAD"} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(method, path+"?count=3&details=true", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", method, w.Code, w.Body.String())
		}
	}
	if probe.calls != 2 {
		t.Fatalf("read calls %d", probe.calls)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("DELETE", path, nil))
	if w.Code != http.StatusMethodNotAllowed || probe.calls != 2 {
		t.Fatalf("fallback: %d", w.Code)
	}
}

func TestScopedThreadHTTPRejectsInvalidAuthorization(t *testing.T) {
	probe := &httpThreadReadProbe{}
	mux := http.NewServeMux()
	ScopedTaskThreadRoutes(mux, probe, threadScopedTestAuth{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/projects/11111111-1111-4111-8111-111111111111/tasks/22222222-2222-4222-8222-222222222222/thread/messages", nil))
	if w.Code != http.StatusUnauthorized || probe.calls != 0 {
		t.Fatalf("invalid authorization: %d %s", w.Code, w.Body.String())
	}
}

type httpThreadReadProbe struct {
	auth  model.CredentialAuthorization
	calls int
}

func (s *httpThreadReadProbe) List(_ context.Context, a model.CredentialAuthorization, project, task string, input service.ThreadListRequest) (service.ThreadPageDocument, error) {
	if a != s.auth || project != "11111111-1111-4111-8111-111111111111" || task != "22222222-2222-4222-8222-222222222222" || input.Count != 3 || !input.Details {
		panic("read arguments changed")
	}
	s.calls++
	return service.ThreadPageDocument{JSON: []byte(`{"items":[]}`)}, nil
}
func (*httpThreadReadProbe) Post(context.Context, model.CredentialAuthorization, string, string, service.CreateThreadMessage) (service.ThreadMessageDocument, error) {
	panic("unexpected write")
}

type threadScopedTestAuth struct{ auth model.CredentialAuthorization }

func (a threadScopedTestAuth) RequireAuthorization(h ThreadAuthorizedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { h(w, r, a.auth) }
}

func TestScopedThreadRouteClassification(t *testing.T) {
	var got []ThreadScopeRoute
	ScopedTaskThreadRoutesObserved(http.NewServeMux(), &threadScopedTestService{}, threadScopedTestAuth{}, slog.New(slog.NewTextHandler(io.Discard, nil)), func(route ThreadScopeRoute) { got = append(got, route) })
	const path = "/api/v1/projects/{projectId}/tasks/{taskId}/thread/messages"
	want := []ThreadScopeRoute{
		{Pattern: "GET " + path, Operations: []scopepolicy.Operation{scopepolicy.ThreadRead}},
		{Pattern: "HEAD " + path, Operations: []scopepolicy.Operation{scopepolicy.ThreadRead}},
		{Pattern: "POST " + path, Operations: []scopepolicy.Operation{scopepolicy.ThreadPost, scopepolicy.ThreadRead}, ReceiptOperations: []scopepolicy.Operation{scopepolicy.ThreadPost}},
		{Pattern: path, Fallback: true},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("routes: %#v", got)
	}
}

type threadScopedTestService struct {
	calls   int
	receipt bool
	auth    model.CredentialAuthorization
}

func (s *threadScopedTestService) List(context.Context, model.CredentialAuthorization, string, string, service.ThreadListRequest) (service.ThreadPageDocument, error) {
	return service.ThreadPageDocument{}, nil
}
func (s *threadScopedTestService) Post(_ context.Context, a model.CredentialAuthorization, project, task string, input service.CreateThreadMessage) (service.ThreadMessageDocument, error) {
	s.calls++
	if a != s.auth || project != "11111111-1111-4111-8111-111111111111" || task != "22222222-2222-4222-8222-222222222222" || input.Body != "new" {
		panic("request changed")
	}
	s.receipt = input.Receipt
	data := `{"id":"33333333-3333-4333-8333-333333333333","body":"new","author":{"displayName":"Name"}}`
	if input.Receipt {
		data = `{"projectId":"11111111-1111-4111-8111-111111111111","taskId":"22222222-2222-4222-8222-222222222222","messageId":"33333333-3333-4333-8333-333333333333"}`
	}
	return service.ThreadMessageDocument{Message: model.ThreadMessage{ID: "33333333-3333-4333-8333-333333333333"}, JSON: []byte(data)}, nil
}

func TestScopedThreadHTTPReceiptAndLegacyResponse(t *testing.T) {
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"thread:post"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	auth := model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: "44444444-4444-4444-8444-444444444444", CredentialID: "55555555-5555-4555-8555-555555555555"}, Profile: model.ScopedPATProfile, Policy: &policy}
	ops := &threadScopedTestService{auth: auth}
	mux := http.NewServeMux()
	ScopedTaskThreadRoutes(mux, ops, threadScopedTestAuth{auth}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, tc := range []struct {
		header  string
		status  int
		receipt bool
	}{{"", 201, false}, {"receipt-v1", 201, true}, {"unknown", 400, false}} {
		req := httptest.NewRequest("POST", "/api/v1/projects/11111111-1111-4111-8111-111111111111/tasks/22222222-2222-4222-8222-222222222222/thread/messages", strings.NewReader(`{"body":"new"}`))
		req.Header.Set("Content-Type", "application/json")
		if tc.header != "" {
			req.Header.Set("Daynight-Return", tc.header)
		}
		before := ops.calls
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		if w.Code != tc.status {
			t.Fatalf("%q: %d %s", tc.header, w.Code, w.Body.String())
		}
		if tc.status != 201 {
			if ops.calls != before {
				t.Fatal("invalid header reached business")
			}
			continue
		}
		if ops.calls != before+1 || ops.receipt != tc.receipt || (w.Header().Get("Daynight-Return") == "receipt-v1") != tc.receipt || strings.Contains(w.Body.String(), "displayName") == tc.receipt {
			t.Fatalf("%q: %d %s", tc.header, ops.calls, w.Body.String())
		}
	}
}
