package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

func TestTaskHTTPWorkerInventoryFiltersAndCursor(t *testing.T) {
	f := newTaskHTTPFixture(t)
	workerID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	var wanted []model.Task
	paused := map[string]string{}
	for index, value := range []string{"true", "false", ""} {
		current := workerHTTPTask(t)
		current.ID = fmt.Sprintf("55555555-5555-4555-8555-%012d", index+1)
		current.Title, current.Status, current.Ready = "Inventory task", model.TaskInProgress, false
		worker := model.WorkerClaim{ClaimID: uuid.NewString(), UserID: f.principal.UserID, WorkerID: workerID,
			Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "Worker machine"}, Platform: model.PlatformLinux,
			Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: uuid.NewString(),
			State: model.WorkerActive, Phase: model.WorkerPreparing, ClaimedAt: current.UpdatedAt}
		current.Properties = workerHTTPProperties(t, current.Properties, &worker)
		if value != "" {
			current.Properties["paused"] = json.RawMessage(value)
			paused[current.ID] = value
		}
		wanted = append(wanted, current)
	}
	collection := taskCollection(f.project.ID)
	query := "?limit=1&workerId=" + strings.ToUpper(workerID)
	var cursor *string
	var ids []string
	for index, current := range wanted {
		requestPath := collection + query
		if cursor != nil {
			requestPath += "&cursor=" + url.QueryEscape(*cursor)
		}
		var next *string
		if index < len(wanted)-1 {
			value := fmt.Sprintf("worker-inventory-page-%d", index+1)
			next = &value
		}
		rawWorkerID := workerID
		if index == 0 {
			rawWorkerID = strings.ToUpper(workerID)
		}
		expected := taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1, Cursor: copyTaskHTTPPointer(cursor)}, WorkerID: &rawWorkerID}
		f.expectListRequest(expected, taskservice.TaskPage{Items: []model.Task{copyTaskHTTPTask(current)}, NextCursor: next}, nil)
		response := projectRequest(f.handler, http.MethodGet, requestPath, "")
		page := decodeResponse[api.TaskPage](t, response, http.StatusOK)
		if response.Header().Get("Cache-Control") != "no-store" || len(page.Items) != 1 || apiWorker(t, page.Items[0].Properties) == nil || apiWorker(t, page.Items[0].Properties).WorkerID != workerID || apiWorker(t, page.Items[0].Properties).State != "active" {
			t.Fatalf("wrong inventory page: %s", response.Body)
		}
		item := page.Items[0]
		assertWorkerHTTPTask(t, item, current)
		value, exists := item.Properties["paused"]
		wantValue, wantExists := paused[item.ID]
		if exists != wantExists || string(value) != wantValue {
			t.Fatalf("inventory changed paused presence/value: %#v", item.Properties)
		}
		ids = append(ids, item.ID)
		if index == len(wanted)-1 {
			if page.NextCursor != nil {
				t.Fatal("final inventory page unexpectedly continues")
			}
			break
		}
		if page.NextCursor == nil {
			t.Fatal("inventory omitted cursor for later task")
		}
		cursor = page.NextCursor
		for _, changed := range []string{"", "&workerId=" + uuid.NewString()} {
			expected := taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1, Cursor: copyTaskHTTPPointer(cursor)}}
			if changed != "" {
				value := strings.TrimPrefix(changed, "&workerId=")
				expected.WorkerID = &value
			}
			f.expectListRequest(expected, taskservice.TaskPage{}, &model.Fault{Code: "invalid_input", Message: "Cursor does not match the query."})
			assertProjectError(t, projectRequest(f.handler, http.MethodGet, collection+"?limit=1&cursor="+url.QueryEscape(*cursor)+changed, ""), http.StatusBadRequest, "invalid_input")
		}
		query = "?limit=1&workerId=" + workerID
	}
	wantedIDs := make([]string, len(wanted))
	for index := range wanted {
		wantedIDs[index] = wanted[index].ID
	}
	if !slices.Equal(ids, wantedIDs) {
		t.Fatalf("inventory filtering hid later tasks: got %v want %v", ids, wantedIDs)
	}
	for _, query := range []string{"workerId=", "workerId=invalid", "workerId=null", "workerId=true", "workerId=" + workerID + "&workerId=" + workerID, "WorkerId=" + workerID, "userId=" + f.principal.UserID} {
		if query == "workerId=invalid" || query == "workerId=null" || query == "workerId=true" {
			value := strings.TrimPrefix(query, "workerId=")
			f.expectListRequest(taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 50}, WorkerID: &value}, taskservice.TaskPage{}, &model.Fault{Code: "invalid_input", Message: "Worker ID must be a UUID."})
		}
		assertProjectError(t, projectRequest(f.handler, http.MethodGet, collection+"?"+query, ""), http.StatusBadRequest, "invalid_input")
	}
}
