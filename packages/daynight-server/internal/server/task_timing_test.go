package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestTaskHTTPTimingIsServerOwnedFrozenAndSharedAcrossResources(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	created := projectRequest(handler, http.MethodPost, taskCollection(project.ID), `{"title":"Timed execution"}`)
	task := decodeResponse[api.Task](t, created, http.StatusCreated)
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(created.Body.Bytes(), &fields); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"startedAt", "completedAt"} {
		if !bytes.Equal(fields[name], []byte("null")) {
			t.Fatalf("new task omitted unknown %s or invented timing: %s", name, created.Body)
		}
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), `{"title":"Rejected","`+name+`":"2026-01-01T00:00:00Z"}`), http.StatusBadRequest, "invalid_input")
		assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), `{"version":1,"title":"Rejected","`+name+`":null}`), http.StatusBadRequest, "invalid_input")
		assertProjectError(t, projectRequest(handler, http.MethodPut, taskPath(task)+"/status", `{"version":1,"status":"todo","`+name+`":null}`), http.StatusBadRequest, "invalid_input")
	}
	if task.StartedAt != nil || task.CompletedAt != nil {
		t.Fatalf("creation started an execution: %+v", task)
	}
	task = setHTTPTask(t, handler, task, "in_progress")
	if task.StartedAt == nil || task.CompletedAt != nil || !task.StartedAt.Equal(task.UpdatedAt) || task.StartedAt.Location() != time.UTC {
		t.Fatalf("start did not expose the database start: %+v", task)
	}
	start := *task.StartedAt
	previous := task
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPatch, taskPath(task), jsonBody(t, map[string]any{"version": task.Version, "title": "Edited during execution"})), http.StatusOK)
	if !task.StartedAt.Equal(start) || task.CompletedAt != nil {
		t.Fatalf("metadata edit reset the running interval: %+v", task)
	}
	same := setHTTPTask(t, handler, task, "in_progress")
	if !reflect.DeepEqual(same, task) {
		t.Fatal("same state changed execution timing")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPut, taskPath(task)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: previous.Version, Status: "done"})), http.StatusConflict, "version_conflict")
	if !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
		t.Fatal("rejected lifecycle write changed execution timing")
	}
	task = setHTTPTask(t, handler, task, "done")
	if task.CompletedAt == nil || !task.StartedAt.Equal(start) || task.CompletedAt.Before(start) || !task.CompletedAt.Equal(task.UpdatedAt) {
		t.Fatalf("completion did not freeze its real interval: %+v", task)
	}
	end := *task.CompletedAt
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPatch, taskPath(task), jsonBody(t, map[string]any{"version": task.Version, "description": "Edited after execution"})), http.StatusOK)
	if !task.StartedAt.Equal(start) || !task.CompletedAt.Equal(end) {
		t.Fatalf("finished interval changed during an edit: %+v", task)
	}
	listed := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, taskCollection(project.ID), ""), http.StatusOK)
	graph := decodeResponse[api.TaskGraph](t, projectRequest(handler, http.MethodGet, graphPath(project.ID, task.ID), ""), http.StatusOK)
	if len(listed.Items) != 1 || !reflect.DeepEqual(listed.Items[0], task) || len(graph.Tasks) != 1 ||
		!reflect.DeepEqual(graph.Tasks[0].StartedAt, task.StartedAt) || !reflect.DeepEqual(graph.Tasks[0].CompletedAt, task.CompletedAt) || graph.ObservedAt.Before(end) {
		t.Fatalf("resource timing differs across reads: task %+v, list %+v, graph %+v", task, listed, graph)
	}
}
