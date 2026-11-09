package task_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskHTTPCancellationProjectsTerminalTimingAndReadableMaterials(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	result := testTask("Cancelled search target")
	stamp := result.UpdatedAt.Add(time.Minute)
	dependency := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	result.Status, result.Version, result.CancelledAt, result.UpdatedAt, result.Ready = model.TaskCancelled, 2, &stamp, stamp, false
	result.Description = "Readable cancelled Markdown"
	result.DependsOn = []string{dependency}
	result.Properties = model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"https://example.test/pr/1","title":"Retained result"}]`)}
	h.Tasks.SetStatusFunc = func(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.SetTaskStatus) (model.Task, error) {
		if ctx.Err() != nil || principal != h.principal || projectID != testProjectID || id != testTaskID || input.Version != 1 || input.Status != model.TaskCancelled {
			t.Fatalf("cancel input: %+v", input)
		}
		return result, nil
	}
	h.Tasks.ObserveRESTFunc = func(context.Context, model.Principal, string, string, bool) (taskservice.TaskObservation, error) {
		return taskservice.TaskObservation{Task: result, Epoch: testEpoch}, nil
	}
	h.Tasks.GraphFunc = func(context.Context, model.Principal, string, string) (model.TaskGraph, error) {
		return model.TaskGraph{Project: testProject(), ObservedAt: stamp, Summary: model.TaskGraphSummary{Total: 1, Cancelled: 1}, Tasks: []model.GraphTask{{ID: testTaskID, TitlePreview: result.Title, Status: result.Status, DependsOn: result.DependsOn, CreatedAt: result.CreatedAt, UpdatedAt: stamp, CancelledAt: &stamp}}}, nil
	}
	h.Sync = func(ctx context.Context, principal model.Principal, projectID string, input taskservice.TaskSyncRequest) (model.TaskSync, error) {
		if ctx.Err() != nil || principal != h.principal || projectID != testProjectID {
			t.Fatalf("cancelled sync scope: %+v %s", principal, projectID)
		}
		return model.TaskSync{Mode: "snapshot", Epoch: testEpoch, Project: testProject(), ObservedAt: stamp, Tasks: []model.TaskViewRecord{{ID: testTaskID, TitlePreview: result.Title, Status: result.Status, Version: result.Version, Properties: result.Properties, DependsOn: result.DependsOn, CreatedAt: result.CreatedAt, UpdatedAt: stamp, CancelledAt: &stamp}}, AssigneeVersions: []model.TaskAssigneeVersion{}, Sessions: map[string]model.SessionListState{}}, nil
	}
	h.Search = func(ctx context.Context, principal model.Principal, projectID string, input tasksearch.Request) (tasksearch.Page, error) {
		if ctx.Err() != nil || principal != h.principal || projectID != testProjectID || input.Query != result.Title || input.Status == nil || *input.Status != model.TaskCancelled {
			t.Fatalf("cancelled search input: %+v", input)
		}
		return tasksearch.Page{ProjectID: testProjectID, Total: 1, Items: []tasksearch.Item{{ID: testTaskID, ProjectID: testProjectID, Title: result.Title, Status: model.TaskCancelled, UpdatedAt: stamp, CancelledAt: &stamp, Match: tasksearch.Match{Fields: []string{"title"}}}}}, nil
	}
	collection := taskCollection(testProjectID)
	path := collection + "/" + testTaskID
	response := projectRequest(h, http.MethodPut, path+"/status", `{"version":1,"status":"cancelled"}`)
	cancelled := decodeResponse[api.Task](t, response, http.StatusOK)
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil || len(fields["cancelledAt"]) == 0 {
		t.Fatalf("cancelledAt missing from wire: %s %v", response.Body, err)
	}
	if cancelled.Status != "cancelled" || cancelled.Ready || cancelled.Version != 2 || cancelled.CancelledAt == nil || !cancelled.CancelledAt.Equal(stamp) || cancelled.CancelledAt.Location() != time.UTC || cancelled.Description != result.Description || !slices.Equal(cancelled.DependsOn, result.DependsOn) || !reflect.DeepEqual(cancelled.Properties, api.TaskProperties(result.Properties)) {
		t.Fatalf("cancelled task projection: %+v", cancelled)
	}
	read := decodeResponse[api.Task](t, projectRequest(h, http.MethodGet, path, ""), http.StatusOK)
	if !reflect.DeepEqual(read, cancelled) {
		t.Fatalf("cancelled read projection differs: %+v %+v", read, cancelled)
	}
	graph := decodeResponse[api.TaskGraph](t, projectRequest(h, http.MethodGet, "/api/v1/projects/"+testProjectID+"/task-graph?taskId="+testTaskID, ""), http.StatusOK)
	sync := decodeResponse[api.TaskSync](t, projectRequest(h, http.MethodGet, "/api/v1/projects/"+testProjectID+"/task-sync", ""), http.StatusOK)
	search := decodeResponse[api.TaskSearchPage](t, projectRequest(h, http.MethodPost, collection+"/search", jsonBody(t, map[string]any{"query": result.Title, "status": "cancelled"})), http.StatusOK)
	if len(graph.Tasks) != 1 || len(sync.Tasks) != 1 || len(search.Items) != 1 || graph.Tasks[0].CancelledAt == nil || sync.Tasks[0].CancelledAt == nil || search.Items[0].CancelledAt == nil || !graph.Tasks[0].CancelledAt.Equal(stamp) || !sync.Tasks[0].CancelledAt.Equal(stamp) || !search.Items[0].CancelledAt.Equal(stamp) || graph.Summary.Cancelled != 1 || sync.Tasks[0].Status != "cancelled" || search.Items[0].Status != "cancelled" {
		t.Fatalf("cancelled timestamp changed across projections: graph=%+v sync=%+v search=%+v", graph, sync, search)
	}
}

func TestTaskHTTPCancellationPreservesSuppliedIntervalAndMapsRefusals(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	result := testTask("Completed interval")
	start, end, cancelled := result.CreatedAt, result.CreatedAt.Add(time.Hour), result.CreatedAt.Add(2*time.Hour)
	result.Status, result.Version, result.StartedAt, result.CompletedAt, result.CancelledAt, result.UpdatedAt = model.TaskCancelled, 4, &start, &end, &cancelled, cancelled
	h.Tasks.SetStatusFunc = func(context.Context, model.Principal, string, string, taskcore.SetTaskStatus) (model.Task, error) {
		return result, nil
	}
	actual := decodeResponse[api.Task](t, projectRequest(h, http.MethodPut, taskCollection(testProjectID)+"/"+testTaskID+"/status", `{"version":3,"status":"cancelled"}`), http.StatusOK)
	if actual.StartedAt == nil || actual.CompletedAt == nil || actual.CancelledAt == nil || !actual.StartedAt.Equal(start) || !actual.CompletedAt.Equal(end) || !actual.CancelledAt.Equal(cancelled) {
		t.Fatalf("cancelled output replaced supplied interval: %+v", actual)
	}
	for _, status := range []string{"cancelled", "todo", "in_progress", "done"} {
		t.Run(status, func(t *testing.T) {
			f := newHTTPFixture(t, io.Discard)
			f.Tasks.SetStatusFunc = func(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.SetTaskStatus) (model.Task, error) {
				if ctx.Err() != nil || principal != f.principal || projectID != testProjectID || id != testTaskID || input.Version != 4 || input.Status != model.TaskStatus(status) {
					t.Fatalf("terminal refusal input: %+v", input)
				}
				return model.Task{}, &model.Fault{Code: "invalid_transition", Message: "Task execution cannot be restored."}
			}
			assertProjectError(t, projectRequest(f, http.MethodPut, taskCollection(testProjectID)+"/"+testTaskID+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: 4, Status: status})), http.StatusConflict, "invalid_transition")
		})
	}
}
