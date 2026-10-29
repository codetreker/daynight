package server

import (
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestTaskSignalingHTTPRequiresStrictNestedUpdate(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Needs attention")
	patch := map[string]any{"worker": map[string]any{"signaling": "xxx"}}
	assertProjectError(t, projectRequest(handler, http.MethodPost, "/api/v1/projects/"+project.ID+"/tasks", jsonBody(t, map[string]any{"title": "Invalid", "properties": patch})), http.StatusBadRequest, "invalid_input")
	assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), jsonBody(t, map[string]any{"version": task.Version, "properties": patch})), http.StatusBadRequest, "invalid_input")
	task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": true})
	task = claimHTTPWorker(t, handler, task, workerClaimBody(task.Version))
	for _, properties := range []string{
		`{"worker":null}`, `{"worker":true}`, `{"worker":{}}`, `{"worker":{"signaling":null}}`, `{"worker":{"signaling":1}}`,
		`{"worker":{"signaling":"x","phase":"executing"}}`, `{"worker":{"signaling":"x","signaling":"y"}}`, `{"worker":{"signaling":"x","claimId":"changed"}}`,
	} {
		body := `{"version":` + strconv.FormatInt(task.Version, 10) + `,"properties":` + properties + `}`
		assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), body), http.StatusBadRequest, "invalid_input")
	}
	baseline := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(project.ID), ""), http.StatusOK)
	assertSignal := func(current api.Task, want string) {
		t.Helper()
		if current.Properties.Worker == nil || current.Properties.Worker.Signaling != want {
			t.Fatalf("full task lost signaling: %#v", current.Properties.Worker)
		}
		graphResponse := projectRequest(handler, http.MethodGet, "/api/v1/projects/"+project.ID+"/task-graph?taskId="+task.ID, "")
		graph := decodeResponse[api.TaskGraph](t, graphResponse, http.StatusOK)
		if len(graph.Tasks) != 1 || graph.Tasks[0].WorkerNeedsAttention != (want != "") {
			t.Fatalf("graph missed attention: %#v", graph.Tasks)
		}
		query := "?epoch=" + baseline.Epoch + "&since=" + url.QueryEscape(baseline.ObservedAt.Format(time.RFC3339Nano))
		syncResponse := projectRequest(handler, http.MethodGet, syncPath(project.ID)+query, "")
		sync := decodeResponse[api.TaskSync](t, syncResponse, http.StatusOK)
		if sync.Mode != "delta" || len(sync.Tasks) != 1 || sync.Tasks[0].WorkerNeedsAttention != (want != "") {
			t.Fatalf("task delta missed attention: %#v", sync.Tasks)
		}
		for _, response := range []string{graphResponse.Body.String(), syncResponse.Body.String()} {
			if strings.Contains(response, `"properties"`) || strings.Contains(response, `"signaling"`) || strings.Contains(response, `"claimId"`) {
				t.Fatalf("compact projection exposed worker details: %s", response)
			}
		}
	}
	assertSignal(task, "")
	original := task
	value := " 需要处理\n\x00 "
	task = updateHTTPTask(t, handler, task, map[string]any{"properties": map[string]any{"worker": map[string]any{"signaling": value}}})
	assertSignal(task, value)
	if task.Version != original.Version+1 || !reflect.DeepEqual(task.StartedAt, original.StartedAt) || task.Properties.Worker.ClaimID != original.Properties.Worker.ClaimID {
		t.Fatal("signaling changed worker identity or task timing")
	}
	noop := updateHTTPTask(t, handler, task, map[string]any{"properties": map[string]any{"worker": map[string]any{"signaling": value}}})
	if !reflect.DeepEqual(noop, task) {
		t.Fatal("same signaling changed task version or timestamps")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), jsonBody(t, map[string]any{"version": original.Version, "properties": patch})), http.StatusConflict, "version_conflict")
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPatch, taskPath(task)+"/worker-claim", jsonBody(t, map[string]any{"version": task.Version, "claimId": task.Properties.Worker.ClaimID, "phase": "executing"})), http.StatusOK)
	assertSignal(task, value)
	task = updateHTTPTask(t, handler, task, map[string]any{"properties": map[string]any{"worker": map[string]any{"signaling": ""}}})
	assertSignal(task, "")
}
