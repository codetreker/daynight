package task_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskReadParentProjectionNegotiation(t *testing.T) {
	for _, view := range []string{"", "task-parent-v1", "v2"} {
		t.Run(view, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			if view != "v2" {
				h.Tasks.ObserveFunc = func(context.Context, model.Principal, string, string) (taskservice.TaskObservation, error) {
					task := testTask("Child")
					task.ParentID, task.ParentType = &task.ID, model.TaskTypeTask
					return taskservice.TaskObservation{Task: task, Epoch: testEpoch}, nil
				}
			}
			r := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+testProjectID+"/tasks/"+testTaskID, nil)
			authorizeResourceRequest(h, r)
			if view != "" {
				r.Header.Set("Daynight-Task-Relations", view)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if view == "v2" {
				if w.Code != http.StatusBadRequest || h.Tasks.TotalCalls() != 0 {
					t.Fatalf("unknown view: %d %s", w.Code, w.Body)
				}
				return
			}
			if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"parentId":null`) || strings.Contains(w.Body.String(), `"parentTaskId"`) != (view != "") {
				t.Fatalf("view=%s response=%d %s", view, w.Code, w.Body)
			}
			if w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Header().Get("Vary"), "Daynight-Task-Relations") {
				t.Fatalf("representation cache headers: %v", w.Header())
			}
		})
	}
}
