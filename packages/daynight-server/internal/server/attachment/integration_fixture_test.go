package attachment_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"encoding/json"
	"github.com/codetreker/daynight/packages/daynight-server/api"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	server "github.com/codetreker/daynight/packages/daynight-server/internal/server"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

type resourceTestHandler struct {
	http.Handler
	token     string
	principal model.Principal
}

func projectTestStore(t *testing.T) *postgres.Store { return testsupport.TestStore(t) }
func resourceTestServer(t *testing.T, database *postgres.Store, files filestorage.Storage, output io.Writer) *resourceTestHandler {
	t.Helper()
	instance := httptest.NewUnstartedServer(nil)
	t.Cleanup(instance.Close)
	origin := "http://" + instance.Listener.Addr().String()
	callback := origin + "/api/v1/auth/callback"
	gateway := testauth.StartGateway(t, callback)
	config := server.Config{DatabaseURL: "postgres://database", StorageRoot: "storage", ListenAddress: "127.0.0.1:0", StartupTimeout: 5 * time.Second, ShutdownTimeout: time.Second, TaskSyncOverlap: 10 * time.Second, PublicOrigin: origin, UniAuthURL: gateway.Origin, UniAuthAppID: gateway.AppID, UniAuthAppSecret: gateway.AppSecret, UniAuthCallbackURL: callback, AllowHTTPTestOrigin: true, AllowLoopbackHTTP: true}
	logger := slog.New(slog.NewJSONHandler(output, nil))
	handler, err := server.New(server.Dependencies{Store: database, Files: files}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	instance.Config.Handler = httpx.RequestLogging(logger, handler)
	instance.Start()
	browser := testauth.Browser(t)
	testauth.Login(t, browser, origin, "alice")
	token := testauth.CreatePAT(t, browser, origin)
	client, err := uniauth.New(uniauth.Config{BaseURL: gateway.Origin, AppID: gateway.AppID, AppSecret: gateway.AppSecret, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	principal, err := identityservice.New(database, client, callback).Authenticate(context.Background(), model.PATCredential, token)
	if err != nil {
		t.Fatal(err)
	}
	return &resourceTestHandler{Handler: instance.Config.Handler, token: token, principal: principal}
}
func projectRequest(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if h, ok := handler.(*resourceTestHandler); ok {
		request.Header.Set("Authorization", "Bearer "+h.token)
	}
	request.Header.Set("Content-Type", "application/json; charset=UTF-8")
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
func decodeResponse[T any](t *testing.T, response *httptest.ResponseRecorder, status int) T {
	return testsupport.DecodeResponse[T](t, response, status)
}
func assertProjectError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	testsupport.AssertProjectError(t, response, status, code)
}
func jsonBody(t *testing.T, input any) string { return testsupport.JSONBody(t, input) }
func taskCollection(id string) string         { return "/api/v1/projects/" + id + "/tasks" }
func taskPath(task api.Task) string           { return taskCollection(task.ProjectID) + "/" + task.ID }
func taskProject(t *testing.T, handler http.Handler) api.Project {
	t.Helper()
	return decodeResponse[api.Project](t, projectRequest(handler, "POST", "/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "Task project", RepoURL: "https://github.com/example/tasks", ExpectedUserID: handler.(*resourceTestHandler).principal.UserID})), 201)
}
func createHTTPTask(t *testing.T, handler http.Handler, projectID, title string, dependencies ...string) api.Task {
	t.Helper()
	return decodeResponse[api.Task](t, projectRequest(handler, "POST", taskCollection(projectID), jsonBody(t, map[string]any{"title": title, "description": "initial description", "dependsOn": append([]string{}, dependencies...)})), 201)
}
func updateHTTPTask(t *testing.T, handler http.Handler, task api.Task, values map[string]any) api.Task {
	t.Helper()
	values["version"] = task.Version
	return decodeResponse[api.Task](t, projectRequest(handler, "PATCH", taskPath(task), jsonBody(t, values)), 200)
}
func setHTTPTask(t *testing.T, handler http.Handler, task api.Task, status string) api.Task {
	t.Helper()
	return decodeResponse[api.Task](t, projectRequest(handler, "PUT", taskPath(task)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: task.Version, Status: status})), 200)
}
func readHTTPTask(t *testing.T, handler http.Handler, task api.Task) api.Task {
	t.Helper()
	return decodeResponse[api.Task](t, projectRequest(handler, "GET", taskPath(task), ""), 200)
}

func authorizeResourceRequest(handler http.Handler, request *http.Request) {
	if h, ok := handler.(*resourceTestHandler); ok {
		request.Header.Set("Authorization", "Bearer "+h.token)
	}
}

func uiTestHandler(t *testing.T, output io.Writer) http.Handler {
	t.Helper()
	logger := slog.New(slog.NewJSONHandler(output, nil))
	config := server.Config{DatabaseURL: "postgres://database", StorageRoot: "storage", ListenAddress: "127.0.0.1:0", StartupTimeout: 5 * time.Second, ShutdownTimeout: time.Second, TaskSyncOverlap: 10 * time.Second, PublicOrigin: "https://daynight.example", UniAuthURL: "https://auth.example", UniAuthAppID: "configuration-test", UniAuthAppSecret: "configuration-test", UniAuthCallbackURL: "https://daynight.example/api/v1/auth/callback"}
	handler, err := server.New(server.Dependencies{}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	return httpx.RequestLogging(logger, handler)
}

func rawProperty(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func apiPullRequests(t *testing.T, properties api.TaskProperties) []api.PullRequestProperty {
	t.Helper()
	raw, exists := properties["pullRequests"]
	if !exists {
		return nil
	}
	var value []api.PullRequestProperty
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		t.Fatalf("invalid pullRequests property: %s: %v", raw, err)
	}
	return value
}
