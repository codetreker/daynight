package task

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

func TestTaskWriteScopeClassification(t *testing.T) {
	title, parent, assignee, claim := "title", "parent", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "claim"
	allow := true
	status := model.TaskTodo
	actor := model.Principal{UserID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
	uppercase := strings.ToUpper(actor.UserID)
	parentValue := &parent
	assigneeValue := &assignee
	empty := []string{}
	tests := []struct {
		name string
		got  []scopepolicy.Operation
		want []scopepolicy.Operation
	}{
		{"create defaults", CreateOperations(CreateTask{}, actor), []scopepolicy.Operation{scopepolicy.TaskWrite}},
		{"create combined", CreateOperations(CreateTask{AssignedToPresent: true, AssignedTo: &assignee, ParentID: &parent, Status: &status}, actor), []scopepolicy.Operation{scopepolicy.TaskWrite, scopepolicy.TaskAssign, scopepolicy.TaskDependencies, scopepolicy.TaskStatus}},
		{"create explicit default assignee", CreateOperations(CreateTask{AssignedToPresent: true, AssignedTo: &actor.UserID, DefaultAssignedTo: &actor.UserID}, actor), []scopepolicy.Operation{scopepolicy.TaskWrite}},
		{"MCP canonical default", CreateOperations(CreateTask{AssignedToPresent: true, AssignedTo: &uppercase, DefaultAssignedTo: &actor.UserID}, actor), []scopepolicy.Operation{scopepolicy.TaskWrite}},
		{"REST self assignment", CreateOperations(CreateTask{AssignedToPresent: true, AssignedTo: &actor.UserID}, actor), []scopepolicy.Operation{scopepolicy.TaskWrite, scopepolicy.TaskAssign}},
		{"title", UpdateOperations(UpdateTask{Title: &title}), []scopepolicy.Operation{scopepolicy.TaskWrite}},
		{"allow", UpdateOperations(UpdateTask{AllowAgents: &allow}), []scopepolicy.Operation{scopepolicy.AgentAuthorize}},
		{"combined", UpdateOperations(UpdateTask{Title: &title, AllowAgents: &allow, ParentID: &parentValue, AssignedTo: &assigneeValue, DependsOn: &empty, Properties: model.TaskPropertiesPatch{"paused": json.RawMessage(`true`), "pullRequests": json.RawMessage(`[]`)}}), nil},
		{"tags", UpdateOperations(UpdateTask{TagIDs: &empty}), []scopepolicy.Operation{scopepolicy.TaskWrite}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "combined" {
				ids, err := scopepolicy.Requirements(tc.got...)
				want := []scopepolicy.ScopeID{"agent:authorize", "task:assign", "task:dependencies", "task:status", "task:write"}
				if err != nil || !reflect.DeepEqual(ids, want) {
					t.Fatalf("got %v, %v; want %v", ids, err, want)
				}
			} else if !reflect.DeepEqual(tc.got, tc.want) {
				t.Fatalf("got %v; want %v", tc.got, tc.want)
			}
		})
	}
	if PropertyOperation("paused") != scopepolicy.TaskStatus || PropertyOperation("pullRequests") != scopepolicy.TaskWrite {
		t.Fatal("property classification changed")
	}
	if StatusOperation(SetTaskStatus{Status: model.TaskDone}) != scopepolicy.TaskStatus || StatusOperation(SetTaskStatus{Status: model.TaskDone, ClaimID: &claim}) != scopepolicy.WorkerComplete {
		t.Fatal("status classification changed")
	}
}
