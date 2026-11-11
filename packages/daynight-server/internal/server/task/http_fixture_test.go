package task_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

const (
	testProjectID = "a1111111-a111-4111-8111-a11111111111"
	testTaskID    = "b2222222-b222-4222-8222-b22222222222"
	testUserID    = "c3333333-c333-4333-8333-c33333333333"
	testStepID    = "abcdef01"
	testEpoch     = "d4444444-d444-4444-8444-d44444444444"
)

var testTime = time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC)

func testPrincipal() model.Principal {
	return model.Principal{UserID: testUserID, CredentialID: "e5555555-e555-4555-8555-e55555555555", Kind: model.PATCredential}
}

func testTask(title string) model.Task {
	return model.Task{
		ID: testTaskID, Type: model.TaskTypeTask, ProjectID: testProjectID, Title: title,
		Description: "Task-owned Markdown", Properties: model.TaskProperties{},
		Status: model.TaskTodo, Version: 1, CreatedAt: testTime, UpdatedAt: testTime,
		DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Ready: true,
	}
}

func testProject() model.Project {
	return model.Project{ID: testProjectID, Name: "Task project", RepoURL: "https://github.com/example/tasks", CreatedAt: testTime, UpdatedAt: testTime}
}

type resourceTestHandler struct {
	http.Handler
	*serviceCalls
	token            string
	principal        model.Principal
	Tasks            *taskServiceMock
	Observations     *observationServiceMock
	Steps            *stepsServiceMock
	Threads          *threadsServiceMock
	Search           taskhttp.SearchOperation
	Sync             taskhttp.SyncOperation
	AuthenticateFunc authhttp.AuthenticateCredential
}

func newHTTPFixture(t *testing.T, output io.Writer) *resourceTestHandler {
	t.Helper()
	handler := &resourceTestHandler{
		serviceCalls: newServiceCalls(t), token: "test-pat", principal: testPrincipal(),
		Tasks:        newTaskServiceMock(t),
		Observations: newObservationServiceMock(t),
		Steps:        newStepsServiceMock(t),
		Threads:      newThreadsServiceMock(t),
	}
	handler.required = func() []string {
		var methods []string
		if handler.Search != nil {
			methods = append(methods, "Search")
		}
		if handler.Sync != nil {
			methods = append(methods, "Sync")
		}
		return methods
	}
	handler.AuthenticateFunc = func(_ context.Context, kind model.CredentialKind, credential string) (model.Principal, error) {
		if kind != model.PATCredential || credential != handler.token {
			return model.Principal{}, authhttp.Failure()
		}
		return handler.principal, nil
	}
	logger := slog.New(slog.NewJSONHandler(output, nil))
	auth, err := authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, credential string) (model.Principal, error) {
		return handler.AuthenticateFunc(ctx, kind, credential)
	}, config.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	taskhttp.TaskRoutes(mux, handler.Tasks, handler.Observations, auth, logger)
	taskhttp.TaskStepsRoutes(mux, handler.Steps, auth, logger)
	taskhttp.TaskThreadRoutes(mux, handler.Threads, auth, logger)
	taskhttp.TaskSearchRoutes(mux, func(ctx context.Context, principal model.Principal, projectID string, input tasksearch.Request) (tasksearch.Page, error) {
		if err := handler.check("Search", handler.Search != nil); err != nil {
			return tasksearch.Page{}, err
		}
		return handler.Search(ctx, principal, projectID, input)
	}, auth, logger)
	taskhttp.TaskSyncRoutes(mux, func(ctx context.Context, principal model.Principal, projectID string, input taskservice.TaskSyncRequest) (model.TaskSync, error) {
		if err := handler.check("Sync", handler.Sync != nil); err != nil {
			return model.TaskSync{}, err
		}
		return handler.Sync(ctx, principal, projectID, input)
	}, auth, logger, 10*time.Second)
	handler.Handler = httpx.RequestLogging(logger, httpx.LimitRequestTarget(logger, mux))
	return handler
}

func projectRequest(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(handler, request)
	request.Header.Set("Content-Type", "application/json; charset=UTF-8")
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeResponse[T any](t *testing.T, response *httptest.ResponseRecorder, status int) T {
	t.Helper()
	if response.Code != status || response.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("unexpected response: %d %s", response.Code, response.Body)
	}
	var value T
	if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func assertProjectError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	value := decodeResponse[api.ErrorResponse](t, response, status)
	if value.Error.Code != code || value.Error.Message == "" || value.Error.RequestID != response.Header().Get("X-Request-ID") || value.Error.RequestID != "project-test" {
		t.Fatalf("unexpected error correlation: %+v", value)
	}
}

func jsonBody(t *testing.T, input any) string {
	t.Helper()
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func taskCollection(id string) string { return "/api/v1/projects/" + id + "/tasks" }
func taskPath(task api.Task) string   { return taskCollection(task.ProjectID) + "/" + task.ID }

func authorizeResourceRequest(handler http.Handler, request *http.Request) {
	if fixture, ok := handler.(*resourceTestHandler); ok {
		request.Header.Set("Authorization", "Bearer "+fixture.token)
	}
}

type threadFailingWriter struct {
	*httptest.ResponseRecorder
	short bool
	calls int
}

func (writer *threadFailingWriter) Write([]byte) (int, error) {
	writer.calls++
	if writer.short {
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
