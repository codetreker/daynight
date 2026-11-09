package task_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskGETReturnsAuthorizedSnapshotEpoch(t *testing.T) {
	handler := newHTTPFixture(t, io.Discard)
	task := testTask("Observed")
	handler.Tasks.ObserveRESTFunc = func(ctx context.Context, principal model.Principal, pid, id string, extended bool) (taskservice.TaskObservation, error) {
		if principal != handler.principal || pid != testProjectID || id != testTaskID || extended || ctx.Err() != nil {
			t.Fatalf("observation input=%+v %s %s extended=%t", principal, pid, id, extended)
		}
		return taskservice.TaskObservation{Task: task, Epoch: testEpoch}, nil
	}
	response := projectRequest(handler, http.MethodGet, taskCollection(testProjectID)+"/"+testTaskID, "")
	got := decodeResponse[api.Task](t, response, 200)
	if got.ID != task.ID || got.ProjectID != task.ProjectID || got.Description != task.Description || response.Header().Get("Daynight-Task-Epoch") != testEpoch || response.Header().Get("Daynight-User-ID") != handler.principal.UserID || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("observation=%+v headers=%+v", got, response.Header())
	}
	unauthorized := projectRequest(handler.Handler, http.MethodGet, taskCollection(testProjectID)+"/"+testTaskID, "")
	if unauthorized.Code != 401 || unauthorized.Header().Get("Daynight-Task-Epoch") != "" || handler.Tasks.Calls("ObserveREST") != 1 {
		t.Fatalf("unauthorized=%d headers=%+v", unauthorized.Code, unauthorized.Header())
	}
	for _, tc := range []struct {
		name, code string
		status     int
		cause      error
	}{
		{"missing", "not_found", 404, &model.Fault{Code: "not_found", Message: "Task not found."}},
		{"deleted", "task_deleted", 410, &model.Fault{Code: "task_deleted", Message: "Task is deleted."}},
		{"epoch failure", "internal_error", 500, &store.Error{Phase: "query", DatabaseFailure: true, Cause: errors.New("task_cache_epoch is unavailable")}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := newHTTPFixture(t, io.Discard)
			fixture.Tasks.ObserveRESTFunc = func(context.Context, model.Principal, string, string, bool) (taskservice.TaskObservation, error) {
				return taskservice.TaskObservation{}, tc.cause
			}
			response := projectRequest(fixture, http.MethodGet, taskCollection(testProjectID)+"/"+testTaskID, "")
			assertProjectError(t, response, tc.status, tc.code)
			if response.Header().Get("Daynight-Task-Epoch") != "" {
				t.Fatalf("error exposed epoch: %+v", response.Header())
			}
		})
	}
}
