package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func callTaskResource(t *testing.T, client *sdk.ClientSession, name string, args map[string]any) (*sdk.CallToolResult, map[string]any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return result, structured(t, result)
}

func taskData(t *testing.T, client *sdk.ClientSession, name string, args map[string]any) map[string]any {
	t.Helper()
	result, envelope := callTaskResource(t, client, name, args)
	if result.IsError {
		t.Fatalf("%s rejected: %#v", name, envelope)
	}
	return object(t, envelope["data"])
}

func taskError(t *testing.T, client *sdk.ClientSession, name string, args map[string]any, code string) {
	t.Helper()
	result, envelope := callTaskResource(t, client, name, args)
	if !result.IsError || object(t, envelope["error"])["code"] != code {
		t.Fatalf("%s expected %s: %#v", name, code, envelope)
	}
}

func taskResourceFault(code string) error {
	return &model.Fault{Code: code, Message: "Task operation refused."}
}
func taskResourceStatus(value model.TaskStatus) *model.TaskStatus { return &value }
func taskResourceString(value string) *string                     { return &value }
func taskResourceList(value ...string) *[]string                  { return &value }

func expectTaskGet(t *testing.T, f *taskResourceFixture, result model.Task, err error) {
	t.Helper()
	f.operations.wantCalls["Get"]++
	f.operations.GetFunc = func(_ context.Context, _ model.Principal, _, id string) (model.Task, error) {
		if id != result.ID {
			t.Errorf("Get Task ID: got %s want %s", id, result.ID)
		}
		return result, err
	}
}
func expectTaskCreate(t *testing.T, f *taskResourceFixture, input taskcore.CreateTask, result model.Task, err error) {
	t.Helper()
	f.operations.wantCalls["Create"]++
	f.operations.CreateFunc = func(_ context.Context, _ model.Principal, _ string, actual taskcore.CreateTask) (model.Task, error) {
		if !reflect.DeepEqual(actual, input) {
			t.Error("Create changed the Task input")
		}
		return result, err
	}
}
func expectTaskUpdate(t *testing.T, f *taskResourceFixture, input taskcore.UpdateTask, ordinary, external *[]string, result model.Task, err error) {
	t.Helper()
	f.operations.wantCalls["Update"]++
	f.operations.UpdateFunc = func(_ context.Context, _ model.Principal, _, id string, actual taskcore.UpdateTask, gotOrdinary, gotExternal *[]string) (model.Task, error) {
		if id != result.ID || !reflect.DeepEqual(actual, input) || !reflect.DeepEqual(gotOrdinary, ordinary) || !reflect.DeepEqual(gotExternal, external) {
			t.Error("Update changed the Task ID, input or dependency partition")
		}
		return result, err
	}
}
func expectTaskStatus(t *testing.T, f *taskResourceFixture, input taskcore.SetTaskStatus, result model.Task, err error) {
	t.Helper()
	f.operations.wantCalls["SetStatus"]++
	f.operations.SetStatusFunc = func(_ context.Context, _ model.Principal, _, id string, actual taskcore.SetTaskStatus) (model.Task, error) {
		if id != result.ID || !reflect.DeepEqual(actual, input) {
			t.Error("SetStatus changed the Task ID, version, status or claim")
		}
		return result, err
	}
}

func TestMCPTaskCreationStatusAndProposedStatusWrite(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status *model.TaskStatus
	}{
		{name: "omitted"},
		{name: "proposed", status: taskResourceStatus(model.TaskProposed)},
		{name: "todo", status: taskResourceStatus(model.TaskTodo)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newTaskResourceFixture(t)
			current := taskFixtureTask()
			current.Status, current.Ready = model.TaskProposed, false
			if tc.status != nil {
				current.Status = *tc.status
				current.Ready = *tc.status == model.TaskTodo
			}
			expectTaskCreate(t, f, taskcore.CreateTask{Title: current.Title, AssignedTo: &f.principal.UserID, Status: tc.status}, current, nil)
			args := map[string]any{"projectId": f.project, "title": current.Title, "returnView": "full"}
			if tc.status != nil {
				args["status"] = *tc.status
			}
			created := taskData(t, f.client, "task_create", args)
			if created["status"] != string(current.Status) || created["ready"] != current.Ready {
				t.Fatalf("creation status projection: %#v", created)
			}
		})
	}
	f := newTaskResourceFixture(t)
	for _, status := range []any{nil, "", "in_progress", "done", "cancelled", "unknown", 1} {
		taskError(t, f.client, "task_create", map[string]any{"projectId": f.project, "title": "Invalid", "status": status}, "invalid_input")
	}
	current := taskFixtureTask()
	current.Status, current.Ready, current.Version = model.TaskProposed, false, 2
	expectTaskStatus(t, f, taskcore.SetTaskStatus{Version: 1, Status: model.TaskProposed}, current, nil)
	changed := taskData(t, f.client, "task_set_status", map[string]any{"projectId": f.project, "taskId": current.ID, "status": "proposed", "ifVersion": "1", "returnView": "full"})
	if changed["status"] != "proposed" || changed["version"] != "2" {
		t.Fatalf("proposed status projection: %#v", changed)
	}
}

func TestMCPTaskResourcesDependenciesVersionsAndDeletion(t *testing.T) {
	f := newTaskResourceFixture(t)
	prerequisite := taskFixtureTask()
	prerequisite.ID, prerequisite.Title = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Prerequisite"
	expectTaskCreate(t, f, taskcore.CreateTask{Title: prerequisite.Title, AssignedTo: &f.principal.UserID}, prerequisite, nil)
	pre := taskData(t, f.client, "task_create", map[string]any{"projectId": f.project, "title": prerequisite.Title, "returnView": "full"})
	if pre["id"] != prerequisite.ID {
		t.Fatalf("prerequisite identity: %#v", pre)
	}
	current := taskFixtureTask()
	current.Title, current.Ready = "Dependent", false
	current.DependsOn, current.ExternalDependsOn, current.BlockedBy = []string{prerequisite.ID}, []string{prerequisite.ID}, []string{prerequisite.ID}
	expectTaskCreate(t, f, taskcore.CreateTask{Title: current.Title, AssignedTo: &f.principal.UserID, DependsOn: current.DependsOn, ExternalDependsOn: current.ExternalDependsOn}, current, nil)
	created := taskData(t, f.client, "task_create", map[string]any{"projectId": f.project, "title": current.Title, "externalDependsOn": current.ExternalDependsOn, "returnView": "full"})
	if created["assignedTo"] != f.principal.UserID || created["status"] != "todo" || created["allowAgents"] != false || created["projection"] != "full" || !reflect.DeepEqual(created["dependsOn"], []any{prerequisite.ID}) || !reflect.DeepEqual(created["externalDependsOn"], []any{prerequisite.ID}) {
		t.Fatalf("create resource: %#v", created)
	}
	key := map[string]any{"projectId": f.project, "taskId": current.ID}
	expectTaskGet(t, f, current, nil)
	show := taskData(t, f.client, "task_show", key)
	if show["projection"] != "summary" || show["version"] != "1" {
		t.Fatalf("default projection: %#v", show)
	}
	if _, present := show["description"]; present {
		t.Fatalf("summary included full content: %#v", show)
	}
	expectTaskGet(t, f, current, nil)
	full := taskData(t, f.client, "task_show", map[string]any{"projectId": f.project, "taskId": current.ID, "view": "full"})
	if full["projection"] != "full" || full["description"] != "" {
		t.Fatalf("explicit full view: %#v", full)
	}
	taskError(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": current.ID, "title": "Dependent", "ifVersion": "9223372036854775808"}, "invalid_input")
	expectTaskGet(t, f, current, nil)
	expectTaskStatus(t, f, taskcore.SetTaskStatus{Version: 1, Status: model.TaskInProgress}, current, taskResourceFault("dependency_unsatisfied"))
	taskError(t, f.client, "task_set_status", map[string]any{"projectId": f.project, "taskId": current.ID, "status": "in_progress"}, "dependency_unsatisfied")
	expectTaskGet(t, f, prerequisite, nil)
	expectTaskUpdate(t, f, taskcore.UpdateTask{Version: 1}, taskResourceList(current.ID), nil, prerequisite, taskResourceFault("dependency_cycle"))
	taskError(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": prerequisite.ID, "dependsOn": []string{current.ID}}, "dependency_cycle")
	expectTaskGet(t, f, current, nil)
	expectTaskUpdate(t, f, taskcore.UpdateTask{Version: 1}, taskResourceList(prerequisite.ID), taskResourceList(prerequisite.ID), current, taskResourceFault("invalid_input"))
	taskError(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": current.ID, "dependsOn": []string{prerequisite.ID}, "externalDependsOn": []string{prerequisite.ID}}, "invalid_input")
	taskError(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": current.ID, "dependsOn": []string{prerequisite.ID, prerequisite.ID}}, "invalid_input")

	current.Version, current.ExternalDependsOn = 2, []string{}
	expectTaskUpdate(t, f, taskcore.UpdateTask{Version: 1}, taskResourceList(prerequisite.ID), nil, current, nil)
	updated := taskData(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": current.ID, "dependsOn": []string{prerequisite.ID}, "ifVersion": "1", "returnView": "full"})
	if updated["version"] != "2" || !reflect.DeepEqual(updated["dependsOn"], []any{prerequisite.ID}) || !reflect.DeepEqual(updated["externalDependsOn"], []any{}) {
		t.Fatalf("ordinary reclassification: %#v", updated)
	}
	expectTaskUpdate(t, f, taskcore.UpdateTask{Version: 1}, taskResourceList(prerequisite.ID), nil, current, taskResourceFault("version_conflict"))
	taskError(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": current.ID, "dependsOn": []string{prerequisite.ID}, "ifVersion": "1"}, "version_conflict")
	expectTaskGet(t, f, current, nil)
	current.Description, current.Version = "changed", 3
	expectTaskUpdate(t, f, taskcore.UpdateTask{Version: 2, Description: taskResourceString("changed")}, nil, nil, current, nil)
	updated = taskData(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": current.ID, "description": "changed", "returnView": "full"})
	if !reflect.DeepEqual(updated["dependsOn"], []any{prerequisite.ID}) || !reflect.DeepEqual(updated["externalDependsOn"], []any{}) {
		t.Fatalf("omitted dependency projection: %#v", updated)
	}
	expectTaskGet(t, f, current, nil)
	current.DependsOn, current.ExternalDependsOn, current.BlockedBy, current.Version = []string{}, []string{}, []string{}, 4
	empty := []string{}
	expectTaskUpdate(t, f, taskcore.UpdateTask{Version: 3}, nil, &empty, current, nil)
	updated = taskData(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": current.ID, "externalDependsOn": []string{}, "returnView": "full"})
	if !reflect.DeepEqual(updated["dependsOn"], []any{}) || !reflect.DeepEqual(updated["externalDependsOn"], []any{}) {
		t.Fatalf("empty collection projection: %#v", updated)
	}
	var cleared *string
	platform := model.PlatformLinux
	expectTaskGet(t, f, current, nil)
	current.AssignedTo, current.RequiredPlatform, current.Version = nil, &platform, 5
	expectTaskUpdate(t, f, taskcore.UpdateTask{Version: 4, AssignedTo: &cleared, RequiredPlatform: &current.RequiredPlatform}, nil, nil, current, nil)
	updated = taskData(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": current.ID, "assignedTo": nil, "requiredPlatform": "linux", "returnView": "full"})
	if updated["assignedTo"] != nil || updated["requiredPlatform"] != "linux" {
		t.Fatalf("nullable assignment/platform: %#v", updated)
	}
	expectTaskGet(t, f, current, nil)
	var clearedPlatform *model.TaskPlatform
	current.RequiredPlatform, current.Version = nil, 6
	expectTaskUpdate(t, f, taskcore.UpdateTask{Version: 5, RequiredPlatform: &clearedPlatform}, nil, nil, current, nil)
	updated = taskData(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": current.ID, "requiredPlatform": nil, "returnView": "full"})
	if updated["assignedTo"] != nil || updated["requiredPlatform"] != nil {
		t.Fatalf("nullable platform clearing: %#v", updated)
	}
	expectTaskGet(t, f, current, nil)
	current.Status, current.Version = model.TaskInProgress, 7
	expectTaskStatus(t, f, taskcore.SetTaskStatus{Version: 6, Status: model.TaskInProgress}, current, nil)
	started := taskData(t, f.client, "task_set_status", map[string]any{"projectId": f.project, "taskId": current.ID, "status": "in_progress"})
	if started["status"] != "in_progress" || started["projection"] != "summary" {
		t.Fatalf("start response: %#v", started)
	}
	claim := uuid.NewString()
	taskError(t, f.client, "task_set_status", map[string]any{"projectId": f.project, "taskId": current.ID, "status": "in_progress", "claimId": claim}, "invalid_input")
	expectTaskGet(t, f, current, nil)
	f.operations.wantCalls["Delete"]++
	f.operations.DeleteFunc = func(_ context.Context, _ model.Principal, _, id string, in taskcore.DeleteTask) error {
		if id != current.ID || in.Version != current.Version || in.RemoveDepends {
			t.Error("Delete changed scoped ID, version or removal mode")
		}
		return nil
	}
	deleted := taskData(t, f.client, "task_delete", key)
	if deleted["projectId"] != f.project || deleted["taskId"] != current.ID || deleted["deleted"] != true {
		t.Fatalf("delete receipt: %#v", deleted)
	}
	expectTaskGet(t, f, current, taskResourceFault("task_deleted"))
	taskError(t, f.client, "task_show", key, "task_deleted")
}

func TestMCPTaskProperties(t *testing.T) {
	f := newTaskResourceFixture(t)
	current := taskFixtureTask()
	schema := taskData(t, f.client, "task_properties", map[string]any{"mode": "schema"})
	if _, ok := object(t, schema["properties"])["pullRequests"]; !ok {
		t.Fatalf("missing property definition: %#v", schema)
	}
	taskError(t, f.client, "task_properties", map[string]any{"mode": "schema", "projectId": f.project}, "invalid_input")
	taskError(t, f.client, "task_properties", map[string]any{"mode": "values", "projectId": f.project}, "invalid_input")
	expectTaskGet(t, f, current, nil)
	current.Version, current.Properties = 2, model.TaskProperties{"pullRequests": json.RawMessage(`[]`)}
	f.operations.wantCalls["SetProperty"]++
	f.operations.SetPropertyFunc = func(_ context.Context, _ model.Principal, _, id, name, value string, version int64) (model.Task, error) {
		if id != current.ID || name != "pullRequests" || value != "[]" || version != 1 {
			t.Error("SetProperty changed identity, text or inferred version")
		}
		return current, nil
	}
	set := map[string]any{"projectId": f.project, "taskId": current.ID, "name": "pullRequests", "valueText": "[]", "returnView": "full"}
	resource := taskData(t, f.client, "task_set_property", set)
	if !reflect.DeepEqual(object(t, resource["properties"])["pullRequests"], []any{}) {
		t.Fatalf("empty property: %#v", resource)
	}
	expectTaskGet(t, f, current, nil)
	values := taskData(t, f.client, "task_properties", map[string]any{"projectId": f.project, "taskId": current.ID, "mode": "values"})
	if values["version"] != "2" || !reflect.DeepEqual(object(t, values["properties"])["pullRequests"], []any{}) {
		t.Fatalf("property resource: %#v", values)
	}
	for _, tc := range []struct{ value, version, code string }{{"null", "2", "invalid_input"}, {"[]", "1", "version_conflict"}} {
		f.operations.wantCalls["SetProperty"]++
		f.operations.SetPropertyFunc = func(_ context.Context, _ model.Principal, _, id, name, value string, version int64) (model.Task, error) {
			if id != current.ID || name != "pullRequests" || value != tc.value || Decimal(version) != tc.version {
				t.Error("SetProperty changed refusal input")
			}
			return model.Task{}, taskResourceFault(tc.code)
		}
		taskError(t, f.client, "task_set_property", map[string]any{"projectId": f.project, "taskId": current.ID, "name": "pullRequests", "valueText": tc.value, "ifVersion": tc.version}, tc.code)
	}
	expectTaskGet(t, f, current, nil)
	removed := taskFixtureTask()
	removed.Version = 3
	f.operations.wantCalls["RemoveProperty"]++
	f.operations.RemovePropertyFunc = func(_ context.Context, _ model.Principal, _, id, name string, version int64) (model.Task, error) {
		if id != current.ID || name != "pullRequests" || version != 2 {
			t.Error("RemoveProperty changed identity, name or version")
		}
		return removed, nil
	}
	resource = taskData(t, f.client, "task_remove_property", map[string]any{"projectId": f.project, "taskId": current.ID, "name": "pullRequests", "returnView": "full"})
	if _, exists := object(t, resource["properties"])["pullRequests"]; exists {
		t.Fatalf("removed property present: %#v", resource)
	}
	expectTaskGet(t, f, removed, nil)
	values = taskData(t, f.client, "task_properties", map[string]any{"projectId": f.project, "taskId": current.ID, "mode": "values"})
	if _, exists := object(t, values["properties"])["pullRequests"]; exists {
		t.Fatalf("removed property read: %#v", values)
	}
}

func TestMCPTaskCancellationPreservesReadabilityAndSatisfiesDependencies(t *testing.T) {
	f := newTaskResourceFixture(t)
	original := taskFixtureTask()
	original.Description = "Retained material"
	expectTaskGet(t, f, original, nil)
	first := taskData(t, f.client, "task_show", map[string]any{"projectId": f.project, "taskId": original.ID, "view": "full"})
	if value, present := first["cancelledAt"]; !present || value != nil {
		t.Fatalf("nullable cancellation time: %#v", first)
	}
	cancelled := original
	stamp := time.Date(2026, 11, 7, 1, 2, 3, 456789123, time.UTC)
	cancelled.Status, cancelled.Version, cancelled.Ready, cancelled.CancelledAt = model.TaskCancelled, 2, false, &stamp
	expectTaskStatus(t, f, taskcore.SetTaskStatus{Version: 1, Status: model.TaskCancelled}, cancelled, nil)
	args := map[string]any{"projectId": f.project, "taskId": original.ID, "status": "cancelled", "ifVersion": "1", "returnView": "full"}
	resource := taskData(t, f.client, "task_set_status", args)
	if resource["status"] != "cancelled" || resource["version"] != "2" || resource["ready"] != false || resource["description"] != original.Description || resource["assignedTo"] != *original.AssignedTo || resource["allowAgents"] != false || resource["startedAt"] != nil || resource["completedAt"] != nil || resource["cancelledAt"] != stamp.Format(time.RFC3339Nano) {
		t.Fatalf("cancelled resource: %#v", resource)
	}
	expectTaskStatus(t, f, taskcore.SetTaskStatus{Version: 2, Status: model.TaskCancelled}, cancelled, nil)
	args["ifVersion"] = "2"
	if same := taskData(t, f.client, "task_set_status", args); !reflect.DeepEqual(same, resource) {
		t.Fatalf("unchanged cancellation projection: %#v", same)
	}
	expectTaskStatus(t, f, taskcore.SetTaskStatus{Version: 1, Status: model.TaskCancelled}, cancelled, taskResourceFault("version_conflict"))
	args["ifVersion"] = "1"
	taskError(t, f.client, "task_set_status", args, "version_conflict")
	claim := uuid.NewString()
	taskError(t, f.client, "task_set_status", map[string]any{"projectId": f.project, "taskId": original.ID, "status": "cancelled", "claimId": claim}, "invalid_input")
	for _, status := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone} {
		expectTaskStatus(t, f, taskcore.SetTaskStatus{Version: 2, Status: status}, cancelled, taskResourceFault("invalid_transition"))
		taskError(t, f.client, "task_set_status", map[string]any{"projectId": f.project, "taskId": original.ID, "status": status, "ifVersion": "2"}, "invalid_transition")
	}
	expectTaskGet(t, f, cancelled, nil)
	show := taskData(t, f.client, "task_show", map[string]any{"projectId": f.project, "taskId": original.ID, "view": "full"})
	if _, present := show["session"]; !present {
		t.Fatal("observed show omitted session")
	}
	if _, present := resource["session"]; present {
		t.Fatal("mutation acquired a live observation")
	}
	delete(show, "session")
	if !reflect.DeepEqual(show, resource) {
		t.Fatalf("cancelled read projection: %#v", show)
	}
	dependent := taskFixtureTask()
	dependent.ID, dependent.DependsOn, dependent.ExternalDependsOn = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", []string{original.ID}, []string{original.ID}
	expectTaskGet(t, f, dependent, nil)
	ready := taskData(t, f.client, "task_show", map[string]any{"projectId": f.project, "taskId": dependent.ID, "view": "full"})
	if ready["ready"] != true || ready["version"] != "1" || !reflect.DeepEqual(ready["dependsOn"], []any{original.ID}) || !reflect.DeepEqual(ready["externalDependsOn"], []any{original.ID}) {
		t.Fatalf("dependent resource projection: %#v", ready)
	}
	queries := &taskResourceQueryMock{base: f.operations}
	f.operations.wantCalls["Graph"] = 1
	f.operations.wantCalls["MCPList"] = 2
	queries.GraphFunc = func(_ context.Context, _ model.Principal, _, taskID string) (model.TaskGraph, error) {
		if taskID != original.ID {
			t.Error("Graph changed the scoped Task ID")
		}
		return model.TaskGraph{Summary: model.TaskGraphSummary{Total: 1, Cancelled: 1}, Tasks: []model.GraphTask{{ID: original.ID, Status: model.TaskCancelled, CancelledAt: &stamp}}}, nil
	}
	queries.ListFunc = func(_ context.Context, _ model.Principal, _ string, input taskcore.MCPListRequest, visit func(store.TaskPriorityItem, string, bool) bool) error {
		if !reflect.DeepEqual(input, taskcore.MCPListRequest{Limit: 50, View: "summary"}) || visit == nil {
			t.Error("unfinished Task list changed its filter or projection")
		}
		if !visit(store.TaskPriorityItem{Task: dependent}, "", false) {
			t.Error("unfinished Task item was not accepted")
		}
		return nil
	}
	if err := registerTaskQueryTools(f.entry, queries); err != nil {
		t.Fatal(err)
	}
	graph := taskData(t, f.client, "task_graph", map[string]any{"projectId": f.project, "taskId": original.ID, "view": "full"})
	summary := object(t, graph["summary"])
	if summary["cancelled"] != float64(1) || summary["done"] != float64(0) || summary["ready"] != float64(0) || summary["total"] != float64(1) {
		t.Fatalf("graph cancellation summary: %#v", summary)
	}
	if node := object(t, graph["tasks"].([]any)[0]); node["id"] != original.ID || node["cancelledAt"] != stamp.Format(time.RFC3339Nano) {
		t.Fatalf("graph cancellation time: %#v", node)
	}
	list := taskData(t, f.client, "task_list", map[string]any{"projectId": f.project})
	if items := list["items"].([]any); len(items) != 1 || object(t, items[0])["id"] != dependent.ID {
		t.Fatalf("unfinished list projection: %#v", list)
	}
	queries.ListFunc = func(_ context.Context, _ model.Principal, _ string, input taskcore.MCPListRequest, visit func(store.TaskPriorityItem, string, bool) bool) error {
		status := model.TaskCancelled
		if !reflect.DeepEqual(input, taskcore.MCPListRequest{Limit: 50, View: "full", Status: &status}) || visit == nil {
			t.Error("cancelled Task list changed its filter or projection")
		}
		if !visit(store.TaskPriorityItem{Task: cancelled}, "", false) {
			t.Error("cancelled Task item was not accepted")
		}
		return nil
	}
	list = taskData(t, f.client, "task_list", map[string]any{"projectId": f.project, "status": "cancelled", "view": "full"})
	if items := list["items"].([]any); len(items) != 1 || object(t, items[0])["id"] != original.ID || object(t, items[0])["cancelledAt"] != stamp.Format(time.RFC3339Nano) {
		t.Fatalf("cancelled list projection: %#v", list)
	}
}

func TestMCPTaskCancellationRequiresReleaseAndClearsClaim(t *testing.T) {
	f := newTaskResourceFixture(t)
	current := taskFixtureTask()
	current.Version, current.AllowAgents, current.Status = 3, true, model.TaskInProgress
	expectTaskStatus(t, f, taskcore.SetTaskStatus{Version: 3, Status: model.TaskCancelled}, current, taskResourceFault("invalid_transition"))
	taskError(t, f.client, "task_set_status", map[string]any{"projectId": f.project, "taskId": current.ID, "status": "cancelled", "ifVersion": "3"}, "invalid_transition")
	cancelled := current
	stamp := current.UpdatedAt.Add(time.Minute)
	cancelled.Version, cancelled.Status, cancelled.CancelledAt = 5, model.TaskCancelled, &stamp
	cancelled.Properties = model.TaskProperties{}
	expectTaskStatus(t, f, taskcore.SetTaskStatus{Version: 4, Status: model.TaskCancelled}, cancelled, nil)
	resource := taskData(t, f.client, "task_set_status", map[string]any{"projectId": f.project, "taskId": current.ID, "status": "cancelled", "ifVersion": "4", "returnView": "full"})
	if resource["status"] != "cancelled" || resource["allowAgents"] != true || object(t, resource["properties"])["worker"] != nil {
		t.Fatalf("released cancellation retained ownership: %#v", resource)
	}
}

func TestMCPTaskCompletesOnlyExplicitClaim(t *testing.T) {
	f := newTaskResourceFixture(t)
	current := taskFixtureTask()
	current.Version, current.Status = 3, model.TaskInProgress
	wrong, claim := uuid.NewString(), uuid.NewString()
	expectTaskStatus(t, f, taskcore.SetTaskStatus{Version: 3, Status: model.TaskDone, ClaimID: &wrong}, current, taskResourceFault("claim_conflict"))
	taskError(t, f.client, "task_set_status", map[string]any{"projectId": f.project, "taskId": current.ID, "status": "done", "claimId": wrong, "ifVersion": "3"}, "claim_conflict")
	done := current
	worker, err := json.Marshal(map[string]any{"claimId": claim, "state": "completed"})
	if err != nil {
		t.Fatal(err)
	}
	done.Version, done.Status, done.Properties = 4, model.TaskDone, model.TaskProperties{"worker": worker}
	expectTaskStatus(t, f, taskcore.SetTaskStatus{Version: 3, Status: model.TaskDone, ClaimID: &claim}, done, nil)
	resource := taskData(t, f.client, "task_set_status", map[string]any{"projectId": f.project, "taskId": current.ID, "status": "done", "claimId": claim, "ifVersion": "3", "returnView": "full"})
	history := object(t, object(t, resource["properties"])["worker"])
	if resource["status"] != "done" || history["state"] != "completed" || history["claimId"] != claim {
		t.Fatalf("claim completion: %#v", resource)
	}
}

func TestMCPTaskPropertyBudgetFollowsMode(t *testing.T) {
	f := newTaskResourceFixture(t)
	release, err := f.entry.budget.Acquire(context.Background(), BudgetLarge)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	schema := taskData(t, f.client, "task_properties", map[string]any{"mode": "schema"})
	if _, ok := object(t, schema["properties"])["paused"]; !ok {
		t.Fatalf("schema response: %#v", schema)
	}
	taskError(t, f.client, "task_properties", map[string]any{"mode": "values", "projectId": f.project, "taskId": testTargetID}, "resource_busy")
	release()
	expectTaskGet(t, f, taskFixtureTask(), nil)
	values := taskData(t, f.client, "task_properties", map[string]any{"mode": "values", "projectId": f.project, "taskId": testTargetID})
	if values["taskId"] != testTargetID {
		t.Fatalf("property response: %#v", values)
	}
}

func TestMCPTaskBusinessJSONLimit(t *testing.T) {
	f := newTaskResourceFixture(t)
	description := strings.Repeat("x", 65536)
	current := taskFixtureTask()
	current.Title, current.Description = "Limit", description
	expectTaskCreate(t, f, taskcore.CreateTask{Title: "Limit", Description: description, AssignedTo: &f.principal.UserID}, current, nil)
	data := taskData(t, f.client, "task_create", map[string]any{"projectId": f.project, "title": "Limit", "description": description, "returnView": "full"})
	if data["description"] != description {
		t.Fatal("exact-limit description changed during request/response encoding")
	}
	expectTaskCreate(t, f, taskcore.CreateTask{Title: "Limit", Description: description + "x", AssignedTo: &f.principal.UserID}, model.Task{}, taskResourceFault("invalid_input"))
	taskError(t, f.client, "task_create", map[string]any{"projectId": f.project, "title": "Limit", "description": description + "x"}, "invalid_input")
}

func TestMCPTaskRejectsDuplicateVersionBeforeWrite(t *testing.T) {
	f := newTaskResourceFixture(t)
	body := fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"task_update","arguments":{"projectId":%q,"taskId":%q,"ifVersion":"1","ifVersion":"2","title":"Changed"}}}`, f.project, testTargetID)
	response, raw := rpcTaskRawRequest(t, f.server.URL, "2025-11-25", []byte(body))
	var result struct {
		Result struct {
			IsError           bool `json:"isError"`
			StructuredContent struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			} `json:"structuredContent"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || !result.Result.IsError || result.Result.StructuredContent.Error.Code != "invalid_input" {
		t.Fatalf("duplicate response: status=%d result=%#v", response.StatusCode, result)
	}
}

func TestMCPTaskPropertyBusinessLimitCountsEncodedText(t *testing.T) {
	f := newTaskResourceFixture(t)
	valueText, err := json.Marshal([]map[string]string{{"url": strings.Repeat(`"`, 350000), "title": "Quoted"}})
	if err != nil {
		t.Fatal(err)
	}
	restBody, err := json.Marshal(map[string]any{"version": 1, "valueText": string(valueText)})
	if err != nil {
		t.Fatal(err)
	}
	if len(valueText) >= 1<<20 || len(restBody) <= 1<<20 {
		t.Fatalf("fixture does not cross encoded limit: text=%d body=%d", len(valueText), len(restBody))
	}
	taskError(t, f.client, "task_set_property", map[string]any{"projectId": f.project, "taskId": testTargetID, "name": "pullRequests", "valueText": string(valueText), "ifVersion": "1"}, "invalid_input")
}

func TestMCPTaskBusinessLimitDoesNotEscapeRawHTML(t *testing.T) {
	f := newTaskResourceFixture(t)
	description := strings.Repeat("<", 65536)
	current := taskFixtureTask()
	current.Title, current.Description = "HTML", description
	expectTaskCreate(t, f, taskcore.CreateTask{Title: "HTML", Description: description, AssignedTo: &f.principal.UserID}, current, nil)
	body := fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"task_create","arguments":{"projectId":%q,"title":"HTML","description":"%s","returnView":"full"}}}`, f.project, description)
	response, raw := rpcTaskRawRequest(t, f.server.URL, "2025-11-25", []byte(body))
	var result struct {
		Result struct {
			IsError           bool `json:"isError"`
			StructuredContent struct {
				Data struct {
					ID          string `json:"id"`
					Description string `json:"description"`
				} `json:"data"`
			} `json:"structuredContent"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || result.Result.IsError || result.Result.StructuredContent.Data.ID != current.ID || result.Result.StructuredContent.Data.Description != description {
		t.Fatalf("raw HTML at limit: status=%d id=%s error=%v", response.StatusCode, result.Result.StructuredContent.Data.ID, result.Result.IsError)
	}
}

func TestMCPTaskUnknownCommitIsNotReplayed(t *testing.T) {
	f := newTaskResourceFixture(t)
	before := taskFixtureTask()
	expectTaskGet(t, f, before, nil)
	unknown := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("commit response lost")}
	expectTaskUpdate(t, f, taskcore.UpdateTask{Version: 1, Title: taskResourceString("After")}, nil, nil, before, unknown)
	result, envelope := callTaskResource(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": before.ID, "title": "After"})
	failure := object(t, envelope["error"])
	if !result.IsError || failure["writeOutcome"] != "unknown" || failure["phase"] != "commit" {
		t.Fatalf("unknown result: %#v", envelope)
	}
}

func TestMCPTaskExternalDependenciesCountCompiledBusinessPayload(t *testing.T) {
	f := newTaskResourceFixture(t)
	dependencies := make([]string, 14000)
	for i := range dependencies {
		dependencies[i] = uuid.NewString()
	}
	input, err := json.Marshal(map[string]any{"title": "Large", "externalDependsOn": dependencies})
	if err != nil {
		t.Fatal(err)
	}
	compiled, err := json.Marshal(map[string]any{"title": "Large", "dependsOn": dependencies, "externalDependsOn": dependencies})
	if err != nil {
		t.Fatal(err)
	}
	if len(input) >= 1<<20 || len(compiled) <= 1<<20 {
		t.Fatalf("fixture does not cross compiled limit: input=%d compiled=%d", len(input), len(compiled))
	}
	taskError(t, f.client, "task_create", map[string]any{"projectId": f.project, "title": "Large", "externalDependsOn": dependencies}, "invalid_input")
}

func TestMCPTaskUnchangedMutationReceipt(t *testing.T) {
	f := newTaskResourceFixture(t)
	current := taskFixtureTask()
	current.Title = "Unchanged"
	expectTaskUpdate(t, f, taskcore.UpdateTask{Version: 1, Title: taskResourceString("Unchanged")}, nil, nil, current, nil)
	result, envelope := callTaskResource(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": current.ID, "ifVersion": "1", "title": "Unchanged"})
	if result.IsError || object(t, envelope["meta"])["outcome"] != "unchanged" || object(t, envelope["data"])["version"] != "1" {
		t.Fatalf("unchanged receipt: %#v", envelope)
	}
}

func TestMCPRejectsUnknownToolBudgetClass(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	entry, err := New(testAuthenticator{}, "https://daynight.test", nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := entry.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	tool := simpleTestTool("invalid_budget", testObjectSchema(), standardOutputSchema())
	err = entry.RegisterTool(tool, BudgetClass(255), func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
		t.Error("invalid-budget handler invoked")
		return ToolResult{}, errors.New("invalid-budget handler invoked")
	})
	if err == nil {
		t.Fatal("unknown budget class registered")
	}
}

func TestMCPTaskWriteAdmission(t *testing.T) {
	f := newTaskResourceFixture(t)
	title := strings.Repeat("界", 341) + "x"
	current := taskFixtureTask()
	current.Title, current.Description = title, strings.Repeat("d", 65536)
	expectTaskCreate(t, f, taskcore.CreateTask{Title: title, Description: current.Description, AssignedTo: &f.principal.UserID}, current, nil)
	created := taskData(t, f.client, "task_create", map[string]any{"projectId": f.project, "title": title, "description": current.Description, "returnView": "full"})
	if created["title"] != title || created["description"] != current.Description {
		t.Fatal("maximum field content changed")
	}
	expectTaskCreate(t, f, taskcore.CreateTask{Title: title + "x", AssignedTo: &f.principal.UserID}, model.Task{}, taskResourceFault("invalid_input"))
	taskError(t, f.client, "task_create", map[string]any{"projectId": f.project, "title": title + "x"}, "invalid_input")
	expectTaskGet(t, f, current, nil)
	expectTaskUpdate(t, f, taskcore.UpdateTask{Version: 1, Description: taskResourceString(strings.Repeat("d", 65537))}, nil, nil, current, taskResourceFault("invalid_input"))
	taskError(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": current.ID, "description": strings.Repeat("d", 65537)}, "invalid_input")
	dependencies := make([]string, 31)
	for i := range dependencies {
		dependencies[i] = uuid.NewString()
	}
	expectTaskGet(t, f, current, nil)
	expectTaskUpdate(t, f, taskcore.UpdateTask{Version: 1}, &dependencies, nil, current, taskResourceFault("invalid_input"))
	taskError(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": current.ID, "dependsOn": dependencies}, "invalid_input")
}
