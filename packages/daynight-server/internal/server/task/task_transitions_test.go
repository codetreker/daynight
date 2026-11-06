package task_test

import (
	"bytes"
	"context"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestTaskHTTPStatusPairsAndStaleVersions(t *testing.T) {
	var logs bytes.Buffer
	handler := projectTestHandler(t, projectTestStore(t), &logs)
	project := taskProject(t, handler)
	for _, from := range []string{"todo", "in_progress", "done"} {
		for _, to := range []string{"todo", "in_progress", "done"} {
			t.Run(from+"_to_"+to, func(t *testing.T) {
				task := setHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "private-title-secret"), from)
				path := taskPath(task) + "/status"
				assertProjectError(t, projectRequest(handler, http.MethodPut, path, jsonBody(t, api.TaskStatusUpdateRequest{Version: task.Version + 1, Status: to})), http.StatusConflict, "version_conflict")
				after := setHTTPTask(t, handler, task, to)
				delta := int64(1)
				if from == to {
					delta = 0
				}
				if after.Status != to || after.Version != task.Version+delta {
					t.Fatalf("incorrect status assignment: before %+v after %+v", task, after)
				}
				if delta == 0 && !reflect.DeepEqual(task, after) {
					t.Fatal("same state changed persistent materials or timing")
				}
				if delta == 1 {
					assertProjectError(t, projectRequest(handler, http.MethodPut, path, jsonBody(t, api.TaskStatusUpdateRequest{Version: task.Version, Status: to})), http.StatusConflict, "version_conflict")
				}
				if !reflect.DeepEqual(readHTTPTask(t, handler, task), after) {
					t.Fatal("status result differs from stored task")
				}
			})
		}
	}
	for _, fragment := range []string{`"cause":"version_conflict"`, `"route":"PUT /api/v1/projects/{projectId}/tasks/{taskId}/status"`, `"phase":"set_status"`, `"outcome":"changed"`, `"outcome":"unchanged"`} {
		if !strings.Contains(logs.String(), fragment) {
			t.Fatalf("missing status diagnostic %s: %s", fragment, &logs)
		}
	}
	if strings.Contains(logs.String(), "secret") {
		t.Fatalf("task content leaked: %s", &logs)
	}
}

func TestTaskHTTPStatusStrictBodiesQueriesAndMethods(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	task := createHTTPTask(t, handler, taskProject(t, handler).ID, "Original")
	path := taskPath(task) + "/status"
	for _, body := range []string{
		"", "null", "[]", "{", `{"version":1,"status":"todo",}`, `{"version":1,"status":"todo"} {}`, `{}`,
		`{"status":"todo"}`, `{"version":1}`, `{"version":null,"status":"todo"}`, `{"version":0,"status":"todo"}`, `{"version":-1,"status":"todo"}`,
		`{"version":"1","status":"todo"}`, `{"version":true,"status":"todo"}`, `{"version":[],"status":"todo"}`, `{"version":{},"status":"todo"}`,
		`{"version":1.0,"status":"todo"}`, `{"version":1e0,"status":"todo"}`, `{"version":9223372036854775808,"status":"todo"}`, `{"Version":1,"status":"todo"}`,
		`{"version":1,"version":1,"status":"todo"}`, `{"version":1,"ver\u0073ion":1,"status":"todo"}`,
		`{"version":1,"status":null}`, `{"version":1,"status":1}`, `{"version":1,"status":[]}`, `{"version":1,"status":{}}`,
		`{"version":1,"status":"proposed"}`, `{"version":1,"status":"Todo"}`, `{"version":1,"status":" todo"}`, `{"version":1,"status":""}`,
		`{"version":1,"Status":"todo"}`, `{"version":1,"status":"todo","status":"todo"}`, `{"version":1,"status":"todo","sta\u0074us":"todo"}`, `{"version":1,"status":"todo","title":"changed"}`,
		`{"version":1,"status":"todo","unknown":"private-body-secret"}`, `{"version":1,"status":"todo","dependsOn":[]}`, `{"version":1,"status":"todo","requiredPlatform":null}`,
	} {
		t.Run(body, func(t *testing.T) {
			assertProjectError(t, projectRequest(handler, http.MethodPut, path, body), http.StatusBadRequest, "invalid_input")
		})
	}
	for _, query := range []string{"", "version=1", "unknown=secret", "x=1&x=2", "x=%xx", "x=1;y=2", "&", "="} {
		assertProjectError(t, projectRequest(handler, http.MethodPut, path+"?"+query, `{"version":1,"status":"todo"}`), http.StatusBadRequest, "invalid_input")
	}
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
		response := projectRequest(handler, method, path, `{"version":1,"status":"todo"}`)
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != "PUT" {
			t.Fatalf("wrong Allow: %s", response.Header().Get("Allow"))
		}
	}
	request := httptest.NewRequest(http.MethodPut, path, strings.NewReader(`{"version":1,"status":"todo"}`))
	authorizeResourceRequest(handler, request)
	request.Header.Set("Content-Type", "text/plain")
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
	if !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
		t.Fatal("invalid status request mutated task")
	}
	for _, action := range []string{"approve", "unapprove", "claim", "complete"} {
		response := projectRequest(handler, http.MethodPost, taskPath(task)+"/"+action, `{"version":1}`)
		if response.Code != http.StatusNotFound {
			t.Fatalf("removed route %s remains available: %d", action, response.Code)
		}
	}
}

func TestTaskHTTPStatusResourceScopeCanonicalIDsAndExactVersion(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project, other := taskProject(t, handler), taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "private-title-secret")
	missing := "00000000-0000-4000-8000-000000000099"
	for _, projectID := range []string{other.ID, missing} {
		assertProjectError(t, projectRequest(handler, http.MethodPut, taskCollection(projectID)+"/"+task.ID+"/status", `{"version":1,"status":"done"}`), http.StatusNotFound, "not_found")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPut, taskCollection(project.ID)+"/"+missing+"/status", `{"version":1,"status":"done"}`), http.StatusNotFound, "not_found")
	for _, path := range []string{taskCollection("private-invalid-project-secret") + "/" + task.ID, taskCollection(project.ID) + "/private-invalid-task-secret"} {
		assertProjectError(t, projectRequest(handler, http.MethodPut, path+"/status", `{"version":1,"status":"done"}`), http.StatusBadRequest, "invalid_input")
	}
	const version int64 = 9007199254740993
	if _, err := database.Pool.Exec(context.Background(), "UPDATE tasks SET version=$1 WHERE project_id=$2 AND id=$3", version, project.ID, task.ID); err != nil {
		t.Fatal(err)
	}
	after := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPut, taskCollection(strings.ToUpper(project.ID))+"/"+strings.ToUpper(task.ID)+"/status", `{"version":`+strconv.FormatInt(version, 10)+`,"status":"done"}`), http.StatusOK)
	if after.ID != task.ID || after.ProjectID != project.ID || after.Status != "done" || after.Version != version+1 {
		t.Fatalf("canonical exact status update: %+v", after)
	}
	if strings.Contains(logs.String(), "secret") {
		t.Fatalf("resource diagnostics exposed data: %s", &logs)
	}
}

func TestTaskHTTPCompletionAtMaximumVersionAndNoOp(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	task := createHTTPTask(t, handler, taskProject(t, handler).ID, "Maximum version")
	task = setHTTPTask(t, handler, task, "in_progress")
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET version=$1 WHERE id=$2`, int64(math.MaxInt64-1), task.ID); err != nil {
		t.Fatal(err)
	}
	before := readHTTPTask(t, handler, task)
	response := projectRequest(handler, http.MethodPut, taskPath(task)+"/status", `{"version":9223372036854775806,"status":"done"}`)
	completed := decodeResponse[api.Task](t, response, http.StatusOK)
	if completed.Status != "done" || completed.Version != math.MaxInt64 || !reflect.DeepEqual(completed.StartedAt, before.StartedAt) || completed.CompletedAt == nil || !strings.Contains(response.Body.String(), `"version":9223372036854775807`) {
		t.Fatalf("maximum version completion: %+v", completed)
	}
	if read := readHTTPTask(t, handler, task); !reflect.DeepEqual(read, completed) {
		t.Fatal("maximum version completion did not persist")
	}
	response = projectRequest(handler, http.MethodPut, taskPath(task)+"/status", `{"version":9223372036854775807,"status":"done"}`)
	confirmed := decodeResponse[api.Task](t, response, http.StatusOK)
	if !reflect.DeepEqual(confirmed, completed) || !reflect.DeepEqual(readHTTPTask(t, handler, task), completed) || !strings.Contains(response.Body.String(), `"version":9223372036854775807`) {
		t.Fatal("maximum version same-status request changed the task")
	}
}

func TestTaskHTTPStatusConcurrentChangeHasOneWinner(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	task := createHTTPTask(t, handler, taskProject(t, handler).ID, "Concurrent status")
	for _, status := range []string{"in_progress", "todo", "done", "in_progress"} {
		body := jsonBody(t, api.TaskStatusUpdateRequest{Version: task.Version, Status: status})
		start := make(chan struct{})
		responses := make(chan *httptest.ResponseRecorder, 2)
		for range 2 {
			go func() { <-start; responses <- projectRequest(handler, http.MethodPut, taskPath(task)+"/status", body) }()
		}
		close(start)
		var winner api.Task
		won, lost := 0, 0
		for range 2 {
			response := <-responses
			switch response.Code {
			case http.StatusOK:
				winner = decodeResponse[api.Task](t, response, http.StatusOK)
				won++
			case http.StatusConflict:
				assertProjectError(t, response, http.StatusConflict, "version_conflict")
				lost++
			default:
				t.Fatalf("unexpected response %d %s", response.Code, response.Body)
			}
		}
		if won != 1 || lost != 1 || winner.Status != status || winner.Version != task.Version+1 {
			t.Fatalf("concurrent assignment: %d %d %+v", won, lost, winner)
		}
		task = winner
	}
}
