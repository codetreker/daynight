package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/url"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"net/http"
	"strings"
	"testing"
)

func TestTaskGetHistoricalOversizeRefusesBeforeSuccess(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Historical")
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET description=$1 WHERE id=$2`, strings.Repeat("<", 100000), task.ID); err != nil {
		t.Fatal(err)
	}
	response := projectRequest(handler, http.MethodGet, taskPath(task), "")
	assertProjectError(t, response, http.StatusConflict, "resource_limit_exceeded")
	if response.Header().Get("Daynight-Task-Epoch") != "" {
		t.Fatalf("success header on refusal: %v", response.Header())
	}
}

func TestTaskPageBudgetContinuesWithLookahead(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	expected := make(map[string]bool)
	for i := 0; i < 10; i++ {
		task := createHTTPTask(t, handler, project.ID, fmt.Sprintf("Candidate %d", i))
		expected[task.ID] = true
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET description=$1 WHERE project_id=$2`, strings.Repeat("<", 80000), project.ID); err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/projects/" + project.ID + "/tasks?limit=100"
	pages := 0
	for {
		response := projectRequest(handler, http.MethodGet, path, "")
		if response.Body.Len() > 4<<20 {
			t.Fatalf("page too large: %d", response.Body.Len())
		}
		page := decodeResponse[api.TaskPage](t, response, http.StatusOK)
		pages++
		for _, task := range page.Items {
			if !expected[task.ID] {
				t.Fatalf("duplicate or foreign task: %s", task.ID)
			}
			delete(expected, task.ID)
		}
		if page.NextCursor == nil {
			break
		}
		path = "/api/v1/projects/" + project.ID + "/tasks?limit=100&cursor=" + url.QueryEscape(*page.NextCursor)
		if pages > 10 {
			t.Fatal("pagination did not terminate")
		}
	}
	if len(expected) != 0 || pages < 2 {
		t.Fatalf("missing %d tasks after %d pages", len(expected), pages)
	}
}

func TestTaskPageOversizedFirstItemRefusesWithoutPartialPage(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Historical first")
	createHTTPTask(t, handler, project.ID, "Later")
	if _, err := database.Pool.Exec(context.Background(), `UPDATE tasks SET description=$1 WHERE id=$2`, strings.Repeat("x", 4<<20), task.ID); err != nil {
		t.Fatal(err)
	}
	response := projectRequest(handler, http.MethodGet, "/api/v1/projects/"+project.ID+"/tasks?limit=100", "")
	assertProjectError(t, response, http.StatusConflict, "resource_limit_exceeded")
	if strings.Contains(response.Body.String(), `"items"`) {
		t.Fatalf("partial page: %s", response.Body)
	}
}

func TestTaskSyncOversizedEncodingRefusesWholeResponse(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	raw := `[{"url":"` + strings.Repeat("<", 4<<20) + `","title":""}]`
	for i := 0; i < 3; i++ {
		task := createHTTPTask(t, handler, project.ID, fmt.Sprintf("Historical %d", i))
		if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests',$2)`, task.ID, raw); err != nil {
			t.Fatal(err)
		}
	}
	response := projectRequest(handler, http.MethodGet, syncPath(project.ID), "")
	assertProjectError(t, response, http.StatusConflict, "resource_limit_exceeded")
	if strings.Contains(response.Body.String(), `"tasks"`) {
		t.Fatalf("partial sync: %s", response.Body)
	}
}

func TestTaskBoundedPropertyReadsCompactHistoricalJSON(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Compact property")
	// Raw storage is larger than the response limit, while whitespace and
	// Unicode escapes normalize to a small, legal JSON value.
	raw := strings.Repeat(" \n", 300000) + `[{"url":"` + strings.Repeat(`\u0061`, 100000) + `","title":""}]`
	if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests',$2)`, task.ID, raw); err != nil {
		t.Fatal(err)
	}
	response := projectRequest(handler, http.MethodGet, taskPath(task), "")
	value := decodeResponse[api.Task](t, response, http.StatusOK)
	if len(value.Properties["pullRequests"]) < 100000 || response.Body.Len() > 512<<10 {
		t.Fatalf("bad normalized response size: %d", response.Body.Len())
	}
	if _, err := database.Pool.Exec(context.Background(), `UPDATE task_properties SET value=$2 WHERE task_id=$1 AND name='pullRequests'`, task.ID, `[{"url":"`+strings.Repeat("x", 600000)+`","title":""}]`); err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, projectRequest(handler, http.MethodGet, taskPath(task), ""), http.StatusConflict, "resource_limit_exceeded")
}

func TestLegacyTaskProjectionOmitsOversizedIncompatibleWorker(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Incompatible worker")
	worker := map[string]any{
		"claimId": "11111111-1111-4111-8111-111111111111", "state": "active",
		"userId": "22222222-2222-4222-8222-222222222222", "workerId": "33333333-3333-4333-8333-333333333333",
		"machine":  map[string]any{"id": "44444444-4444-4444-8444-444444444444", "name": strings.Repeat("w", 600000)},
		"platform": "linux", "agent": "claude", "agentControlMode": "web", "worktreeId": "55555555-5555-4555-8555-555555555555",
		"phase": "executing", "herdr": nil, "nativeSessionId": nil, "claimedAt": "2026-01-01T00:00:00Z",
	}
	raw, err := json.Marshal(worker)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, task.ID, string(raw)); err != nil {
		t.Fatal(err)
	}
	response := projectRequest(handler, http.MethodGet, taskPath(task), "")
	got := decodeResponse[api.Task](t, response, http.StatusOK)
	if _, present := got.Properties["worker"]; present {
		t.Fatal("legacy result exposed incompatible worker")
	}
	page := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects/"+project.ID+"/tasks?limit=100", ""), http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].ID != task.ID {
		t.Fatalf("legacy task missing: %+v", page)
	}
}

func TestTaskPagePropertyOverflowKeepsPreviousCursor(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	first := createHTTPTask(t, handler, project.ID, "First")
	second := createHTTPTask(t, handler, project.ID, "Oversized property")
	raw := `[{"url":"` + strings.Repeat("x", 4<<20) + `","title":""}]`
	if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests',$2)`, second.ID, raw); err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/projects/" + project.ID + "/tasks?limit=100"
	page := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, path, ""), http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].ID != first.ID || page.NextCursor == nil {
		t.Fatalf("missing continuation: %+v", page.NextCursor)
	}
	assertProjectError(t, projectRequest(handler, http.MethodGet, path+"&cursor="+url.QueryEscape(*page.NextCursor), ""), http.StatusConflict, "resource_limit_exceeded")
}
