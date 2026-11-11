package mcp

import (
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestTypedQueryInputsThroughMCP(t *testing.T) {
	for _, name := range []string{"task_list", "task_ready"} {
		for _, tc := range []struct {
			name    string
			input   any
			present bool
			want    string
		}{
			{"omitted", nil, false, ""}, {"null", nil, true, "none"}, {"goal", testTargetID, true, testTargetID},
		} {
			t.Run(name+"/"+tc.name, func(t *testing.T) {
				stub := &queryStub{}
				f := newEntryFixture(t)
				if err := registerTaskQueryTools(f.entry, stub); err != nil {
					t.Fatal(err)
				}
				client := f.client(t, "2026-07-28", "alice")
				args := map[string]any{"projectId": testProjectID}
				if tc.present {
					args["parentId"] = tc.input
				}
				if name == "task_list" {
					args["type"] = "goal"
					if tc.want == testTargetID {
						args["type"] = "task"
					}
				}
				result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: name, Arguments: args})
				if err != nil || result.IsError {
					t.Fatalf("result=%+v error=%v", result, err)
				}
				var got *string
				if name == "task_list" {
					got = stub.request.Parent
					expected := model.TaskTypeGoal
					if tc.want == testTargetID {
						expected = model.TaskTypeTask
					}
					if stub.request.Type != expected {
						t.Fatalf("type = %q", stub.request.Type)
					}
				} else {
					got = stub.readyRequest.Parent
				}
				if tc.present && (got == nil || *got != tc.want) || !tc.present && got != nil {
					t.Fatalf("parent = %v; want %q (present %v)", got, tc.want, tc.present)
				}
			})
		}
	}
}

func TestGoalFullListEncodesServiceProgress(t *testing.T) {
	stamp := time.Date(2026, 11, 10, 1, 2, 3, 0, time.UTC)
	goal := taskFixtureTask()
	goal.Type, goal.Ready = model.TaskTypeGoal, false
	goal.Progress = &model.GoalProgress{Total: 7, Done: 2, Cancelled: 1, Unfinished: 4}
	allowed := false
	freshUntil := stamp.Add(time.Minute)
	session := sp.TaskSessionObservation{SchemaVersion: 1, Observation: "observed", Registration: "not_applicable", Reason: "no_execution", Send: sp.TaskSessionSend{Allowed: &allowed, Reason: "no_execution"}, ObservedAt: &stamp, FreshUntil: &freshUntil}
	mock := newQueryObservationPortMock(t, "list")
	mock.request = taskcore.MCPListRequest{Type: model.TaskTypeGoal, Limit: 50, View: "full"}
	mock.page = taskservice.ObservedMCPPage{Items: []taskservice.ObservedMCPItem{{Item: store.TaskPriorityItem{Task: goal}, Session: session}}, ObservedAt: stamp}
	f := newEntryFixture(t)
	if err := RegisterTaskQueryTools(f.entry, nil, mock); err != nil {
		t.Fatal(err)
	}
	result, err := f.client(t, "2026-07-28", "alice").CallTool(t.Context(), &sdk.CallToolParams{Name: "task_list", Arguments: map[string]any{"projectId": testProjectID, "type": "goal", "view": "full"}})
	if err != nil || result.IsError {
		t.Fatalf("result=%+v error=%v", result, err)
	}
	data := object(t, structured(t, result)["data"])
	items := data["items"].([]any)
	item := object(t, items[0])
	progress := object(t, item["progress"])
	if item["type"] != "goal" || item["parentId"] != nil || object(t, item["session"])["registration"] != "not_applicable" || progress["total"] != float64(7) || progress["done"] != float64(2) || progress["cancelled"] != float64(1) || progress["unfinished"] != float64(4) {
		t.Fatalf("goal list item = %#v", item)
	}
}
