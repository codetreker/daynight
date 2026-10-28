package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/webui"
)

func uiTestHandler(t *testing.T, output io.Writer) http.Handler {
	t.Helper()
	logger := slog.New(slog.NewJSONHandler(output, nil))
	handler, err := New(Dependencies{}, configuredTestConfig(), logger)
	if err != nil {
		t.Fatal(err)
	}
	return RequestLogging(logger, handler)
}

func TestUIExactRoutesAssetsAndSingleRequestLog(t *testing.T) {
	var logs bytes.Buffer
	handler := uiTestHandler(t, &logs)
	root := projectRequest(handler, http.MethodGet, "/", "")
	if root.Code != http.StatusOK || root.Header().Get("Content-Type") != "text/html; charset=utf-8" || root.Header().Get("Cache-Control") != "no-store" || !strings.Contains(root.Body.String(), `<div id="root"></div>`) {
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
	for _, target := range []string{"/login", "/login?returnPath=%2Fprojects&private-query=value", "/projects", "/projects?private-query=value"} {
		response := projectRequest(handler, http.MethodGet, target, "")
		if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), root.Body.Bytes()) || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("product entry did not return the production index: %d", response.Code)
		}
	}
	for _, projectID := range []string{"00000000-0000-4000-8000-000000000099", "invalid-private-project"} {
		for _, suffix := range []string{"", "/members", "/settings"} {
			response := projectRequest(handler, http.MethodGet, "/projects/"+projectID+suffix, "")
			if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), root.Body.Bytes()) || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("project deep link did not return actual index: %d", response.Code)
			}
		}
	}
	assets := regexp.MustCompile(`(?:src|href)="(/assets/[^"?#]+)"`).FindAllStringSubmatch(root.Body.String(), -1)
	if len(assets) < 2 {
		t.Fatal("no emitted assets in production HTML")
	}
	for _, asset := range assets {
		response := projectRequest(handler, http.MethodGet, asset[1], "")
		if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" || response.Body.Len() == 0 || response.Header().Get("Content-Type") == "text/html; charset=utf-8" {
			t.Fatalf("production asset response: %d %+v", response.Code, response.Header())
		}
	}
	for _, target := range []string{
		"/unknown-private-page", "/setup/", "/setup/private-child", "/setup-private", "/login/", "/login/private-child", "/login-private", "/projects/", "/projects-list", "/projects/id/extra", "/projects/id/members/extra", "/projects/id/settings/extra",
		"/projects/id/tasks", "/projects/id/tasks/task/unknown", "/projects/id/tasks/task/unknown/file", "/projects/id/tasks/task/attachment/file",
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

func TestUISetupGuideUsesProductionIndexAndSafeRequestLog(t *testing.T) {
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
					t.Fatal("setup route did not return the production index or suppress the HEAD body")
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

func TestUIStandaloneTaskDetailReloadUsesProductionIndexAndSafeRequestLog(t *testing.T) {
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
				t.Fatalf("standalone deep link did not return actual index: %s %d %+v", target.path, response.Code, response.Header())
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
	index := projectRequest(handler, http.MethodGet, "/", "")
	asset := regexp.MustCompile(`src="(/assets/[^"?#]+)"`).FindStringSubmatch(index.Body.String())
	if len(asset) != 2 {
		t.Fatal("no production script asset")
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	for _, target := range []string{
		"/", "/setup", "/login", "/projects", "/projects/00000000-0000-4000-8000-000000000099",
		"/projects/00000000-0000-4000-8000-000000000099/members",
		"/projects/00000000-0000-4000-8000-000000000099/settings",
		"/projects/00000000-0000-4000-8000-000000000099/tasks/00000000-0000-4000-8000-000000000001",
		"/projects/00000000-0000-4000-8000-000000000099/tasks/00000000-0000-4000-8000-000000000001?tab=attachments",
		"/projects/00000000-0000-4000-8000-000000000099/tasks/00000000-0000-4000-8000-000000000001/attachments/nested/plan.md",
		"/projects/00000000-0000-4000-8000-000000000099/tasks/00000000-0000-4000-8000-000000000001/attachments/nested/plan.md?tab=overview",
		asset[1],
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
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Task")
	for _, target := range []string{"/api/v1/projects", "/api/v1/projects/" + project.ID, "/api/v1/projects/" + project.ID + "/members", taskCollection(project.ID), taskPath(task), graphPath(project.ID)} {
		response := projectRequest(handler, http.MethodGet, target, "")
		if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "application/json" || strings.Contains(response.Body.String(), "<html") {
			t.Fatalf("UI registration changed API response: %s %d %+v", target, response.Code, response.Header())
		}
		if (target == taskPath(task) || target == graphPath(project.ID)) && response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("latest task read may be cached: %s %+v", target, response.Header())
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+project.ID+"/members", nil)
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
	if response.Header().Get("Content-Type") != "application/json" || strings.Contains(response.Body.String(), "<html") {
		t.Fatal("member API must retain authenticated JSON behavior")
	}
}

func TestUIErrorsCancellationAndFailedWriteUseSafeSingleBoundary(t *testing.T) {
	for _, err := range []error{errors.New("private-resource-path"), webui.ErrNotFound} {
		var logs bytes.Buffer
		logger := slog.New(slog.NewJSONHandler(&logs, nil))
		handler := RequestLogging(logger, uiHandler(logger, func(http.ResponseWriter, *http.Request) error { return err }))
		response := projectRequest(handler, http.MethodGet, "/", "")
		status, code := http.StatusInternalServerError, "internal_error"
		if errors.Is(err, webui.ErrNotFound) {
			status, code = http.StatusNotFound, "not_found"
		}
		assertProjectError(t, response, status, code)
		if strings.Contains(logs.String(), "private") || strings.Contains(response.Body.String(), "private") || strings.Count(logs.String(), `"type":"operation_error"`) != 1 || strings.Count(logs.String(), `"type":"http_request"`) != 1 {
			t.Fatalf("unsafe or duplicate UI error log: %s %s", response.Body, &logs)
		}
	}
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(ctx)
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	uiTestHandler(t, &logs).ServeHTTP(response, request)
	if response.Body.Len() != 0 || response.Header().Get("Content-Type") != "" || !strings.Contains(logs.String(), `"cause":"canceled"`) {
		t.Fatalf("canceled UI request wrote a response or lost cause: %s %s", response.Body, &logs)
	}
	logs.Reset()
	writer := &countFailedUIWriter{header: make(http.Header)}
	uiHandler(logger, webui.New().Page)(writer, httptest.NewRequest(http.MethodGet, "/", nil))
	if writer.writes != 1 || writer.status != http.StatusOK || strings.Contains(logs.String(), "private") || !strings.Contains(logs.String(), `"phase":"response"`) || strings.Count(logs.String(), `"type":"operation_error"`) != 1 {
		t.Fatalf("failed UI writer attempted a second response or lost safe error: %+v %s", writer, &logs)
	}
}

type countFailedUIWriter struct {
	header http.Header
	writes int
	status int
}

func (w *countFailedUIWriter) Header() http.Header    { return w.header }
func (w *countFailedUIWriter) WriteHeader(status int) { w.status = status }
func (w *countFailedUIWriter) Write([]byte) (int, error) {
	w.writes++
	return 0, errors.New("private-connection-error")
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
