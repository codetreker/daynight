package task

import (
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestOrdinaryParentSelectionAndCursorScope(t *testing.T) {
	parent, other, none := relationGoal, relationUpstream, "none"
	for _, input := range []struct {
		kind       model.TaskType
		goal, task *string
	}{
		{model.TaskTypeGoal, nil, &parent}, {model.TaskTypeTask, &parent, &other},
		{model.TaskTypeTask, &none, &parent}, {model.TaskTypeTask, nil, &none},
	} {
		if _, err := ParentTaskFilter(input.kind, input.goal, input.task); err == nil {
			t.Fatalf("invalid parent selection accepted: %+v", input)
		}
	}
	selected, err := SelectList(relationProject, relationEdge, ListRequest{ParentTask: &parent, PageRequest: model.PageRequest{Limit: 2}})
	if err != nil || selected.Query.ParentTask == nil || *selected.Query.ParentTask != parent {
		t.Fatalf("selection: %+v %v", selected, err)
	}
	cursor, err := query.EncodeListCursor(selected.Scope, time.Now(), relationUpstream)
	if err != nil {
		t.Fatal(err)
	}
	request := ListRequest{ParentTask: &parent, PageRequest: model.PageRequest{Limit: 2, Cursor: &cursor}}
	if _, err = SelectList(relationProject, relationEdge, request); err != nil {
		t.Fatal(err)
	}
	for _, changed := range []*string{nil, &other} {
		request.ParentTask = changed
		if _, err = SelectList(relationProject, relationEdge, request); err == nil {
			t.Fatal("cursor accepted another parent filter")
		}
	}
	mcp, err := SelectMCPList(relationProject, relationEdge, MCPListRequest{ParentTask: &parent, Limit: 2})
	if err != nil || mcp.query.ParentTask == nil || *mcp.query.ParentTask != parent {
		t.Fatalf("MCP selection: %+v %v", mcp, err)
	}
	page := MCPListPage{fence: store.TaskListFence{Count: "0", VersionSum: "0"}}
	continuation, err := page.CursorAfter(mcp, model.Task{ID: relationUpstream, ProjectID: relationProject, CreatedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = SelectMCPList(relationProject, relationEdge, MCPListRequest{ParentTask: &parent, Limit: 2, Cursor: &continuation}); err != nil {
		t.Fatal(err)
	}
	if _, err = SelectMCPList(relationProject, relationEdge, MCPListRequest{ParentTask: &other, Limit: 2, Cursor: &continuation}); err == nil {
		t.Fatal("MCP cursor accepted another parent")
	}
	ready, err := SelectMCPReady(MCPReadyRequest{ParentTask: &parent, Limit: 2})
	if err != nil || ready.ParentTask == nil || *ready.ParentTask != parent {
		t.Fatalf("ready selection: %+v %v", ready, err)
	}
}
