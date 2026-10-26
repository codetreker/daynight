package server

import (
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
)

func TestTaskHTTPWorkerInventoryFiltersAndCursor(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	workerID := uuid.NewString()
	var want []string
	for _, selected := range []bool{false, false, true, false, true} {
		task := updateHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Inventory task"), map[string]any{"allowAgents": true})
		body := workerClaimBody(task.Version)
		if selected {
			body["workerId"] = workerID
			want = append(want, task.ID)
		}
		claimHTTPWorker(t, handler, task, body)
	}
	collection := taskCollection(project.ID)
	query := "?limit=1&workerId=" + strings.ToUpper(workerID)
	var cursor *string
	var ids []string
	for {
		path := collection + query
		if cursor != nil {
			path += "&cursor=" + url.QueryEscape(*cursor)
		}
		response := projectRequest(handler, http.MethodGet, path, "")
		page := decodeResponse[api.TaskPage](t, response, http.StatusOK)
		if response.Header().Get("Cache-Control") != "no-store" || len(page.Items) != 1 || page.Items[0].Properties.Worker == nil || page.Items[0].Properties.Worker.WorkerID != workerID || page.Items[0].Properties.Worker.State != "active" {
			t.Fatalf("wrong inventory page: %s", response.Body)
		}
		ids = append(ids, page.Items[0].ID)
		if page.NextCursor == nil {
			break
		}
		cursor = page.NextCursor
		for _, changed := range []string{"", "&workerId=" + uuid.NewString()} {
			assertProjectError(t, projectRequest(handler, http.MethodGet, collection+"?limit=1&cursor="+url.QueryEscape(*cursor)+changed, ""), http.StatusBadRequest, "invalid_input")
		}
		query = "?limit=1&workerId=" + workerID
	}
	if !slices.Equal(ids, want) {
		t.Fatalf("inventory filtering hid later tasks: got %v want %v", ids, want)
	}
	for _, query := range []string{"workerId=", "workerId=invalid", "workerId=null", "workerId=true", "workerId=" + workerID + "&workerId=" + workerID, "WorkerId=" + workerID, "userId=" + handler.principal.UserID} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, collection+"?"+query, ""), http.StatusBadRequest, "invalid_input")
	}
}
