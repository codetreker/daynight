package task_test

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestTaskHTTPStatusCommittedResponseFailureAndReadback(t *testing.T) {
	var logs bytes.Buffer
	handler := projectTestHandler(t, projectTestStore(t), &logs)
	project := taskProject(t, handler)
	for _, status := range []string{"in_progress", "cancelled"} {
		t.Run(status, func(t *testing.T) {
			task := createHTTPTask(t, handler, project.ID, "Status response failure")
			body := jsonBody(t, api.TaskStatusUpdateRequest{Version: task.Version, Status: status})
			request := httptest.NewRequest(http.MethodPut, taskPath(task)+"/status", strings.NewReader(body))
			authorizeResourceRequest(handler, request)
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("X-Request-ID", "task-status-lost")
			writer := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder()}
			handler.ServeHTTP(writer, request)
			if writer.Code != http.StatusOK || writer.calls != 1 || !strings.Contains(logs.String(), `"phase":"set_status"`) || !strings.Contains(logs.String(), `"outcome":"changed"`) || strings.Contains(logs.String(), "private response failure") {
				t.Fatalf("status response failure lost its committed outcome or leaked cause: status=%d calls=%d logs=%s", writer.Code, writer.calls, &logs)
			}
			current := readHTTPTask(t, handler, task)
			if current.Status != status || current.Version != task.Version+1 || current.CompletedAt != nil ||
				(status == "in_progress" && (current.StartedAt == nil || current.CancelledAt != nil)) ||
				(status == "cancelled" && (current.StartedAt != nil || current.CancelledAt == nil)) {
				t.Fatalf("committed status was not readable: %+v", current)
			}
			stale := projectRequest(handler, http.MethodPut, taskPath(task)+"/status", body)
			assertProjectError(t, stale, http.StatusConflict, "version_conflict")
			if again := readHTTPTask(t, handler, task); !reflect.DeepEqual(again, current) {
				t.Fatalf("stale status changed committed result: %+v", again)
			}
		})
	}
}
