package task

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type mcpListFixture struct {
	fence             store.TaskListFence
	query             store.TaskPriorityQuery
	page              store.TaskPriorityPage
	reads             int
	fenceErr, pageErr error
}

func (f *mcpListFixture) TaskListFence(context.Context, string) (store.TaskListFence, error) {
	return f.fence, f.fenceErr
}
func (f *mcpListFixture) TaskPriorityList(_ context.Context, _ string, q store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
	f.reads++
	f.query = q
	return f.page, f.pageErr
}

func TestMCPListReadFailuresAreNotPartialResults(t *testing.T) {
	project := "00000000-0000-4000-8000-000000000001"
	actor := "00000000-0000-4000-8000-000000000002"
	selection, err := SelectMCPList(project, actor, MCPListRequest{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	failure := errors.New("storage unavailable")
	for _, test := range []struct {
		name    string
		fixture mcpListFixture
		project string
		want    error
		reads   int
	}{
		{"wrong project", mcpListFixture{}, actor, nil, 0},
		{"fence failure", mcpListFixture{fenceErr: failure}, project, failure, 0},
		{"page failure", mcpListFixture{pageErr: failure}, project, failure, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			page, err := ReadMCPList(context.Background(), &test.fixture, test.project, selection)
			if err == nil || test.want != nil && !errors.Is(err, test.want) || len(page.Items) != 0 || test.fixture.reads != test.reads {
				t.Fatalf("page=%+v error=%v reads=%d", page, err, test.fixture.reads)
			}
		})
	}
}

func TestMCPListCursorGroupsAndMalformedFences(t *testing.T) {
	project := "00000000-0000-4000-8000-000000000001"
	actor := "00000000-0000-4000-8000-000000000002"
	selection, err := SelectMCPList(project, actor, MCPListRequest{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	page := MCPListPage{fence: store.TaskListFence{Count: "3", VersionSum: "4"}}
	task := model.Task{ID: "00000000-0000-4000-8000-000000000003", ProjectID: project, CreatedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	for _, test := range []struct {
		status model.TaskStatus
		ready  bool
		group  int
	}{
		{model.TaskInProgress, false, 0}, {model.TaskTodo, true, 1}, {model.TaskTodo, false, 2}, {model.TaskProposed, false, 3}, {model.TaskDone, false, 4}, {model.TaskCancelled, false, 4},
	} {
		task.Status, task.Ready = test.status, test.ready
		encoded, err := page.CursorAfter(selection, task)
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := SelectMCPList(project, actor, MCPListRequest{Limit: 1, Cursor: &encoded})
		if err != nil {
			t.Fatal(err)
		}
		if decoded.query.After.Group != test.group {
			t.Fatalf("%s group=%d", test.status, decoded.query.After.Group)
		}
	}
	legacyScope := selection.scope
	legacyScope.Version = 1
	legacy, err := json.Marshal(mcpListCursor{Scope: legacyScope, Fence: page.fence, Position: store.TaskPriorityPosition{Group: 3, CreatedAt: task.CreatedAt, ID: task.ID}})
	if err != nil {
		t.Fatal(err)
	}
	legacyCursor := base64.RawURLEncoding.EncodeToString(legacy)
	if _, err := SelectMCPList(project, actor, MCPListRequest{Limit: 1, Cursor: &legacyCursor}); err == nil {
		t.Fatal("old terminal cursor was interpreted as a proposed group")
	}
	for _, bad := range []string{"", "01", "-1", "12x"} {
		c := mcpListCursor{Scope: selection.scope, Fence: store.TaskListFence{Count: bad, VersionSum: "1"}, Position: store.TaskPriorityPosition{Group: 1, CreatedAt: task.CreatedAt, ID: task.ID}}
		raw, err := json.Marshal(c)
		if err != nil {
			t.Fatal(err)
		}
		encoded := base64.RawURLEncoding.EncodeToString(raw)
		if _, err = SelectMCPList(project, actor, MCPListRequest{Limit: 1, Cursor: &encoded}); err == nil {
			t.Fatalf("accepted malformed fence %q", bad)
		}
	}
	badTask := task
	badTask.ProjectID = actor
	if _, err := page.CursorAfter(selection, badTask); err == nil {
		t.Fatal("accepted foreign task")
	}
	badTask = task
	badTask.CreatedAt = time.Time{}
	if _, err := page.CursorAfter(selection, badTask); err == nil {
		t.Fatal("accepted missing task creation time")
	}
	badTask = task
	badTask.CreatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	if _, err := page.CursorAfter(selection, badTask); err == nil {
		t.Fatal("accepted non-encodable time")
	}
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
