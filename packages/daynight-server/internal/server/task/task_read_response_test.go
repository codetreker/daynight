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

func TestTaskPagePreservesCountPaginationAndCompleteResources(t *testing.T) {
	handler := newHTTPFixture(t, new(bytes.Buffer))
	tasks := make([]model.Task, 21)
	for i := range tasks {
		tasks[i] = testTask(fmt.Sprintf("Candidate %d", i))
		tasks[i].ID = fmt.Sprintf("00000000-0000-4000-8000-%012d", i+10)
		tasks[i].Description = strings.Repeat("<", 50<<10)
	}
	cursor := "private-page-cursor"
	calls := 0
	handler.Tasks.ExpectCalls("List", 2)
	handler.Tasks.ListFunc = func(ctx context.Context, p model.Principal, pid string, input taskservice.TaskListRequest) (taskservice.TaskPage, error) {
		calls++
		if pid != testProjectID || p != handler.principal || input.Limit != 20 {
			t.Fatalf("list input=%+v", input)
		}
		if calls == 1 {
			if input.Cursor != nil {
				t.Fatal("unexpected first cursor")
			}
			return taskservice.TaskPage{Items: tasks[:20], NextCursor: &cursor}, nil
		}
		if input.Cursor == nil || *input.Cursor != cursor {
			t.Fatalf("continuation=%+v", input)
		}
		return taskservice.TaskPage{Items: tasks[20:]}, nil
	}
	firstResponse := projectRequest(handler, http.MethodGet, taskCollection(testProjectID)+"?limit=20", "")
	first := decodeResponse[api.TaskPage](t, firstResponse, http.StatusOK)
	if firstResponse.Body.Len() <= 4<<20 || first.NextCursor == nil || *first.NextCursor != cursor || len(first.Items) != 20 {
		t.Fatalf("first size=%d count=%d cursor=%v", firstResponse.Body.Len(), len(first.Items), first.NextCursor)
	}
	nextResponse := projectRequest(handler, http.MethodGet, taskCollection(testProjectID)+"?limit=20&cursor="+url.QueryEscape(*first.NextCursor), "")
	next := decodeResponse[api.TaskPage](t, nextResponse, http.StatusOK)
	if next.NextCursor != nil || len(next.Items) != 1 {
		t.Fatalf("next=%+v", next)
	}
	for i, item := range append(first.Items, next.Items...) {
		if item.ID != tasks[i].ID || item.Description != tasks[i].Description {
			t.Fatalf("item %d changed", i)
		}
	}
	if !strings.HasSuffix(firstResponse.Body.String(), "\n") || !strings.HasSuffix(nextResponse.Body.String(), "\n") {
		t.Fatal("missing encoder newline")
	}
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
	handler.Tasks.ObserveFunc = func(context.Context, model.Principal, string, string) (taskservice.TaskObservation, error) {
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
