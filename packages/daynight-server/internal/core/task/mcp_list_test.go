package task

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type mcpListFixture struct {
	fence store.TaskListFence
	query store.TaskPriorityQuery
	page  store.TaskPriorityPage
	reads int
}

func (f *mcpListFixture) TaskListFence(context.Context, string) (store.TaskListFence, error) {
	return f.fence, nil
}
func (f *mcpListFixture) TaskPriorityList(_ context.Context, _ string, q store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
	f.reads++
	f.query = q
	return f.page, nil
}

func TestMCPListCursorScopeFenceAndTruncatedPage(t *testing.T) {
	project := "00000000-0000-4000-8000-000000000001"
	actor := "00000000-0000-4000-8000-000000000002"
	me := "me"
	req := MCPListRequest{Limit: 2, AssignedTo: &me}
	s, err := SelectMCPList(project, actor, req)
	if err != nil {
		t.Fatal(err)
	}
	task := model.Task{ID: "00000000-0000-4000-8000-000000000003", ProjectID: project, Status: model.TaskTodo, Ready: true, CreatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	f := &mcpListFixture{fence: store.TaskListFence{Count: "3", VersionSum: "9223372036854775808"}, page: store.TaskPriorityPage{Items: []store.TaskPriorityItem{{Task: task}}, HasMore: true}}
	page, err := ReadMCPList(context.Background(), f, project, s)
	if err != nil {
		t.Fatal(err)
	}
	cursor, err := page.CursorAfter(s, task)
	if err != nil {
		t.Fatal(err)
	}
	req.Cursor = &cursor
	next, err := SelectMCPList(project, actor, req)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = ReadMCPList(context.Background(), f, project, next); err != nil {
		t.Fatal(err)
	}
	if f.query.After == nil || f.query.After.ID != task.ID || f.query.After.Group != 1 {
		t.Fatalf("wrong continuation: %+v", f.query.After)
	}
	other := actor
	changed := req
	changed.AssignedTo = &other
	if _, err := SelectMCPList(project, actor, changed); err == nil {
		t.Fatal("me cursor accepted with explicit account")
	}
	changed = req
	yes := true
	changed.Ready = &yes
	if _, err := SelectMCPList(project, actor, changed); err == nil {
		t.Fatal("cursor accepted with changed filter")
	}
	if _, err := SelectMCPList(project, "00000000-0000-4000-8000-000000000004", req); err == nil {
		t.Fatal("cursor accepted by another actor")
	}
	f.fence.VersionSum = "9223372036854775809"
	before := f.reads
	_, err = ReadMCPList(context.Background(), f, project, next)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "list_changed" || f.reads != before {
		t.Fatalf("changed fence: %v", err)
	}
}

func TestMCPListSelectionValidation(t *testing.T) {
	project := "00000000-0000-4000-8000-000000000001"
	actor := "00000000-0000-4000-8000-000000000002"
	status := model.TaskTodo
	bad := "bad"
	for _, req := range []MCPListRequest{{Limit: 0}, {Limit: 101}, {Limit: 1, All: true, Status: &status}, {Limit: 1, View: "other"}, {Limit: 1, Cursor: &bad}} {
		if _, err := SelectMCPList(project, actor, req); err == nil {
			t.Fatalf("accepted %+v", req)
		}
	}
}
