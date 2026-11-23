package mcp

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func TestMCPOrdinaryChildCreationAndResultViews(t *testing.T) {
	for _, expanded := range []bool{false, true} {
		for _, view := range []string{"summary", "full", "receipt"} {
			t.Run(view+map[bool]string{false: "/default", true: "/expanded"}[expanded], func(t *testing.T) {
				f := newTaskResourceFixture(t)
				parent := testUserID
				child := taskFixtureTask()
				child.ParentID, child.ParentType = &parent, model.TaskTypeTask
				expectTaskCreate(t, f, taskcore.CreateTask{ParentTaskID: &parent, Title: child.Title, AssignedTo: &f.principal.UserID}, child, nil)
				args := map[string]any{"projectId": f.project, "title": child.Title, "parentId": nil, "parentTaskId": parent, "returnView": view}
				if expanded {
					args["taskParentView"] = "v1"
				}
				data := taskData(t, f.client, "task_create", args)
				if view == "receipt" {
					want := map[string]any{"projectId": child.ProjectID, "taskId": child.ID, "version": Decimal(child.Version)}
					if !reflect.DeepEqual(data, want) {
						t.Fatalf("minimal child receipt: %#v", data)
					}
				} else {
					assertTaskParentProjection(t, data, parent, expanded)
				}
			})
		}
	}
}

func TestMCPOrdinaryParentInputRefusalsDoNotCallBusiness(t *testing.T) {
	f := newTaskResourceFixture(t)
	for _, fields := range []map[string]any{
		{"parentTaskId": nil},
		{"parentTaskId": true},
		{"parentTaskId": "invalid"},
		{"parentTaskId": testUserID, "parentId": testTargetID},
		{"parentTaskId": testUserID, "type": "goal"},
	} {
		args := map[string]any{"projectId": f.project, "title": "child"}
		for key, value := range fields {
			args[key] = value
		}
		taskError(t, f.client, "task_create", args, "invalid_input")
	}
	for _, value := range []any{nil, testUserID} {
		taskError(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": testTargetID, "ifVersion": "1", "parentTaskId": value}, "invalid_input")
	}
}

func TestMCPChildGoalParentUpdatePreservesImmutableFault(t *testing.T) {
	for _, parent := range []*string{nil, taskResourceString(testUserID)} {
		f := newTaskResourceFixture(t)
		child := taskFixtureTask()
		expectTaskUpdate(t, f, taskcore.UpdateTask{Version: child.Version, ParentID: &parent}, nil, nil, child, taskResourceFault("task_parent_immutable"))
		taskError(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": child.ID, "parentId": parent, "ifVersion": "1"}, "task_parent_immutable")
	}
}

func TestMCPConfirmedCancellationInputAndResultViews(t *testing.T) {
	for _, confirm := range []bool{false, true} {
		for _, view := range []string{"summary", "full", "receipt"} {
			f := newTaskResourceFixture(t)
			child := taskFixtureTask()
			parent := testUserID
			child.ParentID, child.ParentType, child.Status = &parent, model.TaskTypeTask, model.TaskCancelled
			expectTaskStatus(t, f, taskcore.SetTaskStatus{Version: 1234567890123456789, Status: model.TaskCancelled, CancelDescendants: confirm, CancelDescendantsPresent: true}, child, nil)
			data := taskData(t, f.client, "task_set_status", map[string]any{"projectId": f.project, "taskId": child.ID, "status": "cancelled", "ifVersion": "1234567890123456789", "cancelDescendants": confirm, "returnView": view, "taskParentView": "v1"})
			if view == "receipt" {
				if len(data) != 3 {
					t.Fatalf("minimal cancellation receipt: %#v", data)
				}
			} else {
				assertTaskParentProjection(t, data, parent, true)
			}
		}
	}
}

func TestMCPCancellationProtocolRefusalsDoNotCallBusiness(t *testing.T) {
	f := newTaskResourceFixture(t)
	for _, value := range []any{nil, "true", 1, []any{}, map[string]any{}} {
		taskError(t, f.client, "task_set_status", map[string]any{"projectId": f.project, "taskId": testTargetID, "ifVersion": "1", "status": "cancelled", "cancelDescendants": value}, "invalid_input")
	}
	for _, status := range []string{"proposed", "todo", "in_progress", "done"} {
		for _, confirm := range []bool{false, true} {
			taskError(t, f.client, "task_set_status", map[string]any{"projectId": f.project, "taskId": testTargetID, "ifVersion": "1", "status": status, "cancelDescendants": confirm}, "invalid_input")
		}
	}
}

func TestMCPCancellationGoalRefusalPreservesPresence(t *testing.T) {
	for _, confirm := range []bool{false, true} {
		f := newTaskResourceFixture(t)
		goal := taskFixtureTask()
		goal.Type = model.TaskTypeGoal
		expectTaskStatus(t, f, taskcore.SetTaskStatus{Version: 1, Status: model.TaskCancelled, CancelDescendants: confirm, CancelDescendantsPresent: true}, goal, taskResourceFault("invalid_input"))
		taskError(t, f.client, "task_set_status", map[string]any{"projectId": f.project, "taskId": goal.ID, "ifVersion": "1", "status": "cancelled", "cancelDescendants": confirm}, "invalid_input")
	}
}

func TestMCPCancellationRedactedFaultAddsNoReferences(t *testing.T) {
	f := newTaskResourceFixture(t)
	current := taskFixtureTask()
	failure := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &model.Fault{Code: "invalid_transition", Message: "Task transition was refused."}}
	expectTaskStatus(t, f, taskcore.SetTaskStatus{Version: 1, Status: model.TaskCancelled, CancelDescendants: true, CancelDescendantsPresent: true}, current, failure)
	result, env := callTaskResource(t, f.client, "task_set_status", map[string]any{"projectId": f.project, "taskId": current.ID, "ifVersion": "1", "status": "cancelled", "cancelDescendants": true})
	fault := object(t, env["error"])
	if !result.IsError || fault["code"] != "invalid_transition" || fault["message"] != "Task transition was refused." || fault["refs"] != nil {
		t.Fatalf("redacted refusal changed: %#v", env)
	}
}

func TestMCPCancellationPreservesKnownAndUnknownOutcomes(t *testing.T) {
	for _, code := range []string{"task_unfinished_children", "task_parent_terminal", "invalid_transition", "version_conflict"} {
		for _, outcome := range []store.TransactionOutcome{store.TransactionNotCommitted, store.TransactionUnknown} {
			f := newTaskResourceFixture(t)
			current := taskFixtureTask()
			failure := &store.TransactionError{Phase: "operation", Outcome: outcome, Cause: &model.Fault{Code: code, Message: "Operation refused.", TaskIDs: []string{testUserID}}}
			expectTaskStatus(t, f, taskcore.SetTaskStatus{Version: 1, Status: model.TaskCancelled, CancelDescendants: true, CancelDescendantsPresent: true}, current, failure)
			result, env := callTaskResource(t, f.client, "task_set_status", map[string]any{"projectId": f.project, "taskId": current.ID, "ifVersion": "1", "status": "cancelled", "cancelDescendants": true})
			fault := object(t, env["error"])
			if !result.IsError {
				t.Fatalf("failure accepted: %#v", env)
			}
			if outcome == store.TransactionNotCommitted {
				if fault["code"] != code || fault["writeOutcome"] != "not_committed" || !reflect.DeepEqual(object(t, fault["refs"])["taskIds"], []any{testUserID}) {
					t.Fatalf("known refusal: %#v", env)
				}
			} else if fault["code"] != "internal_error" || fault["writeOutcome"] != "unknown" || strings.Contains(string(mustJSON(t, env)), testUserID) {
				t.Fatalf("unknown outcome exposed known refusal: %#v", env)
			}
		}
	}
}

func TestMCPChildBusinessLimitCountsMutationFields(t *testing.T) {
	for _, tc := range []struct {
		name   string
		fields map[string]json.RawMessage
		added  map[string]json.RawMessage
	}{
		{"task_create", map[string]json.RawMessage{"title": json.RawMessage(`"x"`)}, map[string]json.RawMessage{"parentTaskId": json.RawMessage(`"` + testUserID + `"`)}},
		{"task_set_status", map[string]json.RawMessage{"version": json.RawMessage(`1`), "status": json.RawMessage(`"cancelled"`)}, map[string]json.RawMessage{"cancelDescendants": json.RawMessage(`false`)}},
	} {
		base, _ := json.Marshal(tc.fields)
		tc.fields["description"] = json.RawMessage(`"` + strings.Repeat("x", httpx.MaxJSONBody-len(base)-len(`,"description":""`)) + `"`)
		if err := taskBusinessLimit(tc.name, tc.fields, 1, nil, nil); err != nil {
			t.Fatalf("%s exact default boundary: %v", tc.name, err)
		}
		for key, value := range tc.added {
			tc.fields[key] = value
		}
		if taskBusinessLimit(tc.name, tc.fields, 1, nil, nil) == nil {
			t.Fatalf("%s excluded ordinary child fields", tc.name)
		}
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
