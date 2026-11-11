package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func graphPath(projectID, taskID string) string {
	return "/api/v1/projects/" + projectID + "/task-graph?taskId=" + taskID
}

func graphModel() model.TaskGraph {
	task := testTask("Graph task")
	return model.TaskGraph{Project: testProject(), ObservedAt: task.UpdatedAt, Summary: model.TaskGraphSummary{Total: 1, Todo: 1, Ready: 1}, Tasks: []model.GraphTask{{ID: task.ID, TitlePreview: task.Title, Status: task.Status, Ready: true, CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt}}}
}

func TestTaskGraphHTTPCompleteProjectionAndSafeLogs(t *testing.T) {
	var logs bytes.Buffer
	handler := newHTTPFixture(t, &logs)
	stamp := testTime.Add(time.Hour)
	platform := model.TaskPlatform("linux")
	project := testProject()
	project.ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	root := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	parent := "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	result := model.TaskGraph{Project: project, ObservedAt: stamp, Summary: model.TaskGraphSummary{Total: 6, Proposed: 1, Todo: 2, InProgress: 1, Done: 2, Ready: 1, Blocked: 1}, Tasks: []model.GraphTask{
		{ID: root, Type: model.TaskTypeTask, ParentID: &parent, TitlePreview: "root-private-title", Status: model.TaskDone, CreatedAt: stamp, UpdatedAt: stamp, StartedAt: &stamp, CompletedAt: &stamp},
		{ID: "55555555-5555-4555-8555-555555555555", Type: model.TaskTypeTask, TitlePreview: "active-private-title", Status: model.TaskInProgress, DependsOn: []string{root}, CreatedAt: stamp, UpdatedAt: stamp, StartedAt: &stamp},
		{ID: "66666666-6666-4666-8666-666666666666", TitlePreview: strings.Repeat("🙂", 160), TitleTruncated: true, Status: model.TaskTodo, Ready: true, DependsOn: []string{root}, RequiredPlatform: &platform, AllowAgents: true, CreatedAt: stamp, UpdatedAt: stamp},
		{ID: "77777777-7777-4777-8777-777777777777", TitlePreview: "blocked-private-title", Status: model.TaskTodo, DependsOn: []string{"55555555-5555-4555-8555-555555555555", root}, BlockedBy: []string{"55555555-5555-4555-8555-555555555555"}, CreatedAt: stamp, UpdatedAt: stamp},
		{ID: "88888888-8888-4888-8888-888888888888", TitlePreview: "done-private-title", Status: model.TaskDone, DependsOn: []string{root}, CreatedAt: stamp, UpdatedAt: stamp, StartedAt: &stamp, CompletedAt: &stamp},
		{ID: "99999999-9999-4999-8999-999999999999", TitlePreview: "proposed-private-title", Status: model.TaskProposed, CreatedAt: stamp, UpdatedAt: stamp},
	}}
	for i := range result.Tasks {
		result.Tasks[i].Type = model.TaskTypeTask
	}
	handler.Tasks.GraphFunc = func(ctx context.Context, principal model.Principal, projectID, taskID string) (model.TaskGraph, error) {
		if principal != handler.principal || projectID != project.ID || taskID != strings.ToUpper(root) || ctx.Err() != nil {
			t.Fatalf("graph arguments: %+v %s %s", principal, projectID, taskID)
		}
		return result, nil
	}
	response := projectRequest(handler, http.MethodGet, graphPath(strings.ToUpper(project.ID), strings.ToUpper(root)), "")
	graph := decodeResponse[api.TaskGraph](t, response, http.StatusOK)
	if graph.Project.ID != project.ID || graph.Project.Name != project.Name || graph.Project.RepoURL != project.RepoURL || graph.Project.CreatedAt != project.CreatedAt || graph.Project.UpdatedAt != project.UpdatedAt || graph.ObservedAt != stamp || graph.Summary != (api.TaskGraphSummary{Total: 6, Proposed: 1, Todo: 2, InProgress: 1, Done: 2, Ready: 1, Blocked: 1}) || len(graph.Tasks) != 6 || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("X-Request-ID") != "project-test" {
		t.Fatalf("graph=%+v headers=%+v", graph, response.Header())
	}
	for i, task := range graph.Tasks {
		expected := result.Tasks[i]
		if task.ID != expected.ID || task.Type != string(expected.Type) || !reflect.DeepEqual(task.ParentID, expected.ParentID) || task.TitlePreview != expected.TitlePreview || task.TitleTruncated != expected.TitleTruncated || task.Status != string(expected.Status) || task.Ready != expected.Ready || task.AllowAgents != expected.AllowAgents || !slices.Equal(task.DependsOn, expected.DependsOn) || !slices.Equal(task.ExternalDependsOn, expected.ExternalDependsOn) || !slices.Equal(task.BlockedBy, expected.BlockedBy) || task.DependsOn == nil || task.BlockedBy == nil || task.CreatedAt != expected.CreatedAt || task.UpdatedAt != expected.UpdatedAt || !reflect.DeepEqual(task.StartedAt, expected.StartedAt) || !reflect.DeepEqual(task.CompletedAt, expected.CompletedAt) || !reflect.DeepEqual(task.CancelledAt, expected.CancelledAt) {
			t.Fatalf("projection %d=%+v want=%+v", i, task, expected)
		}
	}
	if graph.Tasks[2].RequiredPlatform == nil || *graph.Tasks[2].RequiredPlatform != "linux" {
		t.Fatalf("platform=%+v", graph.Tasks[2])
	}
	var raw struct {
		Summary map[string]json.RawMessage   `json:"summary"`
		Tasks   []map[string]json.RawMessage `json:"tasks"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw.Summary) != 8 {
		t.Fatalf("summary=%+v", raw.Summary)
	}
	for _, task := range raw.Tasks {
		if len(task) != 18 {
			t.Fatalf("fields=%+v", task)
		}
		for _, field := range []string{"title", "description", "version", "projectId", "properties", "pullRequests"} {
			if _, exists := task[field]; exists {
				t.Fatalf("unexpected detail %s", field)
			}
		}
	}
	if string(raw.Tasks[0]["type"]) != `"task"` || string(raw.Tasks[0]["parentId"]) != `"`+parent+`"` || string(raw.Tasks[1]["parentId"]) != "null" {
		t.Fatalf("typed graph fields: %+v %+v", raw.Tasks[0], raw.Tasks[1])
	}
	for _, fragment := range []string{`"component":"task_graph"`, `"project_id":"` + project.ID + `"`, `"node_count":6`, `"edge_count":5`, `"duration":`, `"request_id":"project-test"`} {
		if !strings.Contains(logs.String(), fragment) {
			t.Fatalf("missing %s: %s", fragment, &logs)
		}
	}
	for _, secret := range []string{"private-title", "initial description", "github.com", "🙂"} {
		if strings.Contains(logs.String(), secret) {
			t.Fatalf("graph leaked %q: %s", secret, &logs)
		}
	}
}

func TestTaskGraphHTTPEmptyMissingQueryAndMethods(t *testing.T) {
	var logs bytes.Buffer
	handler := newHTTPFixture(t, &logs)
	assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects/"+testProjectID+"/task-graph", ""), http.StatusBadRequest, "invalid_input")
	for _, query := range []string{"limit=50", "cursor=token-secret", "status=todo", "ready=true", "unknown=secret", "limit=", "%xx", "x=%xx", ";", "=", "x=1&x=2", "taskId=", "taskId=" + testTaskID, "taskId=%xx"} {
		response := projectRequest(handler, http.MethodGet, graphPath(testProjectID, testTaskID)+"&"+query, "")
		assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("query error cacheable")
		}
	}
	for _, projectID := range []string{"invalid-private-secret", "00000000-0000-4000-8000-00000000000z"} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, graphPath(projectID, testTaskID), ""), http.StatusBadRequest, "invalid_input")
	}
	for _, method := range []string{http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
		response := projectRequest(handler, method, graphPath(testProjectID, testTaskID), "private-body-secret")
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != "GET, HEAD" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("headers=%+v", response.Header())
		}
	}
	if handler.Tasks.TotalCalls() != 0 {
		t.Fatalf("protocol rejection reached service: %d calls", handler.Tasks.TotalCalls())
	}
	handler.Tasks.GraphFunc = func(ctx context.Context, principal model.Principal, projectID, taskID string) (model.TaskGraph, error) {
		if projectID != testProjectID || taskID != testTaskID || principal != handler.principal {
			t.Fatalf("arguments=%s %s %+v", projectID, taskID, principal)
		}
		return graphModel(), nil
	}
	handler.Tasks.ExpectCalls("Graph", 2)
	graph := decodeResponse[api.TaskGraph](t, projectRequest(handler, http.MethodGet, graphPath(testProjectID, testTaskID), ""), http.StatusOK)
	if graph.Summary != (api.TaskGraphSummary{Total: 1, Todo: 1, Ready: 1}) || len(graph.Tasks) != 1 || graph.Tasks[0].ID != testTaskID {
		t.Fatalf("isolated graph=%+v", graph)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	request, err := http.NewRequest(http.MethodHead, server.URL+graphPath(testProjectID, testTaskID), nil)
	if err != nil {
		t.Fatal(err)
	}
	authorizeResourceRequest(handler, request)
	request.Header.Set("X-Request-ID", "project-test")
	head, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(head.Body)
	head.Body.Close()
	if readErr != nil || len(body) != 0 || head.StatusCode != http.StatusOK || head.Header.Get("Content-Type") != "application/json" || head.Header.Get("Cache-Control") != "no-store" || head.Header.Get("X-Request-ID") != "project-test" {
		t.Fatalf("HEAD=%+v body=%q err=%v", head, body, readErr)
	}
	if strings.Contains(logs.String(), "secret") {
		t.Fatalf("input leaked: %s", &logs)
	}
	for _, tc := range []struct {
		projectID, taskID, code string
		status                  int
	}{
		{"00000000-0000-4000-8000-000000000099", testTaskID, "not_found", 404},
		{testProjectID, "00000000-0000-4000-8000-000000000099", "not_found", 404},
		{testProjectID, "invalid", "invalid_input", 400}, {testProjectID, "00000000-0000-4000-8000-00000000000z", "invalid_input", 400},
	} {
		t.Run(tc.projectID+"/"+tc.taskID, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Tasks.GraphFunc = func(ctx context.Context, p model.Principal, pid, tid string) (model.TaskGraph, error) {
				if pid != tc.projectID || tid != tc.taskID {
					t.Fatalf("ids=%s %s", pid, tid)
				}
				return model.TaskGraph{}, &model.Fault{Code: tc.code, Message: "Domain refusal."}
			}
			assertProjectError(t, projectRequest(h, http.MethodGet, graphPath(tc.projectID, tc.taskID), ""), tc.status, tc.code)
		})
	}
}

func TestTaskGraphHTTPDatabaseFailureAndCancellation(t *testing.T) {
	var logs bytes.Buffer
	handler := newHTTPFixture(t, &logs)
	started, finished := make(chan struct{}), make(chan struct{})
	handler.Tasks.GraphFunc = func(ctx context.Context, principal model.Principal, pid, tid string) (model.TaskGraph, error) {
		if principal != handler.principal || pid != testProjectID || tid != testTaskID {
			t.Errorf("graph arguments=%+v %s %s", principal, pid, tid)
		}
		close(started)
		<-ctx.Done()
		close(finished)
		return model.TaskGraph{}, ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request := httptest.NewRequest(http.MethodGet, graphPath(testProjectID, testTaskID), nil).WithContext(ctx)
	authorizeResourceRequest(handler, request)
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	served := make(chan struct{})
	go func() { handler.ServeHTTP(response, request); close(served) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("graph operation did not start")
	}
	cancel()
	await(t, finished)
	await(t, served)
	if response.Body.Len() != 0 || response.Header().Get("Content-Type") != "" || !strings.Contains(logs.String(), `"cause":"canceled"`) {
		t.Fatalf("canceled response=%s logs=%s", response.Body, &logs)
	}
	failure := newHTTPFixture(t, &logs)
	failure.Tasks.GraphFunc = func(context.Context, model.Principal, string, string) (model.TaskGraph, error) {
		return model.TaskGraph{}, &store.Error{Phase: "query", DatabaseFailure: true, Cause: errors.New("private_sql_secret")}
	}
	result := projectRequest(failure, http.MethodGet, graphPath(testProjectID, testTaskID), "")
	assertProjectError(t, result, 500, "internal_error")
	if strings.Contains(result.Body.String(), "secret") || strings.Contains(logs.String(), "secret") || !strings.Contains(logs.String(), `"cause":"database"`) {
		t.Fatalf("database failure=%s logs=%s", result.Body, &logs)
	}
}

func TestTaskGraphHTTPErrorPrecedenceAndDTOUTC(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	for _, cause := range []error{&store.Error{Phase: "query", DatabaseFailure: true, Cause: errors.New("driver-secret")}, context.Canceled, context.DeadlineExceeded} {
		err := errors.Join(&model.Fault{Code: "task_deleted", Message: "domain-secret"}, cause)
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/", nil)
		request.Header.Set("X-Request-ID", "project-test")
		httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
			httpx.WriteError(w, request, logger, "task_graph", "get", err)
		})).ServeHTTP(response, request)
		assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
		value := decodeResponse[api.ErrorResponse](t, response, http.StatusInternalServerError)
		if value.Error.Details != nil {
			t.Fatalf("operational failure exposed domain details: %+v", value)
		}
	}
	if strings.Contains(logs.String(), "secret") {
		t.Fatalf("operational graph error leaked: %s", &logs)
	}
	instant := time.Date(2026, 10, 20, 16, 12, 0, 123456000, time.FixedZone("offset", 8*60*60))
	result := taskhttp.TaskGraphResponse(model.TaskGraph{Project: model.Project{CreatedAt: instant, UpdatedAt: instant}, ObservedAt: instant,
		Tasks: []model.GraphTask{{ID: "task", CreatedAt: instant, UpdatedAt: instant, StartedAt: &instant, CompletedAt: &instant}}})
	if result.Project.CreatedAt.Location() != time.UTC || result.Project.UpdatedAt.Location() != time.UTC ||
		result.Tasks[0].CreatedAt.Location() != time.UTC || result.Tasks[0].UpdatedAt.Location() != time.UTC ||
		result.ObservedAt.Location() != time.UTC || result.Tasks[0].StartedAt.Location() != time.UTC || result.Tasks[0].CompletedAt.Location() != time.UTC ||
		!result.Tasks[0].CreatedAt.Equal(instant) || !reflect.DeepEqual(result.Tasks[0].DependsOn, []string{}) || !reflect.DeepEqual(result.Tasks[0].BlockedBy, []string{}) {
		t.Fatalf("graph DTO UTC and empty-array conversion: %+v", result)
	}
}

func TestTaskHTTPTodoReadContractWithoutGenericStatusWrites(t *testing.T) {
	handler := newHTTPFixture(t, io.Discard)
	ready := testTask("Ready")
	ready.Description = "Complete ready description"
	ready.Ready = true
	blocked := testTask("Blocked")
	blocked.ID = "55555555-5555-4555-8555-555555555555"
	blocked.Ready = false
	blocked.BlockedBy = []string{testTaskID}
	values := []model.Task{ready, blocked}
	handler.Tasks.ExpectCalls("Observe", 2)
	handler.Tasks.ObserveFunc = func(ctx context.Context, principal model.Principal, pid, id string) (taskservice.TaskObservation, error) {
		for _, value := range values {
			if value.ID == id {
				return taskservice.TaskObservation{Task: value, Epoch: testEpoch}, nil
			}
		}
		t.Fatalf("unexpected id %s", id)
		return taskservice.TaskObservation{}, nil
	}
	for _, value := range values {
		got := decodeResponse[api.Task](t, projectRequest(handler, http.MethodGet, taskCollection(testProjectID)+"/"+value.ID, ""), 200)
		if got.ID != value.ID || got.Status != "todo" || got.Ready != value.Ready || got.Description != value.Description || got.Version != value.Version || !slices.Equal(got.BlockedBy, value.BlockedBy) {
			t.Fatalf("projection=%+v want=%+v", got, value)
		}
	}
	cursor := "next-private-cursor"
	calls := 0
	handler.Tasks.ExpectCalls("List", 3)
	handler.Tasks.ListFunc = func(ctx context.Context, principal model.Principal, pid string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
		calls++
		if principal != handler.principal || pid != testProjectID {
			t.Fatalf("list identity=%+v %s", principal, pid)
		}
		switch calls {
		case 1:
			if input.Limit != 1 || input.Cursor != nil {
				t.Fatalf("first input=%+v", input)
			}
			return taskservice.TaskPage{Items: []model.Task{ready}, NextCursor: &cursor}, nil
		case 2:
			if input.Limit != 1 || input.Cursor == nil || *input.Cursor != cursor {
				t.Fatalf("continuation=%+v", input)
			}
			return taskservice.TaskPage{Items: []model.Task{blocked}}, nil
		default:
			if input.Status == nil || *input.Status != model.TaskTodo {
				t.Fatalf("status=%+v", input)
			}
			return taskservice.TaskPage{Items: values}, nil
		}
	}
	first := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, taskCollection(testProjectID)+"?limit=1", ""), 200)
	next := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, taskCollection(testProjectID)+"?limit=1&cursor="+*first.NextCursor, ""), 200)
	if len(first.Items) != 1 || first.Items[0].ID != ready.ID || len(next.Items) != 1 || next.Items[0].ID != blocked.ID || next.NextCursor != nil {
		t.Fatalf("pages=%+v %+v", first, next)
	}
	filtered := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, taskCollection(testProjectID)+"?status=todo", ""), 200)
	if len(filtered.Items) != 2 {
		t.Fatalf("filtered=%+v", filtered)
	}
	handler.Tasks.GraphFunc = func(context.Context, model.Principal, string, string) (model.TaskGraph, error) {
		result := graphModel()
		result.Tasks[0].Ready = true
		return result, nil
	}
	graph := decodeResponse[api.TaskGraph](t, projectRequest(handler, http.MethodGet, graphPath(testProjectID, ready.ID), ""), 200)
	if len(graph.Tasks) != 1 || !graph.Tasks[0].Ready || len(graph.Tasks[0].BlockedBy) != 0 {
		t.Fatalf("ready graph=%+v", graph)
	}
}
