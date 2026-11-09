package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskGetHistoricalOversizeRefusesBeforeSuccess(t *testing.T) {
	var logs bytes.Buffer
	handler := newHTTPFixture(t, &logs)
	task := testTask("Historical")
	task.Description = strings.Repeat("<", 100000)
	handler.Tasks.ObserveRESTFunc = func(ctx context.Context, p model.Principal, pid, id string, extended bool) (taskservice.TaskObservation, error) {
		if pid != testProjectID || id != testTaskID || p != handler.principal || extended {
			t.Fatalf("observation=%+v %s %s extended=%t", p, pid, id, extended)
		}
		return taskservice.TaskObservation{Task: task, Epoch: testEpoch}, nil
	}
	response := projectRequest(handler, http.MethodGet, taskCollection(testProjectID)+"/"+testTaskID, "")
	assertProjectError(t, response, http.StatusConflict, "resource_limit_exceeded")
	if response.Header().Get("Daynight-Task-Epoch") != "" {
		t.Fatalf("success epoch on refusal: %v", response.Header())
	}
}

func TestTaskPageBudgetContinuesWithLookahead(t *testing.T) {
	handler := newHTTPFixture(t, new(bytes.Buffer))
	tasks := make([]model.Task, 10)
	for i := range tasks {
		tasks[i] = testTask(fmt.Sprintf("Candidate %d", i))
		tasks[i].ID = fmt.Sprintf("00000000-0000-4000-8000-%012d", i+10)
		tasks[i].Description = strings.Repeat("<", 80000)
	}
	cursor := "private-page-cursor"
	calls := 0
	handler.Tasks.ExpectCalls("List", 2)
	handler.Tasks.ListFunc = func(ctx context.Context, p model.Principal, pid string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
		calls++
		if pid != testProjectID || p != handler.principal || input.Limit != 100 {
			t.Fatalf("list input=%+v", input)
		}
		if calls == 1 {
			if input.Cursor != nil {
				t.Fatal("unexpected first cursor")
			}
			return taskservice.TaskPage{Items: tasks[:5], NextCursor: &cursor}, nil
		}
		if input.Cursor == nil || *input.Cursor != cursor {
			t.Fatalf("continuation=%+v", input)
		}
		return taskservice.TaskPage{Items: tasks[5:]}, nil
	}
	firstResponse := projectRequest(handler, http.MethodGet, taskCollection(testProjectID)+"?limit=100", "")
	first := decodeResponse[api.TaskPage](t, firstResponse, 200)
	if firstResponse.Body.Len() > 4<<20 || first.NextCursor == nil || *first.NextCursor != cursor || len(first.Items) != 5 {
		t.Fatalf("first size=%d page=%+v", firstResponse.Body.Len(), first)
	}
	nextResponse := projectRequest(handler, http.MethodGet, taskCollection(testProjectID)+"?limit=100&cursor="+url.QueryEscape(*first.NextCursor), "")
	next := decodeResponse[api.TaskPage](t, nextResponse, 200)
	if nextResponse.Body.Len() > 4<<20 || next.NextCursor != nil || len(next.Items) != 5 {
		t.Fatalf("next size=%d page=%+v", nextResponse.Body.Len(), next)
	}
	all := append(first.Items, next.Items...)
	for i, item := range all {
		if item.ID != tasks[i].ID || item.Description != tasks[i].Description {
			t.Fatalf("item %d=%+v", i, item)
		}
	}
}

func TestTaskPageOversizedFirstItemRefusesWithoutPartialPage(t *testing.T) {
	handler := newHTTPFixture(t, new(bytes.Buffer))
	handler.Tasks.ListFunc = func(context.Context, model.Principal, string, taskservice.TaskListRequest) (taskservice.TaskPage, error) {
		return taskservice.TaskPage{}, &model.Fault{Code: "resource_limit_exceeded", Message: "Task page exceeds the encoded resource limit."}
	}
	response := projectRequest(handler, http.MethodGet, taskCollection(testProjectID)+"?limit=100", "")
	assertProjectError(t, response, 409, "resource_limit_exceeded")
	if strings.Contains(response.Body.String(), `"items"`) {
		t.Fatalf("partial page=%s", response.Body)
	}
}

func TestTaskSyncOversizedEncodingRefusesWholeResponse(t *testing.T) {
	var logs bytes.Buffer
	handler := newHTTPFixture(t, &logs)
	raw := json.RawMessage(`[{"url":"` + strings.Repeat("<", 4<<20) + `","title":""}]`)
	result := syncModel()
	for i := 0; i < 3; i++ {
		result.Tasks = append(result.Tasks, model.TaskViewRecord{ID: fmt.Sprintf("00000000-0000-4000-8000-%012d", i+10), TitlePreview: "Historical", Status: model.TaskTodo, Version: 1, CreatedAt: testTime, UpdatedAt: testTime, Properties: model.TaskProperties{"pullRequests": raw}})
	}
	handler.Sync = func(context.Context, model.Principal, string, taskservice.TaskSyncRequest) (model.TaskSync, error) {
		return result, nil
	}
	response := projectRequest(handler, http.MethodGet, syncPath(testProjectID), "")
	assertProjectError(t, response, 409, "resource_limit_exceeded")
	if strings.Contains(response.Body.String(), `"tasks"`) || strings.Contains(logs.String(), "Historical") {
		t.Fatalf("partial sync or values escaped: body=%s logs=%s", response.Body, &logs)
	}
}

func TestTaskHTTPEncodesNormalizedPropertyWithinBudget(t *testing.T) {
	handler := newHTTPFixture(t, new(bytes.Buffer))
	task := testTask("Compact property")
	task.Properties = model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"` + strings.Repeat("a", 100000) + `","title":""}]`)}
	handler.Tasks.ObserveRESTFunc = func(context.Context, model.Principal, string, string, bool) (taskservice.TaskObservation, error) {
		return taskservice.TaskObservation{Task: task, Epoch: testEpoch}, nil
	}
	response := projectRequest(handler, http.MethodGet, taskCollection(testProjectID)+"/"+testTaskID, "")
	value := decodeResponse[api.Task](t, response, 200)
	if len(value.Properties["pullRequests"]) < 100000 || response.Body.Len() > 512<<10 || !bytes.Equal(value.Properties["pullRequests"], task.Properties["pullRequests"]) {
		t.Fatalf("normalized response size=%d", response.Body.Len())
	}
	oversized := newHTTPFixture(t, new(bytes.Buffer))
	oversized.Tasks.ObserveRESTFunc = func(context.Context, model.Principal, string, string, bool) (taskservice.TaskObservation, error) {
		value := task
		value.Properties = model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"` + strings.Repeat("x", 600000) + `","title":""}]`)}
		return taskservice.TaskObservation{Task: value, Epoch: testEpoch}, nil
	}
	assertProjectError(t, projectRequest(oversized, http.MethodGet, taskCollection(testProjectID)+"/"+testTaskID, ""), 409, "resource_limit_exceeded")
}

func TestLegacyTaskProjectionOmitsIncompatibleWorker(t *testing.T) {
	handler := newHTTPFixture(t, new(bytes.Buffer))
	task := testTask("Incompatible worker")
	worker := map[string]any{"claimId": "11111111-1111-4111-8111-111111111111", "state": "active", "userId": "22222222-2222-4222-8222-222222222222", "workerId": "33333333-3333-4333-8333-333333333333", "machine": map[string]any{"id": "44444444-4444-8444-8444-444444444444", "name": "Worker"}, "platform": "linux", "agent": "claude", "agentControlMode": "web", "worktreeId": "55555555-5555-4555-8555-555555555555", "phase": "executing", "herdr": nil, "nativeSessionId": nil, "claimedAt": "2026-01-01T00:00:00Z"}
	raw, err := json.Marshal(worker)
	if err != nil {
		t.Fatal(err)
	}
	task.Properties = model.TaskProperties{"worker": raw}
	handler.Tasks.ObserveRESTFunc = func(context.Context, model.Principal, string, string, bool) (taskservice.TaskObservation, error) {
		return taskservice.TaskObservation{Task: task, Epoch: testEpoch}, nil
	}
	handler.Tasks.ListFunc = func(context.Context, model.Principal, string, taskservice.TaskListRequest) (taskservice.TaskPage, error) {
		return taskservice.TaskPage{Items: []model.Task{task}}, nil
	}
	got := decodeResponse[api.Task](t, projectRequest(handler, http.MethodGet, taskCollection(testProjectID)+"/"+testTaskID, ""), 200)
	if _, present := got.Properties["worker"]; present {
		t.Fatal("legacy result exposed incompatible worker")
	}
	page := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, taskCollection(testProjectID)+"?limit=100", ""), 200)
	if len(page.Items) != 1 || page.Items[0].ID != testTaskID {
		t.Fatalf("legacy page=%+v", page)
	}
}

func TestTaskPagePropertyOverflowKeepsPreviousCursor(t *testing.T) {
	handler := newHTTPFixture(t, new(bytes.Buffer))
	first := testTask("First")
	cursor := "preceding-task-cursor"
	calls := 0
	handler.Tasks.ExpectCalls("List", 2)
	handler.Tasks.ListFunc = func(ctx context.Context, p model.Principal, pid string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
		calls++
		if input.Limit != 100 {
			t.Fatalf("list=%+v", input)
		}
		if calls == 1 {
			if input.Cursor != nil {
				t.Fatal("unexpected first cursor")
			}
			return taskservice.TaskPage{Items: []model.Task{first}, NextCursor: &cursor}, nil
		}
		if input.Cursor == nil || *input.Cursor != cursor {
			t.Fatalf("cursor not preserved: %+v", input)
		}
		return taskservice.TaskPage{}, &model.Fault{Code: "resource_limit_exceeded", Message: "Task property exceeds its encoded limit."}
	}
	path := taskCollection(testProjectID) + "?limit=100"
	page := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, path, ""), 200)
	if len(page.Items) != 1 || page.Items[0].ID != testTaskID || page.NextCursor == nil || *page.NextCursor != cursor {
		t.Fatalf("first page=%+v", page)
	}
	assertProjectError(t, projectRequest(handler, http.MethodGet, path+"&cursor="+url.QueryEscape(*page.NextCursor), ""), 409, "resource_limit_exceeded")
}
