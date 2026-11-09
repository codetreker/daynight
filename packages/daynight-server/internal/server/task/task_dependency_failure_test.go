package task_test

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskAndSyncHTTPRecoverAfterDependencyFailure(t *testing.T) {
	var logs bytes.Buffer
	handler := newHTTPFixture(t, &logs)
	handler.Tasks.ExpectCalls("ObserveREST", 2)
	handler.ExpectCalls("Sync", 2)
	failure := &store.Error{Phase: "query", DatabaseFailure: true, Cause: errors.New("task_dependencies private_missing_dependencies")}
	task := testTask("Dependent")
	sync := syncModel()
	sync.Tasks = []model.TaskViewRecord{{ID: task.ID, TitlePreview: task.Title, Version: task.Version, Properties: task.Properties, Status: task.Status, CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt}}
	taskCalls, syncCalls := 0, 0
	handler.Tasks.ObserveRESTFunc = func(context.Context, model.Principal, string, string, bool) (taskservice.TaskObservation, error) {
		taskCalls++
		if taskCalls == 1 {
			return taskservice.TaskObservation{}, failure
		}
		return taskservice.TaskObservation{Task: task, Epoch: testEpoch}, nil
	}
	handler.Sync = func(context.Context, model.Principal, string, taskservice.TaskSyncRequest) (model.TaskSync, error) {
		syncCalls++
		if syncCalls == 1 {
			return model.TaskSync{}, failure
		}
		return sync, nil
	}
	for _, path := range []string{taskCollection(testProjectID) + "/" + testTaskID, syncPath(testProjectID)} {
		response := projectRequest(handler, http.MethodGet, path, "")
		value := decodeResponse[api.ErrorResponse](t, response, 500)
		if value.Error.Code != "internal_error" || value.Error.RequestID == "" || value.Error.RequestID != response.Header().Get("X-Request-ID") || strings.Contains(response.Body.String(), "task_dependencies") || strings.Contains(response.Body.String(), "private_missing_dependencies") {
			t.Fatalf("failure=%s", response.Body)
		}
	}
	recovered := decodeResponse[api.Task](t, projectRequest(handler, http.MethodGet, taskCollection(testProjectID)+"/"+testTaskID, ""), 200)
	if recovered.ID != task.ID || recovered.Title != task.Title || recovered.Version != task.Version {
		t.Fatalf("recovered=%+v", recovered)
	}
	result := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(testProjectID), ""), 200)
	if result.Epoch != testEpoch || result.Mode != "snapshot" || len(result.Tasks) != 1 || result.Tasks[0].ID != task.ID {
		t.Fatalf("sync recovered=%+v", result)
	}
	if strings.Contains(logs.String(), "task_dependencies") || strings.Contains(logs.String(), "private_missing_dependencies") {
		t.Fatalf("database names leaked: %s", &logs)
	}
}
