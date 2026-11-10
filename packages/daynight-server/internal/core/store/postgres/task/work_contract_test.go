package task_test

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestTaskWorkStore(t *testing.T) {
	suite := newTaskStoreSuite(t)
	suite.run(t, "WorkComponentsIncludeDoneRootsAndExcludeExternalExpansion", testWorkComponentsIncludeDoneRootsAndExcludeExternalExpansion)
	suite.run(t, "WorkRootPreviewAndMultipleMatchingMembers", testWorkRootPreviewAndMultipleMatchingMembers)
	suite.run(t, "WorkTargetsContinueBeyondTwentyWithoutMissingOrDuplicateMembers", testWorkTargetsContinueBeyondTwentyWithoutMissingOrDuplicateMembers)
}

func testWorkComponentsIncludeDoneRootsAndExcludeExternalExpansion(t *testing.T, db *postgres.Store) {
	project := readerProject(t, db, 1)
	actor := readerAssigneeUser(t, db, project.ID, 2, true)
	other := readerAssigneeUser(t, db, project.ID, 3, true)
	root := readerTask(t, db, project.ID, 10, model.TaskDone)
	first := readerTask(t, db, project.ID, 11, model.TaskInProgress, root.ID)
	second := readerTask(t, db, project.ID, 12, model.TaskInProgress, root.ID)
	standalone := readerTask(t, db, project.ID, 20, model.TaskInProgress)
	external := readerTask(t, db, project.ID, 30, model.TaskInProgress)
	readerExec(t, db, "INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,true)", project.ID, first.ID, external.ID)
	readerExec(t, db, "UPDATE tasks SET assigned_to=$1,started_at=$2 WHERE id=ANY($3::uuid[])", actor, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), []string{first.ID, standalone.ID})
	readerExec(t, db, "UPDATE tasks SET assigned_to=$1,started_at=COALESCE(started_at,created_at) WHERE id=ANY($2::uuid[])", other, []string{second.ID, external.ID})
	err := db.ReadSnapshot(t.Context(), func(scope store.SnapshotScope) error {
		page, err := scope.TaskDAO().TaskWorkGroups(t.Context(), project.ID, store.TaskWorkQuery{AssignedTo: actor, Limit: 1})
		if err != nil {
			return err
		}
		if len(page.Items) != 1 || !page.HasMore {
			t.Fatalf("group page: %#v", page)
		}
		group := page.Items[0]
		if group.ID != root.ID || group.DisplayTaskID != root.ID || group.MemberCount != 3 || group.MatchedCount != 1 || group.InProgressCount != 2 || group.RootCount != 1 {
			t.Fatalf("ordinary group: %#v", group)
		}
		rest, err := scope.TaskDAO().TaskWorkGroups(t.Context(), project.ID, store.TaskWorkQuery{AssignedTo: actor, Limit: 1, After: &store.TaskWorkPosition{StartedAt: group.StartedAt, GroupID: group.ID}})
		if err != nil {
			return err
		}
		if len(rest.Items) != 1 || rest.Items[0].ID != standalone.ID || rest.HasMore {
			t.Fatalf("next groups: %#v", rest)
		}
		targets, err := scope.TaskDAO().TaskWorkTargets(t.Context(), project.ID, []string{group.ID}, nil, 1)
		if err != nil {
			return err
		}
		if len(targets.Items) != 1 || targets.Items[0].Task.ID != first.ID || !targets.HasMore {
			t.Fatalf("targets: %#v", targets)
		}
		next, err := scope.TaskDAO().TaskWorkTargets(t.Context(), project.ID, []string{group.ID}, &store.TaskWorkTargetPosition{GroupID: group.ID, TaskID: first.ID}, 1)
		if err != nil {
			return err
		}
		if len(next.Items) != 1 || next.Items[0].Task.ID != second.ID || next.HasMore {
			t.Fatalf("next targets: %#v", next)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func testWorkRootPreviewAndMultipleMatchingMembers(t *testing.T, db *postgres.Store) {
	project := readerProject(t, db, 1)
	actor := readerAssigneeUser(t, db, project.ID, 2, true)
	roots := make([]string, 7)
	for i := range roots {
		roots[i] = readerTask(t, db, project.ID, 10+i, model.TaskDone).ID
	}
	a := readerTask(t, db, project.ID, 30, model.TaskInProgress, roots...)
	b := readerTask(t, db, project.ID, 31, model.TaskInProgress, a.ID)
	readerExec(t, db, "UPDATE tasks SET assigned_to=$1,started_at=COALESCE(started_at,created_at) WHERE id=ANY($2::uuid[])", actor, []string{a.ID, b.ID})
	if err := db.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
		page, err := snapshot.TaskDAO().TaskWorkGroups(t.Context(), project.ID, store.TaskWorkQuery{AssignedTo: actor, Limit: 50})
		if err != nil {
			return err
		}
		if len(page.Items) != 1 || page.Items[0].RootCount != 7 || len(page.Items[0].Roots) != 5 || page.Items[0].MemberCount != 9 || page.Items[0].MatchedCount != 2 || page.Items[0].DisplayTaskID != roots[0] {
			t.Fatalf("root preview: %#v", page)
		}
		if _, err := snapshot.TaskDAO().TaskWorkTargets(t.Context(), project.ID, []string{roots[0]}, nil, 201); err == nil {
			t.Fatal("accepted 201 target batch")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func testWorkTargetsContinueBeyondTwentyWithoutMissingOrDuplicateMembers(t *testing.T, db *postgres.Store) {
	project := readerProject(t, db, 1)
	actor := readerAssigneeUser(t, db, project.ID, 2, true)
	root := readerTask(t, db, project.ID, 10, model.TaskDone)
	expected := make([]string, 0, 21)
	// Creation order deliberately opposes the Task-ID continuation order.
	for i := 20; i >= 0; i-- {
		expected = append(expected, readerTask(t, db, project.ID, 100+i, model.TaskInProgress, root.ID).ID)
	}
	slices.Sort(expected)
	readerExec(t, db, "UPDATE tasks SET assigned_to=$1,started_at=$2 WHERE id=ANY($3::uuid[])", actor, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), expected)
	var after store.TaskWorkTargetPosition
	var actual []string
	if err := db.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
		groups, err := snapshot.TaskDAO().TaskWorkGroups(t.Context(), project.ID, store.TaskWorkQuery{AssignedTo: actor, Limit: 20})
		if err != nil {
			return err
		}
		if len(groups.Items) != 1 || groups.HasMore || groups.Items[0].ID != root.ID || groups.Items[0].MemberCount != 22 || groups.Items[0].MatchedCount != 21 || groups.Items[0].InProgressCount != 21 {
			t.Fatalf("group: %#v", groups)
		}
		page, err := snapshot.TaskDAO().TaskWorkTargets(t.Context(), project.ID, []string{root.ID}, nil, 20)
		if err != nil {
			return err
		}
		if len(page.Items) != 20 || !page.HasMore {
			t.Fatalf("first target page: %#v", page)
		}
		for _, item := range page.Items {
			if item.GroupID != root.ID || item.Task.AssignedTo == nil || *item.Task.AssignedTo != actor {
				t.Fatalf("target left its group or owner: %#v", item)
			}
			actual = append(actual, item.Task.ID)
		}
		last := page.Items[len(page.Items)-1]
		after = store.TaskWorkTargetPosition{GroupID: last.GroupID, TaskID: last.Task.ID}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
		page, err := snapshot.TaskDAO().TaskWorkTargets(t.Context(), project.ID, []string{root.ID}, &after, 20)
		if err != nil {
			return err
		}
		if len(page.Items) != 1 || page.HasMore || page.Items[0].Task.ID <= after.TaskID {
			t.Fatalf("continued target page: %#v", page)
		}
		actual = append(actual, page.Items[0].Task.ID)
		after.TaskID = page.Items[0].Task.ID
		end, err := snapshot.TaskDAO().TaskWorkTargets(t.Context(), project.ID, []string{root.ID}, &after, 20)
		if err != nil {
			return err
		}
		if len(end.Items) != 0 || end.HasMore {
			t.Fatalf("completed target scan continued: %#v", end)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(actual, expected) {
		t.Fatalf("target traversal omitted or duplicated members: got=%v want=%v", actual, expected)
	}
}
