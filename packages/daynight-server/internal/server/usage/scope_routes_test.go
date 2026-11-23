package usage

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
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
)

func TestUsageRouteRegistrationClassifications(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	service, err := app.New(nil, app.Options{})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]ScopeRoute{}
	add := func(pattern string, entry ScopeRoute) { entry.Pattern = pattern; want[pattern] = entry }
	addGET := func(path string, entry ScopeRoute) { add("GET "+path, entry); add("HEAD "+path, entry) }
	addGET("/api/usage/v1/capabilities", ScopeRoute{CapabilityCheck: true})
	producer := ScopeRoute{Producer: true, Operations: []scopepolicy.Operation{scopepolicy.SessionProduce}}
	add("POST /api/usage/v1/registrations", producer)
	addGET("/api/usage/v1/states/{stateId}", producer)
	add("POST /api/usage/v1/states/{stateId}/grant", producer)
	add("POST /api/usage/v1/states/{stateId}/revoke", producer)
	add("POST /api/usage/v1/states/{stateId}/batches", ScopeRoute{IndependentProfile: true})
	addGET("/api/usage/v1/states/{stateId}/sources", ScopeRoute{IndependentProfile: true})
	read := ScopeRoute{Operations: []scopepolicy.Operation{scopepolicy.UsageRead}}
	add("POST /api/projects/{projectId}/usage/v1/task-summaries", read)
	for _, path := range []string{
		"/api/projects/{projectId}/tasks/{taskId}/usage/v1/summary", "/api/projects/{projectId}/tasks/{taskId}/usage/v1/records",
		"/api/test-sessions/{sessionId}/usage/v1/summary", "/api/test-sessions/{sessionId}/usage/v1/records",
		"/api/projects/{projectId}/usage/v1/aggregates/chain/{scopeId}", "/api/projects/{projectId}/usage/v1/aggregates/goal/{scopeId}",
	} {
		addGET(path, read)
	}
	for _, scoped := range []bool{false, true} {
		got := map[string]ScopeRoute{}
		observe := func(route ScopeRoute) {
			if _, ok := got[route.Pattern]; ok {
				t.Fatalf("duplicate %s", route.Pattern)
			}
			got[route.Pattern] = route
		}
		mux := http.NewServeMux()
		if scoped {
			calls := 0
			RegisterScopedRoutesWithScopeObserver(mux, service, fixedAuth{}, fixedScopedAuth{calls: &calls}, logger, observe)
		} else {
			RegisterRoutesWithScopeObserver(mux, service, fixedAuth{}, logger, observe)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("scoped=%t registrations = %#v; want %#v", scoped, got, want)
		}
	}
}

type fixedScopedAuth struct {
	authorization model.CredentialAuthorization
	calls         *int
}

func (a fixedScopedAuth) RequireScoped(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { *a.calls++; next(w, r, a.authorization) }
}

type usageReadStore struct{ scope *usageReadScope }

func (s usageReadStore) ReadUsage(ctx context.Context, fn func(store.UsageScope) error) error {
	return fn(s.scope)
}
func (s usageReadStore) WriteUsage(context.Context, func(store.UsageScope) error) (store.Completion, error) {
	panic("unexpected write")
}

type usageReadScope struct {
	store.UsageScope
	dao     *usageReadDAO
	session *usageReadSession
	current model.CredentialAuthorization
}

func (s *usageReadScope) UsageDAO() store.UsageDAO     { return s.dao }
func (s *usageReadScope) SessionDAO() store.SessionDAO { return s.session }
func (s *usageReadScope) CurrentUsageAuthorization(_ context.Context, p model.Principal, _ time.Time) (model.CredentialAuthorization, error) {
	if p != s.current.Principal {
		return model.CredentialAuthorization{}, errors.New("wrong principal")
	}
	return s.current, nil
}

type usageReadSession struct {
	store.SessionDAO
	failure error
}

func (s *usageReadSession) ReadCredential(context.Context, model.Principal, time.Time) error {
	return s.failure
}

type usageReadDAO struct {
	store.UsageDAO
	accessFailure error
	metrics       int
	taskID        string
}

func (d *usageReadDAO) Now(context.Context) (time.Time, error) { return time.Unix(1, 0).UTC(), nil }
func (d *usageReadDAO) ProjectAccess(context.Context, string, string, bool) (model.ProjectAccess, error) {
	return model.ProjectAccess{ProjectID: "11111111-1111-4111-8111-111111111111", Role: model.ProjectAdmin, Ownership: model.ProjectOwnership{TeamID: "33333333-3333-4333-8333-333333333333", Version: 1}}, d.accessFailure
}
func (d *usageReadDAO) PermissionEpoch(context.Context, string, string) (string, error) {
	return "epoch", nil
}
func (d *usageReadDAO) Tasks(context.Context, string, []string) ([]store.UsageMember, error) {
	return []store.UsageMember{{ID: d.taskID}}, nil
}
func (d *usageReadDAO) TaskMetrics(context.Context, store.UsageFilter) (map[string]model.UsageSummary, error) {
	d.metrics++
	return map[string]model.UsageSummary{}, nil
}
func (d *usageReadDAO) Executions(context.Context, store.UsageFilter) ([]store.UsageExecution, error) {
	return nil, nil
}

func scopedUsageIdentity(t *testing.T, scopes ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, scopes, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: "44444444-4444-4444-8444-444444444444", CredentialID: "55555555-5555-4555-8555-555555555555"}, Profile: model.ScopedPATProfile, Policy: &policy}
}
func TestScopedUsageHTTPRetainsVisibilityAndProducerAuthentication(t *testing.T) {
	const project = "11111111-1111-4111-8111-111111111111"
	const task = "22222222-2222-4222-8222-222222222222"
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	missing := scopedUsageIdentity(t, "task:read")
	allowed := scopedUsageIdentity(t, "usage:read")
	dao := &usageReadDAO{taskID: task}
	scope := &usageReadScope{dao: dao, session: &usageReadSession{}, current: missing}
	service, err := app.New(usageReadStore{scope}, app.Options{})
	if err != nil {
		t.Fatal(err)
	}
	ordinary, scoped := 0, 0
	var current = missing
	mux := http.NewServeMux()
	RegisterScopedRoutesWithScopeObserver(mux, service, rejectingAuth{&ordinary}, dynamicScopedAuth{&current, &scoped}, logger, nil)
	request := func(method, path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(method, path, nil))
		return w
	}
	url := "/api/projects/" + project + "/tasks/" + task + "/usage/v1/summary"
	dao.accessFailure = errors.New("invisible")
	w := request("GET", url)
	if w.Code != 404 || w.Header().Get("Daynight-Scope-Status") != "" {
		t.Fatalf("invisible: %d %v %s", w.Code, w.Header(), w.Body)
	}
	dao.accessFailure = nil
	w = request("GET", url)
	if w.Code != 403 || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || dao.metrics != 0 {
		t.Fatalf("denied: %d %v %s", w.Code, w.Header(), w.Body)
	}
	current, scope.current = allowed, allowed
	w = request("GET", url)
	if w.Code != 200 || dao.metrics != 1 {
		t.Fatalf("allowed: %d %s metrics=%d", w.Code, w.Body, dao.metrics)
	}
	w = request("GET", "/api/usage/v1/capabilities")
	if w.Code != 401 || ordinary != 1 || scoped != 3 {
		t.Fatalf("capabilities authentication: %d ordinary=%d scoped=%d", w.Code, ordinary, scoped)
	}
	w = request("GET", "/api/usage/v1/states/"+task)
	if w.Code != 401 || ordinary != 2 || scoped != 3 {
		t.Fatalf("producer authentication: %d ordinary=%d scoped=%d", w.Code, ordinary, scoped)
	}
}

type dynamicScopedAuth struct {
	current *model.CredentialAuthorization
	calls   *int
}

func (a dynamicScopedAuth) RequireScoped(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { *a.calls++; next(w, r, *a.current) }
}

type scopedReadSpy struct {
	method string
	auth   model.CredentialAuthorization
}

func (s *scopedReadSpy) reject(name string, auth model.CredentialAuthorization) error {
	s.method, s.auth = name, auth
	return &model.Fault{Code: "insufficient_scope", Message: "The credential has insufficient scope."}
}
func (s *scopedReadSpy) TaskSummariesAuthorized(_ context.Context, auth model.CredentialAuthorization, _ string, _ []string) (app.Summaries, error) {
	return app.Summaries{}, s.reject("summaries", auth)
}
func (s *scopedReadSpy) TestSummaryAuthorized(_ context.Context, auth model.CredentialAuthorization, _ string) (model.UsageSummary, error) {
	return model.UsageSummary{}, s.reject("test-summary", auth)
}
func (s *scopedReadSpy) RecordsAuthorized(_ context.Context, auth model.CredentialAuthorization, _, _, _ string, _ app.PageRequest) (app.RecordsPage, error) {
	return app.RecordsPage{}, s.reject("records", auth)
}
func (s *scopedReadSpy) AggregateAuthorized(_ context.Context, auth model.CredentialAuthorization, _, kind, _, _ string) (app.Aggregate, error) {
	return app.Aggregate{}, s.reject("aggregate-"+kind, auth)
}
func TestScopedUsageRoutesUseAuthorizedService(t *testing.T) {
	const project = "11111111-1111-4111-8111-111111111111"
	const task = "22222222-2222-4222-8222-222222222222"
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth := scopedUsageIdentity(t, "usage:read")
	calls := 0
	spy := &scopedReadSpy{}
	mux := http.NewServeMux()
	registerScopedRoutes(mux, &controlledOperations{t: t}, spy, fixedAuth{}, fixedScopedAuth{authorization: auth, calls: &calls}, logger, nil)
	for _, tc := range []struct{ method, path, body, want string }{
		{"GET", "/api/projects/" + project + "/tasks/" + task + "/usage/v1/summary", "", "summaries"},
		{"HEAD", "/api/projects/" + project + "/tasks/" + task + "/usage/v1/summary", "", "summaries"},
		{"POST", "/api/projects/" + project + "/usage/v1/task-summaries", `{"taskIds":["` + task + `"]}`, "summaries"},
		{"GET", "/api/projects/" + project + "/tasks/" + task + "/usage/v1/records", "", "records"},
		{"GET", "/api/test-sessions/" + task + "/usage/v1/summary", "", "test-summary"},
		{"GET", "/api/test-sessions/" + task + "/usage/v1/records", "", "records"},
		{"GET", "/api/projects/" + project + "/usage/v1/aggregates/chain/" + task, "", "aggregate-chain"},
		{"GET", "/api/projects/" + project + "/usage/v1/aggregates/goal/" + task, "", "aggregate-goal"},
	} {
		spy.method = ""
		r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		if tc.body != "" {
			r.Header.Set("Content-Type", "application/json")
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != 403 || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || spy.method != tc.want || !reflect.DeepEqual(spy.auth, auth) {
			t.Fatalf("%s %s: %d %v method=%s body=%s", tc.method, tc.path, w.Code, w.Header(), spy.method, w.Body)
		}
	}
	if calls != 8 {
		t.Fatalf("scoped authentication calls = %d", calls)
	}
}

func TestScopedUsageAdapterRejectsMissingOrMismatchedAuthorization(t *testing.T) {
	auth := scopedUsageIdentity(t, "usage:read")
	other := auth.Principal
	other.CredentialID = "66666666-6666-4666-8666-666666666666"
	spy := &scopedReadSpy{}
	adapter := scopedOperations{reads: spy}
	for _, ctx := range []context.Context{t.Context(), context.WithValue(t.Context(), scopeContextKey{}, auth)} {
		principal := other
		for _, call := range []func() error{
			func() error { _, err := adapter.TaskSummaries(ctx, principal, "project", []string{"task"}); return err },
			func() error { _, err := adapter.TestSummary(ctx, principal, "session"); return err },
			func() error {
				_, err := adapter.Records(ctx, principal, "project", "task", "", app.PageRequest{})
				return err
			},
			func() error { _, err := adapter.Aggregate(ctx, principal, "project", "chain", "task", ""); return err },
		} {
			if err := call(); err == nil || spy.method != "" {
				t.Fatalf("unbound authority reached operation: %v, %s", err, spy.method)
			}
		}
	}
}

func TestScopedUsageRegistrationRequiresDependencies(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mux := http.NewServeMux()
	RegisterScopedRoutesWithScopeObserver(mux, nil, fixedAuth{}, nil, logger, nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/usage/v1/capabilities", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("nil service registered routes: %d", w.Code)
	}
	defer func() {
		if recover() == nil {
			t.Fatal("missing scoped authentication admitted")
		}
	}()
	registerScopedRoutes(http.NewServeMux(), &controlledOperations{t: t}, &scopedReadSpy{}, fixedAuth{}, nil, logger, nil)
}
