package task_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/appsupport"
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
func projectTestHandler(t *testing.T, database *postgres.Store, output io.Writer) *resourceTestHandler {
	t.Helper()
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	instance := httptest.NewUnstartedServer(nil)
	t.Cleanup(instance.Close)
	origin := "http://" + instance.Listener.Addr().String()
	callback := origin + "/api/v1/auth/callback"
	gateway := testauth.StartGateway(t, callback)
	config := configpkg.Config{DatabaseURL: "postgres://database", StorageRoot: "storage", ListenAddress: "127.0.0.1:0", StartupTimeout: 5 * time.Second, ShutdownTimeout: time.Second, TaskSyncOverlap: 10 * time.Second, PublicOrigin: origin, UniAuthURL: gateway.Origin, UniAuthAppID: gateway.AppID, UniAuthAppSecret: gateway.AppSecret, UniAuthCallbackURL: callback, AllowHTTPTestOrigin: true, AllowLoopbackHTTP: true}
	logger := slog.New(slog.NewJSONHandler(output, nil))
	handler, err := appsupport.NewHandler(config, database, database.Ready, files, logger)
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

type threadFailingWriter struct {
	*httptest.ResponseRecorder
	short bool
	calls int
}

func (w *threadFailingWriter) Write(data []byte) (int, error) {
	w.calls++
	if w.short {
		return 0, nil
	}
	return 0, errors.New("private response failure")
}

func await[T any](t *testing.T, channel <-chan T) T {
	t.Helper()
	select {
	case result := <-channel:
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for result")
	}
	var zero T
	return zero
}
