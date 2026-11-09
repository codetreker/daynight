package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskHTTPTimingProjectsSuppliedIntervalsAcrossResources(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	created := testTask("Timed execution")
	h.Tasks.CreateFunc = func(context.Context, model.Principal, string, taskcore.CreateTask) (model.Task, error) {
		return created, nil
	}
	collection := taskCollection(testProjectID)
	path := collection + "/" + testTaskID
	response := projectRequest(h, http.MethodPost, collection, `{"title":"Timed execution"}`)
	task := decodeResponse[api.Task](t, response, http.StatusCreated)
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"startedAt", "completedAt", "cancelledAt"} {
		if !bytes.Equal(fields[name], []byte("null")) {
			t.Fatalf("unknown %s was omitted or invented: %s", name, response.Body)
		}
		assertProjectError(t, projectRequest(h, http.MethodPost, collection, `{"title":"Rejected","`+name+`":"2026-01-01T00:00:00Z"}`), http.StatusBadRequest, "invalid_input")
		assertProjectError(t, projectRequest(h, http.MethodPatch, path, `{"version":1,"title":"Rejected","`+name+`":null}`), http.StatusBadRequest, "invalid_input")
		assertProjectError(t, projectRequest(h, http.MethodPut, path+"/status", `{"version":1,"status":"todo","`+name+`":null}`), http.StatusBadRequest, "invalid_input")
	}
	if task.StartedAt != nil || task.CompletedAt != nil || task.CancelledAt != nil || h.Tasks.Calls("Create") != 1 || h.Tasks.TotalCalls() != 1 {
		t.Fatalf("readonly timing reached service or creation invented interval: %+v calls=%d", task, h.Tasks.TotalCalls())
	}
	start := created.CreatedAt.In(time.FixedZone("recorded", 9*60*60))
	end := start.Add(time.Hour)
	result := created
	result.Status, result.Version, result.StartedAt, result.CompletedAt, result.UpdatedAt = model.TaskDone, 3, &start, &end, end
	h.Tasks.ObserveFunc = func(context.Context, model.Principal, string, string) (taskservice.TaskObservation, error) {
		return taskservice.TaskObservation{Task: result, Epoch: testEpoch}, nil
	}
	h.Tasks.ListFunc = func(context.Context, model.Principal, string, taskservice.TaskListRequest) (taskservice.TaskPage, error) {
		return taskservice.TaskPage{Items: []model.Task{result}}, nil
	}
	h.Tasks.GraphFunc = func(ctx context.Context, principal model.Principal, projectID, id string) (model.TaskGraph, error) {
		if ctx.Err() != nil || principal != h.principal || projectID != testProjectID || id != testTaskID {
			t.Fatalf("graph scope changed: %+v %s %s", principal, projectID, id)
		}
		return model.TaskGraph{Project: testProject(), ObservedAt: end, Tasks: []model.GraphTask{{ID: testTaskID, TitlePreview: result.Title, Status: result.Status, CreatedAt: result.CreatedAt, UpdatedAt: result.UpdatedAt, StartedAt: &start, CompletedAt: &end}}, Summary: model.TaskGraphSummary{Total: 1, Done: 1}}, nil
	}
	read := decodeResponse[api.Task](t, projectRequest(h, http.MethodGet, path, ""), http.StatusOK)
	list := decodeResponse[api.TaskPage](t, projectRequest(h, http.MethodGet, collection, ""), http.StatusOK)
	graph := decodeResponse[api.TaskGraph](t, projectRequest(h, http.MethodGet, "/api/v1/projects/"+testProjectID+"/task-graph?taskId="+testTaskID, ""), http.StatusOK)
	if len(list.Items) != 1 || len(graph.Tasks) != 1 {
		t.Fatalf("timing projection missing resource: list=%+v graph=%+v", list, graph)
	}
	for _, interval := range []struct{ start, end *time.Time }{{read.StartedAt, read.CompletedAt}, {list.Items[0].StartedAt, list.Items[0].CompletedAt}, {graph.Tasks[0].StartedAt, graph.Tasks[0].CompletedAt}} {
		if interval.start == nil || interval.end == nil || !interval.start.Equal(start) || !interval.end.Equal(end) || interval.start.Location() != time.UTC || interval.end.Location() != time.UTC {
			t.Fatalf("supplied interval changed during encoding: start=%v end=%v", interval.start, interval.end)
		}
	}
	if !graph.ObservedAt.Equal(end) || graph.ObservedAt.Location() != time.UTC || read.Version != 3 || read.CancelledAt != nil {
		t.Fatalf("resource timing projection: task=%+v graph=%+v", read, graph)
	}
}
