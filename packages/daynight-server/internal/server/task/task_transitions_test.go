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
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestTaskHTTPStatusResultsAndSafeDiagnostics(t *testing.T) {
	for _, tc := range []struct {
		name, outcome string
		status        model.TaskStatus
		version       int64
	}{
		{"proposed", "changed", model.TaskProposed, 2},
		{"todo", "changed", model.TaskTodo, 2},
		{"in_progress", "changed", model.TaskInProgress, 2},
		{"done", "changed", model.TaskDone, 2},
		{"cancelled", "changed", model.TaskCancelled, 2},
		{"unchanged", "unchanged", model.TaskTodo, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			h := newHTTPFixture(t, &logs)
			result := testTask("private-title-secret")
			result.Status, result.Version, result.Ready = tc.status, tc.version, tc.status == model.TaskTodo
			h.Tasks.SetStatusFunc = func(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.SetTaskStatus) (model.Task, error) {
				if ctx.Err() != nil || principal != h.principal || projectID != testProjectID || id != testTaskID || input.Version != 1 || input.Status != tc.status || input.ClaimID != nil {
					t.Fatalf("status input: principal=%+v project=%s id=%s input=%+v context=%v", principal, projectID, id, input, ctx.Err())
				}
				return result, nil
			}
			response := projectRequest(h, http.MethodPut, taskCollection(testProjectID)+"/"+testTaskID+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: 1, Status: string(tc.status)}))
			actual := decodeResponse[api.Task](t, response, http.StatusOK)
			if actual.ID != result.ID || actual.ProjectID != result.ProjectID || actual.Status != string(tc.status) || actual.Version != tc.version || actual.Title != result.Title {
				t.Fatalf("status result projection: %+v", actual)
			}
			for _, fragment := range []string{`"route":"PUT /api/v1/projects/{projectId}/tasks/{taskId}/status"`, `"phase":"set_status"`, `"outcome":"` + tc.outcome + `"`, `"tx_outcome":"committed"`} {
				if !strings.Contains(logs.String(), fragment) {
					t.Fatalf("missing status diagnostic %s: %s", fragment, &logs)
				}
			}
			if strings.Contains(logs.String(), "secret") || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != testUserID {
				t.Fatalf("unsafe status metadata: headers=%v logs=%s", response.Header(), &logs)
			}
		})
	}
}

func TestTaskHTTPStatusStrictBodiesQueriesAndMethods(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	path := taskCollection(testProjectID) + "/" + testTaskID + "/status"
	for _, body := range []string{
		"", "null", "[]", "{", `{"version":1,"status":"todo",}`, `{"version":1,"status":"todo"} {}`, `{}`,
		`{"status":"todo"}`, `{"version":1}`, `{"version":null,"status":"todo"}`, `{"version":0,"status":"todo"}`, `{"version":-1,"status":"todo"}`,
		`{"version":"1","status":"todo"}`, `{"version":true,"status":"todo"}`, `{"version":[],"status":"todo"}`, `{"version":{},"status":"todo"}`,
		`{"version":1.0,"status":"todo"}`, `{"version":1e0,"status":"todo"}`, `{"version":9223372036854775808,"status":"todo"}`, `{"Version":1,"status":"todo"}`,
		`{"version":1,"version":1,"status":"todo"}`, `{"version":1,"ver\u0073ion":1,"status":"todo"}`,
		`{"version":1,"status":null}`, `{"version":1,"status":1}`, `{"version":1,"status":[]}`, `{"version":1,"status":{}}`,
		`{"version":1,"Status":"todo"}`, `{"version":1,"status":"todo","status":"todo"}`, `{"version":1,"status":"todo","sta\u0074us":"todo"}`, `{"version":1,"status":"todo","title":"changed"}`,
		`{"version":1,"status":"todo","unknown":"private-body-secret"}`, `{"version":1,"status":"todo","dependsOn":[]}`, `{"version":1,"status":"todo","requiredPlatform":null}`,
	} {
		t.Run(body, func(t *testing.T) {
			assertProjectError(t, projectRequest(h, http.MethodPut, path, body), http.StatusBadRequest, "invalid_input")
		})
	}
	for _, query := range []string{"", "version=1", "unknown=secret", "x=1&x=2", "x=%xx", "x=1;y=2", "&", "="} {
		assertProjectError(t, projectRequest(h, http.MethodPut, path+"?"+query, `{"version":1,"status":"todo"}`), http.StatusBadRequest, "invalid_input")
	}
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
		response := projectRequest(h, method, path, `{"version":1,"status":"todo"}`)
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != "PUT" {
			t.Fatalf("wrong Allow: %s", response.Header().Get("Allow"))
		}
	}
	request := httptest.NewRequest(http.MethodPut, path, strings.NewReader(`{"version":1,"status":"todo"}`))
	authorizeResourceRequest(h, request)
	request.Header.Set("Content-Type", "text/plain")
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
	for _, action := range []string{"approve", "unapprove", "claim", "complete"} {
		if response := projectRequest(h, http.MethodPost, taskCollection(testProjectID)+"/"+testTaskID+"/"+action, `{"version":1}`); response.Code != http.StatusNotFound {
			t.Fatalf("removed route %s remains available: %d", action, response.Code)
		}
	}
	if h.Tasks.TotalCalls() != 0 {
		t.Fatalf("protocol rejection called service %d times", h.Tasks.TotalCalls())
	}
	for _, status := range []string{"unknown", "Todo", " todo", ""} {
		t.Run("domain_"+status, func(t *testing.T) {
			f := newHTTPFixture(t, io.Discard)
			f.Tasks.SetStatusFunc = func(_ context.Context, _ model.Principal, _, _ string, input taskcore.SetTaskStatus) (model.Task, error) {
				if input.Status != model.TaskStatus(status) || input.Version != 1 {
					t.Fatalf("domain status was changed: %+v", input)
				}
				return model.Task{}, &model.Fault{Code: "invalid_input", Message: "Task status is invalid."}
			}
			assertProjectError(t, projectRequest(f, http.MethodPut, path, jsonBody(t, api.TaskStatusUpdateRequest{Version: 1, Status: status})), http.StatusBadRequest, "invalid_input")
		})
	}
}

func TestTaskHTTPStatusResourceScopeCanonicalIDsAndExactVersion(t *testing.T) {
	for _, resource := range []struct{ projectID, id string }{
		{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", testTaskID},
		{"00000000-0000-4000-8000-000000000099", testTaskID},
		{testProjectID, "00000000-0000-4000-8000-000000000099"},
	} {
		t.Run(resource.projectID+"/"+resource.id, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Tasks.SetStatusFunc = func(_ context.Context, _ model.Principal, projectID, id string, _ taskcore.SetTaskStatus) (model.Task, error) {
				if projectID != resource.projectID || id != resource.id {
					t.Fatalf("resource scope changed: %s %s", projectID, id)
				}
				return model.Task{}, &model.Fault{Code: "not_found", Message: "Task was not found."}
			}
			assertProjectError(t, projectRequest(h, http.MethodPut, taskCollection(resource.projectID)+"/"+resource.id+"/status", `{"version":1,"status":"done"}`), http.StatusNotFound, "not_found")
		})
	}
	var logs bytes.Buffer
	h := newHTTPFixture(t, &logs)
	for _, malformed := range []string{taskCollection("private-invalid-project-secret") + "/" + testTaskID, taskCollection(testProjectID) + "/private-invalid-task-secret"} {
		assertProjectError(t, projectRequest(h, http.MethodPut, malformed+"/status", `{"version":1,"status":"done"}`), http.StatusBadRequest, "invalid_input")
	}
	const version int64 = 9007199254740993
	result := testTask("private-title-secret")
	result.Status, result.Version = model.TaskDone, version+1
	claimID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	h.Tasks.SetStatusFunc = func(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.SetTaskStatus) (model.Task, error) {
		if ctx.Err() != nil || principal != h.principal || projectID != testProjectID || id != testTaskID || input.Version != version || input.Status != model.TaskDone || input.ClaimID == nil || *input.ClaimID != claimID {
			t.Fatalf("exact status input: %+v %s %s", input, projectID, id)
		}
		return result, nil
	}
	response := projectRequest(h, http.MethodPut, taskCollection(strings.ToUpper(testProjectID))+"/"+strings.ToUpper(testTaskID)+"/status", `{"version":`+strconv.FormatInt(version, 10)+`,"status":"done","claimId":"`+claimID+`"}`)
	actual := decodeResponse[api.Task](t, response, http.StatusOK)
	if actual.ID != testTaskID || actual.ProjectID != testProjectID || actual.Status != "done" || actual.Version != version+1 || !strings.Contains(response.Body.String(), `"version":9007199254740994`) {
		t.Fatalf("canonical exact status result: %+v", actual)
	}
	if strings.Contains(logs.String(), "secret") {
		t.Fatalf("resource diagnostics exposed data: %s", &logs)
	}
}

func TestTaskHTTPCompletionAtMaximumVersionAndNoOp(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	result := testTask("Maximum version")
	result.Status, result.Version = model.TaskDone, math.MaxInt64
	started, completed := result.CreatedAt, result.UpdatedAt
	result.StartedAt, result.CompletedAt = &started, &completed
	h.Tasks.ExpectCalls("SetStatus", 2)
	h.Tasks.SetStatusFunc = func(_ context.Context, _ model.Principal, _, _ string, input taskcore.SetTaskStatus) (model.Task, error) {
		want := int64(math.MaxInt64 - 1)
		if h.Tasks.Calls("SetStatus") == 2 {
			want = math.MaxInt64
		}
		if input.Version != want || input.Status != model.TaskDone {
			t.Fatalf("maximum version input: %+v", input)
		}
		return result, nil
	}
	for _, version := range []int64{math.MaxInt64 - 1, math.MaxInt64} {
		response := projectRequest(h, http.MethodPut, taskCollection(testProjectID)+"/"+testTaskID+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: version, Status: "done"}))
		actual := decodeResponse[api.Task](t, response, http.StatusOK)
		if actual.Version != math.MaxInt64 || actual.Status != "done" || !reflect.DeepEqual(actual.StartedAt, result.StartedAt) || !reflect.DeepEqual(actual.CompletedAt, result.CompletedAt) || !strings.Contains(response.Body.String(), `"version":9223372036854775807`) {
			t.Fatalf("maximum version projection: %+v", actual)
		}
	}
}

func TestTaskHTTPConcurrentStatusResultsRemainRequestScoped(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	h.Tasks.ExpectCalls("SetStatus", 2)
	entered := make(chan model.TaskStatus, 2)
	release := make(chan struct{})
	var releaseOnce sync.Once
	closeRelease := func() { releaseOnce.Do(func() { close(release) }) }
	result := testTask("Concurrent status")
	result.Status, result.Version = model.TaskInProgress, 2
	h.Tasks.SetStatusFunc = func(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.SetTaskStatus) (model.Task, error) {
		if principal != h.principal || projectID != testProjectID || id != testTaskID || input.Version != 1 {
			t.Errorf("concurrent status input: %+v", input)
		}
		entered <- input.Status
		select {
		case <-release:
		case <-ctx.Done():
			return model.Task{}, ctx.Err()
		}
		if input.Status == model.TaskDone {
			return model.Task{}, &model.Fault{Code: "version_conflict", Message: "Task version changed."}
		}
		return result, nil
	}
	responses := make(chan *httptest.ResponseRecorder, 2)
	var requests sync.WaitGroup
	requests.Add(2)
	finished := make(chan struct{})
	go func() { requests.Wait(); close(finished) }()
	t.Cleanup(func() {
		closeRelease()
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			t.Error("concurrent HTTP requests did not drain")
		}
	})
	for _, status := range []string{"in_progress", "done"} {
		go func() {
			defer requests.Done()
			responses <- projectRequest(h, http.MethodPut, taskCollection(testProjectID)+"/"+testTaskID+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: 1, Status: status}))
		}()
	}
	await(t, entered)
	await(t, entered)
	closeRelease()
	won, lost := 0, 0
	for range 2 {
		response := await(t, responses)
		if response.Code == http.StatusOK {
			actual := decodeResponse[api.Task](t, response, http.StatusOK)
			if actual.Status != "in_progress" || actual.Version != 2 {
				t.Fatalf("concurrent success changed: %+v", actual)
			}
			won++
		} else {
			assertProjectError(t, response, http.StatusConflict, "version_conflict")
			lost++
		}
	}
	if won != 1 || lost != 1 {
		t.Fatalf("request results crossed: successful=%d failed=%d", won, lost)
	}
}
