package postgres

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestTaskPriorityListFiltersBeforeLimitAndFence(t *testing.T) {
	db := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, db, 1)
	done := queryTask(t, db, project.ID, 10, model.TaskDone)
	ready := queryTask(t, db, project.ID, 12, model.TaskTodo)
	blocked := queryTask(t, db, project.ID, 11, model.TaskTodo, ready.ID)
	active := queryTask(t, db, project.ID, 13, model.TaskInProgress)
	deleted := queryTask(t, db, project.ID, 14, model.TaskDone)
	mustQueryExec(t, db, `UPDATE tasks SET title=$2 WHERE id=$1`, blocked.ID, strings.Repeat("界", 600))
	mustQueryExec(t, db, `UPDATE tasks SET deleted_at=now(),version=version+1 WHERE id=$1`, deleted.ID)
	read := func(q TaskPriorityQuery) (TaskPriorityPage, TaskListFence) {
		t.Helper()
		var page TaskPriorityPage
		var fence TaskListFence
		err := db.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			var err error
			fence, err = snapshot.TaskDAO().TaskListFence(ctx, project.ID)
			if err != nil {
				return err
			}
			page, err = snapshot.TaskDAO().TaskPriorityList(ctx, project.ID, q)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return page, fence
	}
	first, fence := read(TaskPriorityQuery{Limit: 2})
	if fence.Count != "5" || fence.VersionSum != "6" {
		t.Fatalf("fence did not include deleted row: %+v", fence)
	}
	ids := func(page TaskPriorityPage) []string {
		out := []string{}
		for _, task := range page.Items {
			out = append(out, task.Task.ID)
		}
		return out
	}
	if !first.HasMore || !reflect.DeepEqual(ids(first), []string{active.ID, ready.ID}) {
		t.Fatalf("first page: %+v", first)
	}
	last := first.Items[1]
	second, _ := read(TaskPriorityQuery{Limit: 2, After: &TaskPriorityPosition{Group: 1, CreatedAt: last.Task.CreatedAt, ID: last.Task.ID}})
	if second.HasMore || !reflect.DeepEqual(ids(second), []string{blocked.ID, done.ID}) {
		t.Fatalf("second page: %+v", second)
	}
	summary := second.Items[0]
	if !summary.TitleTruncated || summary.BlockedByCount != 1 || len([]rune(summary.Task.Title)) != 513 || summary.Task.Description != "" || len(summary.Task.BlockedBy) != 0 || len(summary.Task.Properties) != 0 {
		t.Fatalf("summary was not bounded or lost metadata: %+v", summary)
	}
	readyOnly := true
	filtered, _ := read(TaskPriorityQuery{Limit: 1, Ready: &readyOnly})
	if filtered.HasMore || !reflect.DeepEqual(ids(filtered), []string{ready.ID}) {
		t.Fatalf("filtered page: %+v", filtered)
	}
	withoutDone, _ := read(TaskPriorityQuery{Limit: 10, ExcludeDone: true})
	if !reflect.DeepEqual(ids(withoutDone), []string{active.ID, ready.ID, blocked.ID}) {
		t.Fatalf("exclude done: %+v", withoutDone)
	}
	actor := queryID(25)
	mustQueryExec(t, db, `UPDATE tasks SET assigned_to=$2,allow_agents=true,required_platform='linux' WHERE id=$1`, ready.ID, actor)
	mustQueryExec(t, db, `UPDATE tasks SET created_at='2026-01-01T00:00:00Z' WHERE id=ANY($1::uuid[])`, []string{ready.ID, blocked.ID})
	todo := model.TaskTodo
	linux := model.PlatformLinux
	yes := true
	assigned, _ := read(TaskPriorityQuery{Limit: 1, Status: &todo, Ready: &yes, AllowAgents: &yes, CompatiblePlatform: &linux, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: actor}})
	if assigned.HasMore || !reflect.DeepEqual(ids(assigned), []string{ready.ID}) {
		t.Fatalf("combined filters: %+v", assigned)
	}
	unassigned, _ := read(TaskPriorityQuery{Limit: 10, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUnassigned}})
	if !reflect.DeepEqual(ids(unassigned), []string{active.ID, blocked.ID, done.ID}) {
		t.Fatalf("unassigned: %+v", unassigned)
	}
	other := model.PlatformWindows
	incompatible, _ := read(TaskPriorityQuery{Limit: 10, CompatiblePlatform: &other})
	if !reflect.DeepEqual(ids(incompatible), []string{active.ID, blocked.ID, done.ID}) {
		t.Fatalf("platform: %+v", incompatible)
	}
	updated := readFence(t, db, project.ID)
	if updated != fence {
		t.Fatalf("unexpected fence change: %+v", updated)
	}
	mustQueryExec(t, db, `UPDATE tasks SET version=version+1 WHERE id=$1`, deleted.ID)
	if readFence(t, db, project.ID) == fence {
		t.Fatal("deleted task version did not change fence")
	}
	ready2 := queryTask(t, db, project.ID, 15, model.TaskTodo)
	mustQueryExec(t, db, `UPDATE tasks SET created_at='2026-01-01T00:00:00Z' WHERE id=ANY($1::uuid[])`, []string{ready.ID, ready2.ID})
	tied, _ := read(TaskPriorityQuery{Limit: 1, Ready: &readyOnly})
	if !tied.HasMore || !reflect.DeepEqual(ids(tied), []string{ready.ID}) {
		t.Fatalf("UUID tie order: %+v", tied)
	}
	tieLast := tied.Items[0].Task
	tieNext, _ := read(TaskPriorityQuery{Limit: 1, Ready: &readyOnly, After: &TaskPriorityPosition{Group: 1, CreatedAt: tieLast.CreatedAt, ID: tieLast.ID}})
	if tieNext.HasMore || !reflect.DeepEqual(ids(tieNext), []string{ready2.ID}) {
		t.Fatalf("UUID tie continuation: %+v", tieNext)
	}
}

func TestTaskPriorityCursorSnapshotAndPredecessorChange(t *testing.T) {
	db := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, db, 1)
	predecessor := queryTask(t, db, project.ID, 10, model.TaskTodo)
	dependent := queryTask(t, db, project.ID, 11, model.TaskTodo, predecessor.ID)
	dependent2 := queryTask(t, db, project.ID, 12, model.TaskTodo, predecessor.ID)
	actor := queryID(50)
	for _, view := range []string{"summary", "full"} {
		var cursor *string
		var got []string
		for {
			selection, err := taskcore.SelectMCPList(project.ID, actor, taskcore.MCPListRequest{Limit: 1, Cursor: cursor, View: view})
			if err != nil {
				t.Fatal(err)
			}
			var page taskcore.MCPListPage
			err = db.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
				var err error
				page, err = taskcore.ReadMCPList(ctx, snapshot.TaskDAO(), project.ID, selection)
				return err
			})
			if err != nil {
				t.Fatal(err)
			}
			for _, item := range page.Items {
				got = append(got, item.Task.ID)
			}
			if !page.HasMore {
				break
			}
			next, err := page.CursorAfter(selection, page.Items[len(page.Items)-1].Task)
			if err != nil {
				t.Fatal(err)
			}
			cursor = &next
		}
		if !reflect.DeepEqual(got, []string{predecessor.ID, dependent.ID, dependent2.ID}) {
			t.Fatalf("%s traversal: %v", view, got)
		}
	}
	blocked := false
	selection, err := taskcore.SelectMCPList(project.ID, actor, taskcore.MCPListRequest{Limit: 1, Ready: &blocked})
	if err != nil {
		t.Fatal(err)
	}
	var first taskcore.MCPListPage
	err = db.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		var err error
		first, err = taskcore.ReadMCPList(ctx, snapshot.TaskDAO(), project.ID, selection)
		if err != nil {
			return err
		}
		// Update the filtered-out predecessor after the snapshot is fixed; a second read must retain the old fence and ordering.
		mustQueryExec(t, db, `UPDATE tasks SET status='done',version=version+1 WHERE id=$1`, predecessor.ID)
		repeated, err := taskcore.ReadMCPList(ctx, snapshot.TaskDAO(), project.ID, selection)
		if err != nil {
			return err
		}
		if repeated.Items[0].Task.ID != dependent.ID {
			t.Fatalf("snapshot changed: %+v", repeated)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	cursor, err := first.CursorAfter(selection, first.Items[0].Task)
	if err != nil {
		t.Fatal(err)
	}
	next, err := taskcore.SelectMCPList(project.ID, actor, taskcore.MCPListRequest{Limit: 1, Cursor: &cursor, Ready: &blocked})
	if err != nil {
		t.Fatal(err)
	}
	err = db.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		_, err := taskcore.ReadMCPList(ctx, snapshot.TaskDAO(), project.ID, next)
		return err
	})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "list_changed" {
		t.Fatalf("predecessor change accepted: %v", err)
	}
}

func readFence(t *testing.T, db *Store, project string) TaskListFence {
	t.Helper()
	var fence TaskListFence
	err := db.ReadSnapshot(context.Background(), func(snapshot SnapshotScope) error {
		var err error
		fence, err = snapshot.TaskDAO().TaskListFence(context.Background(), project)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return fence
}

func TestTaskPriorityListRejectsInvalidDAOInputs(t *testing.T) {
	db := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, db, 1)
	queries := []TaskPriorityQuery{
		{Limit: 0}, {Limit: 101},
		{Limit: 1, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentAll, UserID: queryID(9)}},
		{Limit: 1, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUnassigned, UserID: queryID(9)}},
		{Limit: 1, AssignedTo: model.TaskAssignmentFilter{Mode: "invalid"}},
	}
	err := db.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		for _, q := range queries {
			page, err := snapshot.TaskDAO().TaskPriorityList(ctx, project.ID, q)
			if err == nil || len(page.Items) != 0 {
				t.Fatalf("accepted invalid query %+v: %+v %v", q, page, err)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestTaskPriorityListStorageFailures(t *testing.T) {
	for _, test := range []struct {
		name, ddl string
		fence     bool
	}{
		{"fence query", `DROP TABLE tasks`, true},
		{"list query", `DROP TABLE task_dependencies`, false},
		{"invalid status", `ALTER TABLE tasks DROP CONSTRAINT tasks_status_check; UPDATE tasks SET status='invalid'`, false},
		{"decode", `ALTER TABLE tasks RENAME TO task_source; CREATE VIEW tasks AS SELECT id,project_id,title,status,'bad version'::text AS version,created_at,allow_agents,required_platform,assigned_to,deleted_at FROM task_source`, false},
		{"iteration", `CREATE FUNCTION fail_priority_title() RETURNS text LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1003', MESSAGE='private list failure'; END $$;
			ALTER TABLE tasks RENAME TO task_source; CREATE VIEW tasks AS SELECT id,project_id,fail_priority_title() AS title,status,version,created_at,allow_agents,required_platform,assigned_to,deleted_at FROM task_source`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			db := isolatedStore(t)
			ctx := context.Background()
			project := queryProject(t, db, 1)
			queryTask(t, db, project.ID, 11, model.TaskTodo)
			mustQueryExec(t, db, test.ddl)
			err := db.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
				if test.fence {
					_, err := snapshot.TaskDAO().TaskListFence(ctx, project.ID)
					return err
				}
				_, err := snapshot.TaskDAO().TaskPriorityList(ctx, project.ID, TaskPriorityQuery{Limit: 1})
				return err
			})
			if err == nil || errors.Is(err, model.ErrNotFound) || strings.Contains(err.Error(), "private list failure") {
				t.Fatalf("query failure was lost or leaked: %v", err)
			}
		})
	}
}
