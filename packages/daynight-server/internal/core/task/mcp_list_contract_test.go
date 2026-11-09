package task

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type mcpCursorContract struct {
	t          *testing.T
	project    string
	fence      store.TaskListFence
	page       store.TaskPriorityPage
	after      *store.TaskPriorityPosition
	fenceCalls int
	pageCalls  int
	expectPage bool
	ready      *bool
}

func (f *mcpCursorContract) TaskListFence(ctx context.Context, project string) (store.TaskListFence, error) {
	f.t.Helper()
	f.fenceCalls++
	if ctx.Err() != nil || project != f.project || f.fenceCalls != 1 {
		f.t.Fatalf("unexpected fence read: project=%s calls=%d context=%v", project, f.fenceCalls, ctx.Err())
	}
	return f.fence, nil
}

func (f *mcpCursorContract) TaskPriorityList(ctx context.Context, project string, query store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
	f.t.Helper()
	f.pageCalls++
	if !f.expectPage || f.pageCalls != 1 || ctx.Err() != nil || project != f.project || query.Limit != 1 || !reflect.DeepEqual(query.After, f.after) || !reflect.DeepEqual(query.Ready, f.ready) {
		f.t.Fatalf("unexpected priority read: project=%s query=%#v calls=%d context=%v", project, query, f.pageCalls, ctx.Err())
	}
	return f.page, nil
}

func TestMCPListCursorTraversesViewsAndRejectsPredecessorFenceChange(t *testing.T) {
	project := "00000000-0000-4000-8000-000000000001"
	actor := "00000000-0000-4000-8000-000000000050"
	stamp := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	predecessor := model.Task{ID: "00000000-0000-4000-8000-000000000010", ProjectID: project, Status: model.TaskTodo, Ready: true, CreatedAt: stamp}
	dependent := model.Task{ID: "00000000-0000-4000-8000-000000000011", ProjectID: project, Status: model.TaskTodo, CreatedAt: stamp.Add(time.Microsecond), DependsOn: []string{predecessor.ID}, BlockedBy: []string{predecessor.ID}}
	dependent2 := model.Task{ID: "00000000-0000-4000-8000-000000000012", ProjectID: project, Status: model.TaskTodo, CreatedAt: stamp.Add(2 * time.Microsecond), DependsOn: []string{predecessor.ID}, BlockedBy: []string{predecessor.ID}}
	fence := store.TaskListFence{Count: "3", VersionSum: "3"}
	rows := []model.Task{predecessor, dependent, dependent2}
	for _, view := range []string{"summary", "full"} {
		var cursor *string
		var got []string
		var after *store.TaskPriorityPosition
		for index, row := range rows {
			selection, err := SelectMCPList(project, actor, MCPListRequest{Limit: 1, Cursor: cursor, View: view})
			if err != nil {
				t.Fatal(err)
			}
			f := &mcpCursorContract{t: t, project: project, fence: fence, after: after, expectPage: true, page: store.TaskPriorityPage{Items: []store.TaskPriorityItem{{Task: row}}, HasMore: index < len(rows)-1}}
			page, err := ReadMCPList(t.Context(), f, project, selection)
			if err != nil || len(page.Items) != 1 || f.fenceCalls != 1 || f.pageCalls != 1 || page.HasMore != (index < len(rows)-1) {
				t.Fatalf("%s continuation: page=%#v fence=%d reads=%d error=%v", view, page, f.fenceCalls, f.pageCalls, err)
			}
			got = append(got, page.Items[0].Task.ID)
			if page.HasMore {
				next, err := page.CursorAfter(selection, page.Items[0].Task)
				if err != nil {
					t.Fatal(err)
				}
				cursor = &next
				group := 2
				if row.Ready {
					group = 1
				}
				after = &store.TaskPriorityPosition{Group: group, CreatedAt: row.CreatedAt, ID: row.ID}
			}
		}
		if !reflect.DeepEqual(got, []string{predecessor.ID, dependent.ID, dependent2.ID}) {
			t.Fatalf("%s traversal: %v", view, got)
		}
	}
	blocked := false
	selection, err := SelectMCPList(project, actor, MCPListRequest{Limit: 1, Ready: &blocked})
	if err != nil {
		t.Fatal(err)
	}
	f := &mcpCursorContract{t: t, project: project, fence: fence, ready: &blocked, expectPage: true, page: store.TaskPriorityPage{Items: []store.TaskPriorityItem{{Task: dependent}}, HasMore: true}}
	first, err := ReadMCPList(t.Context(), f, project, selection)
	if err != nil {
		t.Fatal(err)
	}
	cursor, err := first.CursorAfter(selection, first.Items[0].Task)
	if err != nil {
		t.Fatal(err)
	}
	next, err := SelectMCPList(project, actor, MCPListRequest{Limit: 1, Cursor: &cursor, Ready: &blocked})
	if err != nil {
		t.Fatal(err)
	}
	changed := &mcpCursorContract{t: t, project: project, fence: store.TaskListFence{Count: "3", VersionSum: "4"}}
	_, err = ReadMCPList(t.Context(), changed, project, next)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "list_changed" || changed.fenceCalls != 1 || changed.pageCalls != 0 {
		t.Fatalf("predecessor change accepted: error=%v fence=%d reads=%d", err, changed.fenceCalls, changed.pageCalls)
	}
}
