package task_test

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskHTTPStatusCommittedResponseFailureAndReadback(t *testing.T) {
	for _, status := range []model.TaskStatus{model.TaskInProgress, model.TaskCancelled} {
		for _, short := range []bool{false, true} {
			t.Run(string(status)+"/"+map[bool]string{false: "failed", true: "short"}[short], func(t *testing.T) {
				var logs bytes.Buffer
				h := newHTTPFixture(t, &logs)
				result := testTask("Status response failure")
				result.Status, result.Version = status, 2
				stamp := result.UpdatedAt
				if status == model.TaskInProgress {
					result.StartedAt = &stamp
				} else {
					result.CancelledAt = &stamp
				}
				h.Tasks.SetStatusFunc = func(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.SetTaskStatus) (model.Task, error) {
					if ctx.Err() != nil || principal != h.principal || projectID != testProjectID || id != testTaskID || input.Version != 1 || input.Status != status {
						t.Fatalf("status mutation input: %+v", input)
					}
					return result, nil
				}
				h.Tasks.ObserveFunc = func(ctx context.Context, principal model.Principal, projectID, id string) (taskservice.TaskObservation, error) {
					if ctx.Err() != nil || principal != h.principal || projectID != testProjectID || id != testTaskID {
						t.Fatalf("reconcile input: %+v %s %s", principal, projectID, id)
					}
					return taskservice.TaskObservation{Task: result, Epoch: testEpoch}, nil
				}
				path := taskCollection(testProjectID) + "/" + testTaskID
				request := httptest.NewRequest(http.MethodPut, path+"/status", strings.NewReader(jsonBody(t, api.TaskStatusUpdateRequest{Version: 1, Status: string(status)})))
				authorizeResourceRequest(h, request)
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("X-Request-ID", "task-status-lost")
				writer := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder(), short: short}
				h.ServeHTTP(writer, request)
				if writer.Code != http.StatusOK || writer.calls != 1 || h.Tasks.Calls("SetStatus") != 1 || !strings.Contains(logs.String(), `"phase":"set_status"`) || !strings.Contains(logs.String(), `"outcome":"changed"`) || !strings.Contains(logs.String(), `"tx_outcome":"committed"`) || !strings.Contains(logs.String(), `"write_outcome":"unknown"`) || strings.Contains(logs.String(), "private response failure") {
					t.Fatalf("failed write lost outcome or replayed service: status=%d writes=%d calls=%d logs=%s", writer.Code, writer.calls, h.Tasks.Calls("SetStatus"), &logs)
				}
				current := decodeResponse[api.Task](t, projectRequest(h, http.MethodGet, path, ""), http.StatusOK)
				if current.Status != string(status) || current.Version != result.Version || current.ID != result.ID || current.ProjectID != result.ProjectID || current.CompletedAt != nil || (status == model.TaskInProgress && (current.StartedAt == nil || current.CancelledAt != nil)) || (status == model.TaskCancelled && (current.StartedAt != nil || current.CancelledAt == nil)) {
					t.Fatalf("read projection changed configured outcome: %+v", current)
				}
				if h.Tasks.Calls("SetStatus") != 1 {
					t.Fatal("readback replayed status mutation")
				}
			})
		}
	}
}
