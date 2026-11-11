package mcp

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func TestMCPGoalCreationAndParentWrites(t *testing.T) {
	f := newTaskResourceFixture(t)
	goal := taskFixtureTask()
	goal.Type, goal.Status, goal.Ready = model.TaskTypeGoal, model.TaskTodo, false
	goal.Progress = &model.GoalProgress{}
	for _, explicit := range []bool{false, true} {
		expectTaskCreate(t, f, taskcore.CreateTask{Type: model.TaskTypeGoal, Title: goal.Title, AssignedToPresent: explicit}, goal, nil)
		args := map[string]any{"projectId": f.project, "title": goal.Title, "type": "goal", "returnView": "full"}
		if explicit {
			args["assignedTo"] = nil
		}
		data := taskData(t, f.client, "task_create", args)
		if data["type"] != "goal" || data["parentId"] != nil || data["progress"] == nil {
			t.Fatalf("goal projection: %#v", data)
		}
	}
	child := taskFixtureTask()
	parent := goal.ID
	for _, value := range []*string{&parent, nil} {
		expectTaskUpdate(t, f, taskcore.UpdateTask{Version: 9223372036854775807, ParentID: &value}, nil, nil, child, nil)
		data := taskData(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": child.ID, "parentId": value, "ifVersion": "9223372036854775807"})
		if data["type"] != "task" {
			t.Fatalf("task projection: %#v", data)
		}
	}
	taskError(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": child.ID, "type": "goal"}, "invalid_input")
	taskError(t, f.client, "task_create", map[string]any{"projectId": f.project, "title": goal.Title, "type": "goal", "requiredPlatform": nil}, "invalid_input")
	taskError(t, f.client, "task_create", map[string]any{"projectId": f.project, "title": goal.Title, "type": "goal", "status": "proposed"}, "invalid_input")
}

func TestMCPTaskBusinessLimitIncludesTypeAndParent(t *testing.T) {
	fields := map[string]json.RawMessage{"type": json.RawMessage(`"task"`), "parentId": json.RawMessage(`null`), "title": json.RawMessage(`"x"`)}
	base, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	// Adding the description's JSON key and quotes fills the exact limit.
	fields["description"] = json.RawMessage(`"` + strings.Repeat("x", httpx.MaxJSONBody-len(base)-len(`,"description":""`)) + `"`)
	if err := taskBusinessLimit("task_create", fields, 0, nil, nil); err != nil {
		t.Fatalf("exact limit: %v", err)
	}
	fields["description"] = append(fields["description"][:len(fields["description"])-1], 'x', '"')
	if err := taskBusinessLimit("task_create", fields, 0, nil, nil); err == nil {
		t.Fatal("accepted oversized body")
	}
}

func TestMCPGoalStatusAndUnavailableParent(t *testing.T) {
	f := newTaskResourceFixture(t)
	goal := taskFixtureTask()
	goal.Type, goal.Status, goal.Ready = model.TaskTypeGoal, model.TaskDone, false
	goal.Progress = &model.GoalProgress{Total: 1, Unfinished: 1}
	expectTaskStatus(t, f, taskcore.SetTaskStatus{Version: 1234567890123456789, Status: model.TaskDone}, goal, nil)
	data := taskData(t, f.client, "task_set_status", map[string]any{"projectId": f.project, "taskId": goal.ID, "status": "done", "ifVersion": "1234567890123456789", "returnView": "full"})
	if data["type"] != "goal" || data["progress"] == nil {
		t.Fatalf("status result: %#v", data)
	}

	child := taskFixtureTask()
	parent := goal.ID
	parentValue := &parent
	expectTaskUpdate(t, f, taskcore.UpdateTask{Version: 1, ParentID: &parentValue}, nil, nil, child, taskResourceFault("invalid_input"))
	taskError(t, f.client, "task_update", map[string]any{"projectId": f.project, "taskId": child.ID, "parentId": parent, "ifVersion": "1"}, "invalid_input")
}

func TestMCPGoalShowPreservesProgress(t *testing.T) {
	f := newTaskResourceFixture(t)
	goal := taskFixtureTask()
	goal.Type, goal.Status, goal.Ready = model.TaskTypeGoal, model.TaskTodo, false
	goal.Progress = &model.GoalProgress{Total: 7, Done: 2, Cancelled: 1, Unfinished: 4}
	expectTaskGet(t, f, goal, nil)
	data := taskData(t, f.client, "task_show", map[string]any{"projectId": f.project, "taskId": goal.ID, "view": "full"})
	progress := object(t, data["progress"])
	if data["type"] != "goal" || data["parentId"] != nil || progress["total"] != float64(7) || progress["done"] != float64(2) || progress["cancelled"] != float64(1) || progress["unfinished"] != float64(4) {
		t.Fatalf("goal show: %#v", data)
	}
}
