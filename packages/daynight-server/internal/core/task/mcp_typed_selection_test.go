package task

import (
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestMCPListTypedScopeAndCursor(t *testing.T) {
	project := "00000000-0000-4000-8000-000000000001"
	actor := "00000000-0000-4000-8000-000000000002"
	parent := "00000000-0000-4000-8000-000000000003"
	none := "none"
	for _, tc := range []struct {
		name   string
		kind   model.TaskType
		parent *string
		want   model.TaskType
	}{
		{"default", "", nil, model.TaskTypeTask}, {"unparented", "", &none, model.TaskTypeTask},
		{"child", model.TaskTypeTask, &parent, model.TaskTypeTask}, {"goal", model.TaskTypeGoal, nil, model.TaskTypeGoal},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := MCPListRequest{Limit: 1, Type: tc.kind, Parent: tc.parent}
			selection, err := SelectMCPList(project, actor, req)
			if err != nil {
				t.Fatal(err)
			}
			if selection.query.Type != tc.want || !model.EqualOptional(selection.query.Parent, tc.parent) {
				t.Fatalf("query = %+v", selection.query)
			}
			page := MCPListPage{fence: store.TaskListFence{Count: "1", VersionSum: "1"}}
			cursor, err := page.CursorAfter(selection, model.Task{ID: parent, ProjectID: project, CreatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)})
			if err != nil {
				t.Fatal(err)
			}
			req.Cursor = &cursor
			if _, err := SelectMCPList(project, actor, req); err != nil {
				t.Fatal(err)
			}
			for _, other := range []MCPListRequest{{Limit: 1, Type: model.TaskTypeGoal, Cursor: &cursor}, {Limit: 1, Parent: &none, Cursor: &cursor}, {Limit: 1, Parent: &parent, Cursor: &cursor}, {Limit: 1, Cursor: &cursor}} {
				kind, p, e := ResourceFilter(other.Type, other.Parent)
				if e == nil && (kind != selection.query.Type || !model.EqualOptional(p, selection.query.Parent)) {
					if _, err := SelectMCPList(project, actor, other); err == nil {
						t.Fatalf("cursor accepted different scope: %+v", other)
					}
				}
			}
		})
	}
	bad := "not-uuid"
	for _, req := range []MCPListRequest{{Limit: 1, Type: "invalid"}, {Limit: 1, Parent: &bad}, {Limit: 1, Type: model.TaskTypeGoal, Parent: &parent}} {
		if _, err := SelectMCPList(project, actor, req); err == nil {
			t.Fatalf("invalid selection accepted: %+v", req)
		}
	}
	for _, p := range []*string{nil, &none, &parent} {
		q, err := SelectMCPReady(MCPReadyRequest{Limit: 1, Parent: p})
		if err != nil || q.Type != model.TaskTypeTask || !model.EqualOptional(q.Parent, p) {
			t.Fatalf("ready = %+v error=%v", q, err)
		}
	}
	if _, err := SelectMCPReady(MCPReadyRequest{Limit: 1, Parent: &bad}); err == nil {
		t.Fatal("invalid ready parent accepted")
	}
}
