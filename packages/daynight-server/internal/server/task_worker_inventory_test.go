package server

import (
	"encoding/json"
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
	paused := map[string]string{}
	for _, fixture := range []struct {
		selected bool
		paused   string
	}{{}, {}, {true, "true"}, {}, {true, "false"}, {selected: true}} {
		input := map[string]any{"allowAgents": true}
		if fixture.paused != "" {
			input["properties"] = api.TaskWritableProperties{"paused": json.RawMessage(fixture.paused)}
		}
		task := updateHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Inventory task"), input)
		body := workerClaimBody(task.Version)
		if fixture.selected {
			body["workerId"] = workerID
		}
		claimHTTPWorker(t, handler, task, body)
		if fixture.selected {
			if fixture.paused != "" {
				paused[task.ID] = fixture.paused
			}
			want = append(want, task.ID)
		}
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
		if response.Header().Get("Cache-Control") != "no-store" || len(page.Items) != 1 || apiWorker(t, page.Items[0].Properties) == nil || apiWorker(t, page.Items[0].Properties).WorkerID != workerID || apiWorker(t, page.Items[0].Properties).State != "active" {
			t.Fatalf("wrong inventory page: %s", response.Body)
		}
		item := page.Items[0]
		value, exists := item.Properties["paused"]
		wantValue, wantExists := paused[item.ID]
		if exists != wantExists || string(value) != wantValue {
			t.Fatalf("inventory changed paused property presence or value: %#v", item.Properties)
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
