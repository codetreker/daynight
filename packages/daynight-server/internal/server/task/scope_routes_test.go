package task_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type readRouteAuth struct{ authorization model.CredentialAuthorization }

func (a readRouteAuth) RequireScoped(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { next(w, r, a.authorization) }
}

type readRouteStore struct {
	store.ProjectWriter
	snapshot store.SnapshotScope
}

func (s readRouteStore) ReadSnapshot(ctx context.Context, next func(store.SnapshotScope) error) error {
	return next(s.snapshot)
}

type readRouteSnapshot struct {
	store.SnapshotScope
	projects    store.ProjectReader
	tasks       store.TaskReader
	credentials store.CredentialReader
}

func (s readRouteSnapshot) ProjectDAO() store.ProjectReader               { return s.projects }
func (s readRouteSnapshot) TaskDAO() store.TaskReader                     { return s.tasks }
func (s readRouteSnapshot) CredentialDAO() store.CredentialReader         { return s.credentials }
func (s readRouteSnapshot) ObservedAt(context.Context) (time.Time, error) { return testTime, nil }

type readRouteCredentials struct{}

func (readRouteCredentials) Credential(context.Context, model.Principal) (store.ThreadCredential, error) {
	return store.ThreadCredential{}, nil
}

type readRouteProjects struct {
	store.ProjectReader
	t    *testing.T
	full bool
}

func (s readRouteProjects) ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error) {
	return model.ProjectAccess{ProjectID: testProjectID, Role: model.ProjectAdmin}, nil
}
func (s readRouteProjects) Project(context.Context, string) (model.Project, error) {
	if !s.full {
		s.t.Fatal("Task-only query read Project settings")
	}
	project := testProject()
	project.Settings = model.ProjectSettings{Version: 1, ExecutionWarningMinutes: 120}
	project.Ownership = model.ProjectOwnership{TeamID: testUserID, Version: 1, UpdatedAt: testTime}
	return project, nil
}

type readRouteTasks struct {
	store.TaskReader
	task model.Task
}

func (s readRouteTasks) Task(context.Context, string, string) (model.Task, error) { return s.task, nil }
func (s readRouteTasks) TaskCacheEpoch(context.Context, string) (string, error) {
	return testEpoch, nil
}
func (s readRouteTasks) Tasks(context.Context, string, store.TaskQuery) (store.TaskPage, error) {
	return store.TaskPage{Items: []model.Task{s.task}, HasMore: true}, nil
}
func (s readRouteTasks) TaskPresence(context.Context, string, string) (store.TaskPresence, error) {
	return store.TaskPresence{Found: true}, nil
}
func (s readRouteTasks) TaskGraphTasks(context.Context, string, string, store.TaskGraphSelection, int) ([]model.GraphTask, error) {
	v := s.task
	return []model.GraphTask{{ID: v.ID, Type: v.Type, Version: v.Version, TitlePreview: v.Title, Status: v.Status, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}}, nil
}
func (s readRouteTasks) TaskListFence(context.Context, string) (store.TaskListFence, error) {
	return store.TaskListFence{Count: "1", VersionSum: "1"}, nil
}
func (s readRouteTasks) TaskWorkGroups(context.Context, string, store.TaskWorkQuery) (store.TaskWorkGroups, error) {
	return store.TaskWorkGroups{Items: []store.TaskWorkGroup{{ID: s.task.ID, DisplayTaskID: s.task.ID, TitlePreview: s.task.Title, MemberCount: 1, MatchedCount: 1, InProgressCount: 1, RootCount: 1, Roots: []store.TaskWorkRoot{{ID: s.task.ID, TitlePreview: s.task.Title}}, StartedAt: testTime}}}, nil
}
func (s readRouteTasks) TaskWorkTargets(context.Context, string, []string, *store.TaskWorkTargetPosition, int) (store.TaskWorkTargets, error) {
	return store.TaskWorkTargets{Items: []store.TaskWorkTarget{{GroupID: s.task.ID, Task: s.task}}}, nil
}

func scopedReadFixture(t *testing.T, scopes ...scopepolicy.ScopeID) http.Handler {
	t.Helper()
	slices.Sort(scopes)
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, scopes, 1)
	if err != nil {
		t.Fatal(err)
	}
	a := model.CredentialAuthorization{Principal: testPrincipal(), Profile: model.ScopedPATProfile, Policy: &policy}
	task := testTask("Visible task")
	task.Status, task.StartedAt = model.TaskInProgress, &testTime
	task.Ready = false
	assignedTo := testUserID
	task.AssignedTo = &assignedTo
	task.Properties = model.TaskProperties{"worker": json.RawMessage(`{"nativeSessionId":"private-session"}`), "sessionStartup": json.RawMessage(`{"sessionId":"private-session"}`), "blocked": json.RawMessage(`false`)}
	full := false
	for _, id := range scopes {
		full = full || id == "project:read"
	}
	db := readRouteStore{snapshot: readRouteSnapshot{tasks: readRouteTasks{task: task}, projects: readRouteProjects{t: t, full: full}, credentials: readRouteCredentials{}}}
	mux := http.NewServeMux()
	if err := taskhttp.ScopedReadRoutes(mux, taskservice.NewTasks(db), taskservice.NewObservations(db, nil), taskservice.NewTaskSync(db, nil, time.Second), readRouteAuth{a}, slog.New(slog.NewTextHandler(io.Discard, nil)), time.Second); err != nil {
		t.Fatal(err)
	}
	return mux
}

func scopedRouteResponse(t *testing.T, h http.Handler, path, projection string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+testProjectID+path, nil)
	if projection != "" {
		r.Header.Set("Daynight-Projection", projection)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestScopedReadRoutesRetainTasksAndMaskSessionFields(t *testing.T) {
	h := scopedReadFixture(t, "task:read")
	for _, path := range []string{"/tasks/" + testTaskID + "?include=session", "/tasks?limit=1&include=session", "/task-work"} {
		w := scopedRouteResponse(t, h, path, "")
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
		body := w.Body.String()
		if !strings.Contains(body, testTaskID) || !strings.Contains(body, "insufficient_scope") || strings.Contains(body, "private-session") || strings.Contains(body, `"worker"`) || strings.Contains(body, `"sessionStartup"`) {
			t.Fatalf("projection %s: %s", path, body)
		}
		if strings.Contains(path, "limit") && (!strings.Contains(body, `"partial":true`) || strings.Contains(body, `"nextCursor":null`)) {
			t.Fatalf("pagination lost: %s", body)
		}
	}
}

func TestScopedReadGraphSelectsMinimalProjectAndPreservesLegacyFullView(t *testing.T) {
	for _, include := range []string{"", "&include=session"} {
		h := scopedReadFixture(t, "task:read")
		w := scopedRouteResponse(t, h, "/task-graph?taskId="+testTaskID+include, "task-only-v1")
		if w.Code != http.StatusOK || w.Header().Get("Daynight-Projection") != "task-only-v1" {
			t.Fatalf("minimal graph: %d %s", w.Code, w.Body)
		}
		var result map[string]json.RawMessage
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if string(result["project"]) != `{"id":"`+testProjectID+`"}` || len(result["tasks"]) == 0 {
			t.Fatalf("minimal graph %s", w.Body)
		}
		w = scopedRouteResponse(t, h, "/task-graph?taskId="+testTaskID+include, "")
		if w.Code != http.StatusForbidden || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" {
			t.Fatalf("full graph refusal: %d %s", w.Code, w.Body)
		}
		w = scopedRouteResponse(t, scopedReadFixture(t, "task:read", "project:read"), "/task-graph?taskId="+testTaskID+include, "")
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"name":"Task project"`) || w.Header().Get("Daynight-Projection") != "" {
			t.Fatalf("full graph: %d %s", w.Code, w.Body)
		}
	}
}

func TestScopedReadRoutesRejectMissingTaskReadIncludingHead(t *testing.T) {
	h := scopedReadFixture(t, "project:read")
	for _, path := range []string{"/tasks", "/tasks?include=session", "/tasks/" + testTaskID, "/tasks/" + testTaskID + "?include=session", "/tasks/" + testTaskID + "/properties", "/task-work", "/task-sync", "/task-graph?taskId=" + testTaskID} {
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			r := httptest.NewRequest(method, "/api/v1/projects/"+testProjectID+path, nil)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != http.StatusForbidden || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" {
				t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body)
			}
		}
	}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/task-properties/schema", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("schema method fallback: %d %s", w.Code, w.Body)
	}
}

func TestScopedTaskSearchRoutesForwardAuthorizationAndFailure(t *testing.T) {
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	a := model.CredentialAuthorization{Principal: testPrincipal(), Profile: model.ScopedPATProfile, Policy: &policy}
	mux := http.NewServeMux()
	calls := 0
	err = taskhttp.ScopedTaskSearchRoutes(mux, func(ctx context.Context, got model.CredentialAuthorization, project string, in tasksearch.Request) (tasksearch.Page, error) {
		calls++
		if got != a || project != testProjectID || in.Query != "visible" || in.Cursor == nil || *in.Cursor != "opaque" || ctx.Err() != nil {
			t.Fatalf("search inputs %#v %#v", got, in)
		}
		return tasksearch.Page{}, &model.Fault{Code: "insufficient_scope", Message: "The credential has insufficient scope."}
	}, readRouteAuth{a}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+testProjectID+"/tasks/search", strings.NewReader(`{"query":"visible","cursor":"opaque"}`))
	r.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(w, r)
	if calls != 1 || w.Code != http.StatusForbidden || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" {
		t.Fatalf("search response %d %s calls=%d", w.Code, w.Body, calls)
	}
}

func TestScopedReadRouteRegistrationAndAuthenticationBoundaries(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	tasks, observations, sync := &taskservice.Tasks{}, &taskservice.Observations{}, &taskservice.TaskSync{}
	if err := taskhttp.ScopedReadRoutes(nil, tasks, observations, sync, readRouteAuth{}, logger, time.Second); err == nil {
		t.Fatal("missing mux accepted")
	}
	mux := http.NewServeMux()
	if err := taskhttp.ScopedReadRoutes(mux, tasks, observations, sync, readRouteAuth{}, logger, time.Second); err != nil {
		t.Fatal(err)
	}
	w := scopedRouteResponse(t, mux, "/tasks", "")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("invalid authorization: %d %s", w.Code, w.Body)
	}
	for _, scopes := range [][]scopepolicy.ScopeID{{"project:read"}, {"task:read"}} {
		h := scopedReadFixture(t, scopes...)
		r := httptest.NewRequest(http.MethodGet, "/api/v1/task-properties/schema", nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		want := http.StatusForbidden
		if scopes[0] == "task:read" {
			want = http.StatusOK
		}
		if w.Code != want {
			t.Fatalf("schema %v: %d %s", scopes, w.Code, w.Body)
		}
	}
	h := scopedReadFixture(t, "task:read")
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		r := httptest.NewRequest(method, "/api/v1/projects/"+testProjectID+"/tasks/not-an-id/goal-dependencies", nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		want := http.StatusBadRequest
		if method == http.MethodPost {
			want = http.StatusMethodNotAllowed
		}
		if w.Code != want {
			t.Fatalf("Goal query %s: %d %s", method, w.Code, w.Body)
		}
	}
}

func TestScopedSearchRouteRegistrationAndAuthenticationBoundaries(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	search := func(context.Context, model.CredentialAuthorization, string, tasksearch.Request) (tasksearch.Page, error) {
		t.Fatal("rejected search was invoked")
		return tasksearch.Page{}, nil
	}
	if err := taskhttp.ScopedTaskSearchRoutes(nil, search, readRouteAuth{}, logger); err == nil {
		t.Fatal("missing search mux accepted")
	}
	for _, valid := range []bool{false, true} {
		mux := http.NewServeMux()
		a := model.CredentialAuthorization{}
		if valid {
			policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 1)
			if err != nil {
				t.Fatal(err)
			}
			a = model.CredentialAuthorization{Principal: testPrincipal(), Profile: model.ScopedPATProfile, Policy: &policy}
		}
		if err := taskhttp.ScopedTaskSearchRoutes(mux, search, readRouteAuth{a}, logger); err != nil {
			t.Fatal(err)
		}
		method := http.MethodPost
		want := http.StatusUnauthorized
		if valid {
			method, want = http.MethodGet, http.StatusMethodNotAllowed
		}
		r := httptest.NewRequest(method, "/api/v1/projects/"+testProjectID+"/tasks/search", nil)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("search auth/fallback valid=%v: %d %s", valid, w.Code, w.Body)
		}
	}
}

func TestScopedTaskReadSearchAndWriteRoutesComposeInAnyOrder(t *testing.T) {
	for _, order := range []string{"RSW", "RWS", "SRW", "SWR", "WRS", "WSR"} {
		t.Run(order, func(t *testing.T) {
			policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 1)
			if err != nil {
				t.Fatal(err)
			}
			a := model.CredentialAuthorization{Principal: testPrincipal(), Profile: model.ScopedPATProfile, Policy: &policy}
			db := readRouteStore{snapshot: readRouteSnapshot{tasks: readRouteTasks{task: testTask("Combined routes")}, projects: readRouteProjects{t: t}, credentials: readRouteCredentials{}}}
			mux := http.NewServeMux()
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			searchCalls := 0
			registerRead := func() error {
				return taskhttp.ScopedReadRoutes(mux, taskservice.NewTasks(db), taskservice.NewObservations(db, nil), taskservice.NewTaskSync(db, nil, time.Second), readRouteAuth{a}, logger, time.Second)
			}
			registerSearch := func() error {
				return taskhttp.ScopedTaskSearchRoutes(mux, func(ctx context.Context, authorization model.CredentialAuthorization, project string, input tasksearch.Request) (tasksearch.Page, error) {
					searchCalls++
					if ctx.Err() != nil || authorization != a || project != testProjectID || input.Query != "combined" {
						t.Fatalf("search forwarding: %#v %q %#v", authorization, project, input)
					}
					return tasksearch.Page{ProjectID: project, Items: []tasksearch.Item{}}, nil
				}, readRouteAuth{a}, logger)
			}
			registrations := map[rune]func() error{
				'R': registerRead,
				'S': registerSearch,
				'W': func() error {
					return taskhttp.RegisterScopedWriteRoutes(mux, taskservice.NewTasks(db), scopedGoalOperations{}, readRouteAuth{a}, logger)
				},
			}
			for _, owner := range order {
				if err := registrations[owner](); err != nil {
					t.Fatal(err)
				}
			}
			for _, route := range []struct {
				method, path, body string
				status             int
				allow              string
			}{
				{http.MethodPost, "/tasks/search", `{"query":"combined"}`, http.StatusOK, ""},
				{http.MethodGet, "/tasks/" + testTaskID, "", http.StatusOK, ""},
				{http.MethodGet, "/tasks?limit=1", "", http.StatusOK, ""},
				{http.MethodPatch, "/tasks/" + testTaskID, `{}`, http.StatusBadRequest, ""},
				{http.MethodPatch, "/tasks/" + testTaskID + "/goal-dependencies", `{}`, http.StatusBadRequest, ""},
				{http.MethodGet, "/tasks/search", "", http.StatusMethodNotAllowed, "POST"},
				{http.MethodHead, "/tasks/search", "", http.StatusMethodNotAllowed, "POST"},
				{http.MethodPatch, "/tasks/search", "", http.StatusMethodNotAllowed, "POST"},
				{http.MethodDelete, "/tasks/search", "", http.StatusMethodNotAllowed, "POST"},
				{http.MethodPut, "/tasks/search", "", http.StatusMethodNotAllowed, "POST"},
			} {
				r := httptest.NewRequest(route.method, "/api/v1/projects/"+testProjectID+route.path, strings.NewReader(route.body))
				r.Header.Set("Content-Type", "application/json")
				w := httptest.NewRecorder()
				mux.ServeHTTP(w, r)
				if w.Code != route.status || w.Header().Get("Allow") != route.allow {
					t.Fatalf("%s %s: %d Allow=%q %s", route.method, route.path, w.Code, w.Header().Get("Allow"), w.Body)
				}
			}
			if searchCalls != 1 {
				t.Fatalf("search calls=%d", searchCalls)
			}
		})
	}
}

func TestScopedReadMethodFallbacksIncludeMountedMutations(t *testing.T) {
	h := scopedReadFixture(t, "task:read")
	for _, tc := range []struct{ path, allow string }{
		{"/tasks", "GET, HEAD, POST"},
		{"/tasks/" + testTaskID, "GET, HEAD, PATCH, DELETE"},
		{"/tasks/" + testTaskID + "/goal-dependencies", "GET, HEAD, PATCH"},
		{"/tasks/search", "POST"},
	} {
		r := httptest.NewRequest("TRACE", "/api/v1/projects/"+testProjectID+tc.path, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != tc.allow {
			t.Fatalf("%s: %d Allow=%q %s", tc.path, w.Code, w.Header().Get("Allow"), w.Body)
		}
	}
}
