package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

const uiTestShell = "<html><body>server test shell</body></html>\n"

const uiTestScriptPath = "/assets/app-12345678.js"

func uiTestHandler(t *testing.T, output io.Writer) http.Handler {
	t.Helper()
	return newOperationHTTPServer(t, func(*httpDependencies) {}, output, defaultHTTPPrincipal())
}

func TestUIExactRoutesAssetsAndSingleRequestLog(t *testing.T) {
	var logs bytes.Buffer
	handler := uiTestHandler(t, &logs)
	root := projectRequest(handler, http.MethodGet, "/", "")
	if root.Code != http.StatusOK || root.Header().Get("Content-Type") != "text/html; charset=utf-8" || root.Header().Get("Cache-Control") != "no-store" || root.Body.String() != uiTestShell {
		t.Fatalf("root UI response: %d %+v", root.Code, root.Header())
	}
	var entries []map[string]any
	decoder := json.NewDecoder(&logs)
	for decoder.More() {
		var entry map[string]any
		if err := decoder.Decode(&entry); err != nil {
			t.Fatal(err)
		}
		entries = append(entries, entry)
	}
	if len(entries) != 1 || entries[0]["type"] != "http_request" || entries[0]["route"] != "GET /{$}" || entries[0]["request_id"] != "project-test" {
		t.Fatalf("UI must reuse exactly one request logger: %+v", entries)
	}
	for _, target := range []string{"/team-invitations", "/login", "/login?returnPath=%2Fprojects&private-query=value", "/projects", "/projects?private-query=value", "/shared-projects", "/teams/00000000-0000-4000-8000-000000000099", "/teams/invalid-private-team", "/teams/00000000-0000-4000-8000-000000000099/settings", "/teams/00000000-0000-4000-8000-000000000099/members", "/teams/invalid-private-team/members", "/workers", "/workers?private-query=value", "/workers/00000000-0000-4000-8000-000000000099", "/workers/invalid-private-worker"} {
		response := projectRequest(handler, http.MethodGet, target, "")
		if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), root.Body.Bytes()) || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("product entry did not return the server shell: %d", response.Code)
		}
	}
	for _, projectID := range []string{"00000000-0000-4000-8000-000000000099", "invalid-private-project"} {
		for _, suffix := range []string{"", "/members", "/settings"} {
			response := projectRequest(handler, http.MethodGet, "/projects/"+projectID+suffix, "")
			if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), root.Body.Bytes()) || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("project deep link did not return server shell: %d", response.Code)
			}
		}
	}
	for _, asset := range []struct {
		path, body, contentType string
	}{
		{uiTestScriptPath, "console.log(\"server test asset\");\n", "text/javascript"},
		{"/assets/style-12345678.css", "body { color: black; }\n", "text/css"},
	} {
		response := projectRequest(handler, http.MethodGet, asset.path, "")
		if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" || response.Body.String() != asset.body ||
			response.Header().Get("Content-Length") != strconv.Itoa(len(asset.body)) || !strings.HasPrefix(response.Header().Get("Content-Type"), asset.contentType) {
			t.Fatalf("test asset response: %s %d %+v", asset.path, response.Code, response.Header())
		}
	}
	for _, target := range []string{
		"/unknown-private-page", "/team-invitations/child", "/team-invitations/", "/setup/", "/setup/private-child", "/setup-private", "/login/", "/login/private-child", "/login-private", "/projects/", "/projects-list", "/projects/id/extra", "/projects/id/members/extra", "/projects/id/settings/extra",
		"/projects/id/tasks", "/projects/id/tasks/task/unknown", "/projects/id/tasks/task/unknown/file", "/projects/id/tasks/task/attachment/file",
		"/workers/", "/workers-list", "/workers/id/extra", "/workers/id/assets/missing.js",
		"/teams/", "/teams/id/extra", "/teams/id/settings/extra", "/teams/id/members/extra", "/shared-projects/extra",
		"/api/unknown-private-route", "/api/v1/projects/id/unknown", "/assets/", "/assets/missing-private.js",
		"/assets/%2e%2e/index.html", "/assets/%2findex.html",
	} {
		response := projectRequest(handler, http.MethodGet, target, "")
		assertProjectError(t, response, http.StatusNotFound, "not_found")
		if strings.Contains(response.Body.String(), "<html") {
			t.Fatalf("unknown path returned SPA HTML: %s", target)
		}
	}
	if strings.Contains(logs.String(), "private") {
		t.Fatalf("UI path leaked to logs: %s", &logs)
	}
}

func TestUISetupGuideUsesServerShellAndSafeRequestLog(t *testing.T) {
	var logs bytes.Buffer
	handler := uiTestHandler(t, &logs)
	index := projectRequest(handler, http.MethodGet, "/", "")
	for _, test := range []struct {
		method string
		path   string
		status int
		route  string
	}{
		{http.MethodGet, "/setup", http.StatusOK, "GET /setup"},
		{http.MethodGet, "/setup?private-query=value", http.StatusOK, "GET /setup"},
		{http.MethodHead, "/setup", http.StatusOK, "GET /setup"},
		{http.MethodPost, "/setup", http.StatusMethodNotAllowed, "/setup"},
		{http.MethodPut, "/setup", http.StatusMethodNotAllowed, "/setup"},
		{http.MethodPatch, "/setup", http.StatusMethodNotAllowed, "/setup"},
		{http.MethodDelete, "/setup", http.StatusMethodNotAllowed, "/setup"},
		{http.MethodOptions, "/setup", http.StatusMethodNotAllowed, "/setup"},
	} {
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			logs.Reset()
			response := projectRequest(handler, test.method, test.path, "private-body")
			if response.Code != test.status || response.Header().Get("X-Request-ID") != "project-test" {
				t.Fatalf("setup route lost response contract: %d %+v", response.Code, response.Header())
			}
			if test.status == http.StatusOK {
				if response.Header().Get("Content-Type") != "text/html; charset=utf-8" || response.Header().Get("Content-Length") != index.Header().Get("Content-Length") || response.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("setup route did not retain index headers: %+v", response.Header())
				}
				if test.method == http.MethodHead && response.Body.Len() != 0 || test.method == http.MethodGet && !bytes.Equal(response.Body.Bytes(), index.Body.Bytes()) {
					t.Fatal("setup route did not return the server shell or suppress the HEAD body")
				}
			} else {
				assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
				if response.Header().Get("Allow") != "GET, HEAD" {
					t.Fatalf("wrong setup method Allow: %+v", response.Header())
				}
			}
			var entry map[string]any
			decoder := json.NewDecoder(&logs)
			if err := decoder.Decode(&entry); err != nil {
				t.Fatal(err)
			}
			if decoder.More() || entry["type"] != "http_request" || entry["route"] != test.route || entry["method"] != test.method || entry["status"] != float64(test.status) || entry["request_id"] != "project-test" || strings.Contains(logs.String(), "private") {
				t.Fatalf("setup route lost safe single request logging: %+v %s", entry, &logs)
			}
		})
	}
}

func TestUIStandaloneTaskDetailReloadUsesServerShellAndSafeRequestLog(t *testing.T) {
	var logs bytes.Buffer
	handler := uiTestHandler(t, &logs)
	index := projectRequest(handler, http.MethodGet, "/", "")
	for _, target := range []struct {
		path  string
		route string
	}{
		{"/projects/00000000-0000-4000-8000-000000000099/tasks/00000000-0000-4000-8000-000000000001", "GET /projects/{projectId}/tasks/{taskId}"},
		{"/projects/00000000-0000-4000-8000-000000000099/tasks/00000000-0000-4000-8000-000000000001?tab=attachments", "GET /projects/{projectId}/tasks/{taskId}"},
		{"/projects/invalid-private-project/tasks/invalid-private-task?tab=overview", "GET /projects/{projectId}/tasks/{taskId}"},
		{"/projects/00000000-0000-4000-8000-000000000099/tasks/00000000-0000-4000-8000-000000000001/attachments/plan.md", "GET /projects/{projectId}/tasks/{taskId}/attachments/{path...}"},
		{"/projects/00000000-0000-4000-8000-000000000099/tasks/00000000-0000-4000-8000-000000000001/attachments/%E6%96%87%E6%A1%A3%20space/private%20%3F%23%20%252F.md?tab=overview", "GET /projects/{projectId}/tasks/{taskId}/attachments/{path...}"},
		{"/projects/invalid-private-project/tasks/invalid-private-task/attachments/file.txt", "GET /projects/{projectId}/tasks/{taskId}/attachments/{path...}"},
	} {
		for range 2 {
			logs.Reset()
			response := projectRequest(handler, http.MethodGet, target.path, "")
			if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), index.Body.Bytes()) || response.Header().Get("Content-Type") != "text/html; charset=utf-8" || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("standalone deep link did not return server shell: %s %d %+v", target.path, response.Code, response.Header())
			}
			var entry map[string]any
			decoder := json.NewDecoder(&logs)
			if err := decoder.Decode(&entry); err != nil {
				t.Fatal(err)
			}
			if decoder.More() || entry["type"] != "http_request" || entry["route"] != target.route || entry["request_id"] != "project-test" || strings.Contains(logs.String(), "private") {
				t.Fatalf("standalone route lost safe single request logging: %+v %s", entry, &logs)
			}
		}
	}
}

func TestUIHeadAndKnownMethodBoundaries(t *testing.T) {
	handler := uiTestHandler(t, io.Discard)
	server := httptest.NewServer(handler)
	defer server.Close()
	for _, target := range []string{
		"/", "/setup", "/login", "/workers", "/workers/00000000-0000-4000-8000-000000000099", "/workers/invalid-private-worker?private-query=value", "/projects", "/shared-projects", "/teams/00000000-0000-4000-8000-000000000099", "/projects/00000000-0000-4000-8000-000000000099",
		"/teams/00000000-0000-4000-8000-000000000099/members",
		"/projects/00000000-0000-4000-8000-000000000099/members",
		"/projects/00000000-0000-4000-8000-000000000099/settings",
		"/projects/00000000-0000-4000-8000-000000000099/tasks/00000000-0000-4000-8000-000000000001",
		"/projects/00000000-0000-4000-8000-000000000099/tasks/00000000-0000-4000-8000-000000000001?tab=attachments",
		"/projects/00000000-0000-4000-8000-000000000099/tasks/00000000-0000-4000-8000-000000000001/attachments/nested/plan.md",
		"/projects/00000000-0000-4000-8000-000000000099/tasks/00000000-0000-4000-8000-000000000001/attachments/nested/plan.md?tab=overview",
		uiTestScriptPath,
	} {
		for _, method := range []string{http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
			response := projectRequest(handler, method, target, "private-body")
			assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
			if response.Header().Get("Allow") != "GET, HEAD" {
				t.Fatalf("wrong UI method Allow: %+v", response.Header())
			}
		}
		request, err := http.NewRequest(http.MethodHead, server.URL+target, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("X-Request-ID", "project-test")
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || response.StatusCode != http.StatusOK || len(body) != 0 || response.Header.Get("X-Request-ID") != "project-test" || response.Header.Get("Content-Length") == "" {
			t.Fatalf("HEAD route: %+v %v", response, err)
		}
	}
}

func TestUIRegistrationPreservesAPIResponses(t *testing.T) {
	f := newTaskHTTPFixture(t)
	path := taskCollection(f.project.ID) + "/" + f.target.ID
	graph := graphPath(f.project.ID, f.target.ID)
	for _, target := range []string{"/api/v1/projects", "/api/v1/projects/" + f.project.ID, "/api/v1/projects/" + f.project.ID + "/members", taskCollection(f.project.ID), path, graph} {
		switch target {
		case "/api/v1/projects":
			projectHTTPPage(t, f.projects, f.principal, coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 50}}, []model.Project{f.project}, nil)
		case "/api/v1/projects/" + f.project.ID:
			projectHTTPGetResult(t, f.projects, f.principal, f.project.ID, f.project, taskHTTPMockAccess(f.project, f.principal), nil)
		case "/api/v1/projects/" + f.project.ID + "/members":
			called := projectHTTPCount(t, 1)
			expectedAccess := projectHTTPCopyAccess(taskHTTPMockAccess(f.project, f.principal))
			f.memberships.ListWithAccessCall = func(ctx context.Context, principal model.Principal, id string) (coreproject.ProjectParticipants, error) {
				called()
				projectHTTPContext(t, ctx, principal, f.principal)
				projectHTTPCheck(t, id, f.project.ID)
				owner := expectedAccess.OwnerTeam
				owner.Name = projectHTTPCopyPointer(owner.Name)
				return coreproject.ProjectParticipants{ActorAccess: projectHTTPCopyAccess(expectedAccess), Items: []model.ProjectParticipant{{UserID: f.principal.UserID, Profile: model.ProjectParticipantProfile{}, EffectiveRole: model.ProjectAdmin, InheritedFrom: &model.ProjectInheritance{Team: owner, Role: model.ProjectAdmin}}}}, nil
			}
		case taskCollection(f.project.ID):
			f.expectListRequest(taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 50}}, taskservice.TaskPage{Items: []model.Task{f.target}}, nil)
		case path:
			f.expectRead(f.target)
		case graph:
			f.expectGraph(f.target.ID, []model.GraphTask{{ID: f.target.ID, TitlePreview: f.target.Title, Status: f.target.Status, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, AssignedTo: f.target.AssignedTo, Ready: true, CreatedAt: f.target.CreatedAt, UpdatedAt: f.target.UpdatedAt}}, model.TaskGraphSummary{Total: 1, Todo: 1, Ready: 1})
		}
		response := projectRequest(f.handler, http.MethodGet, target, "")
		if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "application/json" || strings.Contains(response.Body.String(), "<html") {
			t.Fatalf("UI registration changed API response: %s %d %+v", target, response.Code, response.Header())
		}
		if (target == path || target == graph) && response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("latest task read may be cached: %s %+v", target, response.Header())
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+f.project.ID+"/members", nil)
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	assertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
	if response.Header().Get("Content-Type") != "application/json" || strings.Contains(response.Body.String(), "<html") {
		t.Fatal("member API must retain authenticated JSON behavior")
	}
}

func TestUITestSessionDeepLinkLoadsShellWithoutAuthorizingData(t *testing.T) {
	handler := uiTestHandler(t, io.Discard)
	request := func(method, path string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(method, path, nil))
		return response
	}
	index := request(http.MethodGet, "/")
	path := "/test-sessions/10000000-0000-0000-0000-000000000001"
	for range 2 {
		response := request(http.MethodGet, path)
		if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), index.Body.Bytes()) || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("direct load/reload failed: %d %s", response.Code, response.Body.String())
		}
	}
	head := request(http.MethodHead, path)
	if head.Code != http.StatusOK || head.Body.Len() != 0 {
		t.Fatal("HEAD shell", head.Code)
	}
	if response := request(http.MethodPost, path); response.Code != http.StatusMethodNotAllowed {
		t.Fatal("unsupported method", response.Code)
	}
	for _, unknown := range []string{"/test-sessions/id/extra", "/test-sessions/id/assets/missing.js", "/assets/missing-test-session.js"} {
		response := request(http.MethodGet, unknown)
		if response.Code != http.StatusNotFound || strings.Contains(response.Body.String(), "<html") {
			t.Fatal("unknown route became SPA", unknown, response.Code)
		}
	}
	// Public shell loading leaves the authenticated Test Session API protected.
	if response := request(http.MethodGet, "/api/v1/test-sessions/10000000-0000-0000-0000-000000000001"); response.Code != http.StatusUnauthorized {
		t.Fatal("anonymous data access", response.Code)
	}
}

func TestTestSessionListShellKeepsAPIProtected(t *testing.T) {
	handler := uiTestHandler(t, io.Discard)
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(method, "/test-sessions", nil))
		if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(method, response.Code)
		}
		if method == http.MethodHead && response.Body.Len() != 0 {
			t.Fatal("HEAD body")
		}
	}
	for _, target := range []struct {
		method, path string
		status       int
	}{{http.MethodPost, "/test-sessions", http.StatusMethodNotAllowed}, {http.MethodGet, "/api/v1/test-sessions", http.StatusUnauthorized}} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(target.method, target.path, nil))
		if response.Code != target.status {
			t.Fatal(target, response.Code)
		}
	}
}

func TestUIAssistantDirectLoadAndReloadKeepAPIProtected(t *testing.T) {
	handler := uiTestHandler(t, io.Discard)
	request := func(method, path string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(method, path, nil))
		return response
	}
	index := request(http.MethodGet, "/")
	for _, path := range []string{"/bots", "/bots?private-query=value", "/bots/10000000-0000-0000-0000-000000000001", "/bots/invalid-private-bot"} {
		t.Run(path, func(t *testing.T) {
			for range 2 {
				response := request(http.MethodGet, path)
				if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), index.Body.Bytes()) || response.Header().Get("Content-Type") != "text/html; charset=utf-8" || response.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("assistant direct load/reload did not return server shell: %d %s", response.Code, response.Body.String())
				}
			}
			head := request(http.MethodHead, path)
			if head.Code != http.StatusOK || head.Body.Len() != 0 {
				t.Fatalf("assistant HEAD response: %d %s", head.Code, head.Body.String())
			}
			for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
				response := request(method, path)
				if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET, HEAD" {
					t.Fatalf("assistant method boundary: %s %d", method, response.Code)
				}
			}
		})
	}
	for _, path := range []string{"/bots/", "/bots-list", "/bots/id/extra", "/bots/id/assets/missing.js"} {
		response := request(http.MethodGet, path)
		if response.Code != http.StatusNotFound || strings.Contains(response.Body.String(), "<html") {
			t.Fatalf("unknown assistant route became SPA: %s %d", path, response.Code)
		}
	}
	for _, path := range []string{"/api/v1/me/bots", "/api/v1/me/bots/10000000-0000-0000-0000-000000000001"} {
		response := request(http.MethodGet, path)
		if response.Code != http.StatusUnauthorized || response.Header().Get("Content-Type") != "application/json" {
			t.Fatalf("assistant API lost authentication: %s %d", path, response.Code)
		}
	}
}
