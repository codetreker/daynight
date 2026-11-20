package task

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type stepScopeHTTPAuth struct{ a model.CredentialAuthorization }

func (a stepScopeHTTPAuth) RequireScoped(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { next(w, r, a.a) }
}

type stepScopeHTTPProbe struct {
	ScopedStepService
	t    *testing.T
	a    model.CredentialAuthorization
	fail bool
	seen string
}

func (s *stepScopeHTTPProbe) check(a model.CredentialAuthorization, name string) error {
	s.t.Helper()
	if a.Principal != s.a.Principal || a.Policy != s.a.Policy {
		s.t.Fatalf("authorization changed: %+v", a)
	}
	s.seen = name
	if s.fail {
		return &model.Fault{Code: "insufficient_scope", Message: "The credential has insufficient scope."}
	}
	return nil
}
func (s *stepScopeHTTPProbe) List(_ context.Context, a model.CredentialAuthorization, _, _ string) (taskservice.StepsDocument, error) {
	err := s.check(a, "list")
	return taskservice.StepsDocument{JSON: []byte(`{"steps":[]}`)}, err
}
func (s *stepScopeHTTPProbe) Add(_ context.Context, a model.CredentialAuthorization, _, _ string, input taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
	err := s.check(a, "add")
	if input.Version != 1 || input.ID != "abcdef12" {
		s.t.Fatalf("input changed: %+v", input)
	}
	if err != nil {
		return taskservice.StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}, err
	}
	return taskservice.StepsWriteResult{StepsDocument: taskservice.StepsDocument{JSON: []byte(`{"version":2,"steps":[]}`)}, Changed: true, TransactionOutcome: store.TransactionCommitted}, nil
}
func TestScopedStepRoutesPassAuthorizationAndMapRefusal(t *testing.T) {
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"step:read", "step:write"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	a := model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}, Profile: model.ScopedPATProfile, Policy: &policy}
	probe := &stepScopeHTTPProbe{t: t, a: a}
	mux := http.NewServeMux()
	TaskStepsScopedRoutes(mux, probe, stepScopeHTTPAuth{a}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	path := "/api/v1/projects/33333333-3333-4333-8333-333333333333/tasks/44444444-4444-4444-8444-444444444444/steps"
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
	if w.Code != 200 || probe.seen != "list" || w.Body.String() != `{"steps":[]}` {
		t.Fatalf("read: %d %s", w.Code, w.Body)
	}
	post := func() *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", path, strings.NewReader(`{"version":1,"id":"abcdef12","title":"new"}`))
		req.Header.Set("Content-Type", "application/json")
		mux.ServeHTTP(w, req)
		return w
	}
	w = post()
	if w.Code != 201 || probe.seen != "add" || w.Body.String() != `{"version":2,"steps":[]}` || !strings.HasSuffix(w.Header().Get("Location"), "/steps/abcdef12") {
		t.Fatalf("write: %d %s", w.Code, w.Body)
	}
	probe.fail = true
	w = post()
	if w.Code != 403 || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || !strings.Contains(w.Body.String(), `"code":"forbidden"`) {
		t.Fatalf("refusal: %d %s", w.Code, w.Body)
	}
}

func TestScopedStepRouteInventoryMatchesMountedPatterns(t *testing.T) {
	mux := http.NewServeMux()
	var entries []StepScopeRoute
	TaskStepsScopedRoutes(mux, &stepScopeHTTPProbe{t: t}, stepScopeHTTPAuth{}, slog.New(slog.NewTextHandler(io.Discard, nil)), func(route StepScopeRoute) { entries = append(entries, route) })
	const path = "/api/v1/projects/{projectId}/tasks/{taskId}/steps"
	expected := map[string][]scopepolicy.Operation{
		"GET " + path: {scopepolicy.StepRead}, "HEAD " + path: {scopepolicy.StepRead},
		"GET " + path + "/{stepId}": {scopepolicy.StepRead}, "HEAD " + path + "/{stepId}": {scopepolicy.StepRead},
		"POST " + path:                       {scopepolicy.StepWrite, scopepolicy.StepRead},
		"PATCH " + path + "/{stepId}":        {scopepolicy.StepWrite, scopepolicy.StepRead},
		"DELETE " + path + "/{stepId}":       {scopepolicy.StepWrite, scopepolicy.StepRead},
		"PUT " + path + "/{stepId}/status":   {scopepolicy.StepWrite, scopepolicy.StepRead},
		"PUT " + path + "/{stepId}/position": {scopepolicy.StepWrite, scopepolicy.StepRead},
		path:                                 nil, path + "/{stepId}": nil, path + "/{stepId}/status": nil, path + "/{stepId}/position": nil,
	}
	if len(entries) != len(expected) {
		t.Fatalf("entries: %+v", entries)
	}
	for _, entry := range entries {
		want, ok := expected[entry.Pattern]
		if !ok || !slices.Equal(entry.Operations, want) || entry.Fallback != (want == nil) {
			t.Fatalf("classification: %+v", entry)
		}
		delete(expected, entry.Pattern)
		method, route := "GET", entry.Pattern
		if before, after, ok := strings.Cut(entry.Pattern, " "); ok {
			method, route = before, after
		} else {
			method = "OPTIONS"
		}
		route = strings.ReplaceAll(route, "{projectId}", "33333333-3333-4333-8333-333333333333")
		route = strings.ReplaceAll(route, "{taskId}", "44444444-4444-4444-8444-444444444444")
		route = strings.ReplaceAll(route, "{stepId}", "abcdef12")
		_, mounted := mux.Handler(httptest.NewRequest(method, route, nil))
		wantPattern := entry.Pattern
		if strings.HasPrefix(wantPattern, "HEAD ") {
			wantPattern = "GET " + strings.TrimPrefix(wantPattern, "HEAD ")
		}
		if mounted != wantPattern {
			t.Fatalf("route %s mounted as %s", entry.Pattern, mounted)
		}
	}
}

func (s *stepScopeHTTPProbe) Get(_ context.Context, a model.CredentialAuthorization, project, task, step string) (taskservice.StepDocument, error) {
	if step != "abcdef12" {
		s.t.Fatal("step identity changed")
	}
	err := s.check(a, "get")
	return taskservice.StepDocument{JSON: []byte(`{"id":"abcdef12"}`)}, err
}
func (s *stepScopeHTTPProbe) Update(_ context.Context, a model.CredentialAuthorization, project, task, step string, in taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error) {
	if step != "abcdef12" || in.Version != 7 || in.Title == nil || *in.Title != "new" {
		s.t.Fatalf("update: %+v", in)
	}
	err := s.check(a, "update")
	return taskservice.StepsWriteResult{StepsDocument: taskservice.StepsDocument{JSON: []byte(`{"version":8}`)}, TransactionOutcome: store.TransactionCommitted}, err
}
func (s *stepScopeHTTPProbe) SetStatus(_ context.Context, a model.CredentialAuthorization, project, task, step string, in taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error) {
	if step != "abcdef12" || in.Version != 7 || in.Status != model.TaskStepDone {
		s.t.Fatalf("status: %+v", in)
	}
	err := s.check(a, "status")
	return taskservice.StepsWriteResult{StepsDocument: taskservice.StepsDocument{JSON: []byte(`{"version":8}`)}, TransactionOutcome: store.TransactionCommitted}, err
}
func (s *stepScopeHTTPProbe) Move(_ context.Context, a model.CredentialAuthorization, project, task, step string, in taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error) {
	if step != "abcdef12" || in.Version != 7 || in.Position == nil || *in.Position != "last" {
		s.t.Fatalf("move: %+v", in)
	}
	err := s.check(a, "move")
	return taskservice.StepsWriteResult{StepsDocument: taskservice.StepsDocument{JSON: []byte(`{"version":8}`)}, TransactionOutcome: store.TransactionCommitted}, err
}
func (s *stepScopeHTTPProbe) Delete(_ context.Context, a model.CredentialAuthorization, project, task, step string, in taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error) {
	if step != "abcdef12" || in.Version != 7 {
		s.t.Fatalf("delete: %+v", in)
	}
	err := s.check(a, "delete")
	return taskservice.StepsWriteResult{StepsDocument: taskservice.StepsDocument{JSON: []byte(`{"version":8}`)}, TransactionOutcome: store.TransactionCommitted}, err
}
func TestScopedStepHTTPAdapterOperationsAndMissingAuthorization(t *testing.T) {
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"step:read", "step:write"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	a := model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}, Profile: model.ScopedPATProfile, Policy: &policy}
	probe := &stepScopeHTTPProbe{t: t, a: a}
	mux := http.NewServeMux()
	TaskStepsScopedRoutes(mux, probe, stepScopeHTTPAuth{a}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	path := "/api/v1/projects/33333333-3333-4333-8333-333333333333/tasks/44444444-4444-4444-8444-444444444444/steps/abcdef12"
	for _, tc := range []struct{ name, method, path, body string }{{"get", "GET", path, ""}, {"update", "PATCH", path, `{"version":7,"title":"new"}`}, {"status", "PUT", path + "/status", `{"version":7,"status":"done"}`}, {"move", "PUT", path + "/position", `{"version":7,"position":"last"}`}, {"delete", "DELETE", path, `{"version":7}`}} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != 200 || probe.seen != tc.name || !strings.Contains(w.Body.String(), map[bool]string{true: "abcdef12", false: "8"}[tc.name == "get"]) {
				t.Fatalf("response %d %s seen %s", w.Code, w.Body, probe.seen)
			}
		})
	}
	adapter := scopedStepAdapter{steps: probe}
	ctx := context.Background()
	p := a.Principal
	for _, call := range []func() error{
		func() error { _, e := adapter.List(ctx, p, "p", "t"); return e }, func() error { _, e := adapter.Get(ctx, p, "p", "t", "s"); return e }, func() error { _, e := adapter.Add(ctx, p, "p", "t", taskservice.AddTaskStep{}); return e }, func() error { _, e := adapter.Update(ctx, p, "p", "t", "s", taskservice.UpdateTaskStep{}); return e }, func() error {
			_, e := adapter.SetStatus(ctx, p, "p", "t", "s", taskservice.SetTaskStepStatus{})
			return e
		}, func() error { _, e := adapter.Move(ctx, p, "p", "t", "s", taskservice.MoveTaskStep{}); return e }, func() error { _, e := adapter.Delete(ctx, p, "p", "t", "s", taskservice.DeleteTaskStep{}); return e },
	} {
		if call() == nil {
			t.Fatal("missing authorization accepted")
		}
	}
	bad := a
	bad.Policy = nil
	if _, err := stepAuthorization(context.WithValue(ctx, stepAuthorizationKey{}, bad), p); err == nil {
		t.Fatal("missing policy accepted")
	}
	for _, ctx := range []context.Context{context.WithValue(ctx, stepAuthorizationKey{}, bad), context.WithValue(ctx, stepAuthorizationKey{}, a)} {
		other := p
		other.CredentialID = "another"
		if _, err := stepAuthorization(ctx, other); err == nil {
			t.Fatal("invalid or mismatched authorization accepted")
		}
	}
}
