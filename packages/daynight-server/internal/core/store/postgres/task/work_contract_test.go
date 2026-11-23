package task_test

import (
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

func TestTaskWorkStore(t *testing.T) {
	suite := newTaskStoreSuite(t)
	suite.run(t, "WorkComponentsIncludeDoneRootsAndExcludeExternalExpansion", testWorkComponentsIncludeDoneRootsAndExcludeExternalExpansion)
	suite.run(t, "WorkRootPreviewAndMultipleMatchingMembers", testWorkRootPreviewAndMultipleMatchingMembers)
	suite.run(t, "WorkTargetsReadFixedKeysAcrossSnapshots", testWorkTargetsReadFixedKeysAcrossSnapshots)
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
	if err := db.ReadSnapshot(t.Context(), func(scope store.SnapshotScope) error {
		dao := scope.TaskDAO()
		page, err := dao.TaskWorkGroups(t.Context(), project.ID, store.TaskWorkQuery{AssignedTo: actor, Limit: 1})
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
		expected := []store.TaskWorkTargetPosition{{GroupID: root.ID, TaskID: first.ID}, {GroupID: root.ID, TaskID: second.ID}}
		if !slices.Equal(page.Targets, expected) {
			t.Fatalf("selected page keys include lookahead or omit other owner: %v", page.Targets)
		}
		rest, err := dao.TaskWorkGroups(t.Context(), project.ID, store.TaskWorkQuery{AssignedTo: actor, Limit: 1, After: &store.TaskWorkPosition{StartedAt: group.StartedAt, GroupID: group.ID}})
		if err != nil {
			return err
		}
		if len(rest.Items) != 1 || rest.Items[0].ID != standalone.ID || rest.HasMore || !slices.Equal(rest.Targets, []store.TaskWorkTargetPosition{{GroupID: standalone.ID, TaskID: standalone.ID}}) {
			t.Fatalf("next groups: %#v", rest)
		}
		for _, key := range page.Targets {
			targets, err := dao.TaskWorkTargets(t.Context(), project.ID, []store.TaskWorkTargetPosition{key})
			if err != nil {
				return err
			}
			if len(targets.Items) != 1 || targets.Items[0].Task.ID != key.TaskID || targets.Items[0].GroupID != key.GroupID {
				t.Fatalf("targets: %#v", targets)
			}
		}
		selected, err := dao.TaskWorkGroups(t.Context(), project.ID, store.TaskWorkQuery{AssignedTo: other, Limit: 50, GroupID: &root.ID})
		if err != nil {
			return err
		}
		if len(selected.Items) != 1 || selected.Items[0].MatchedCount != 1 || !slices.Equal(selected.Targets, expected) {
			t.Fatalf("explicit owner and group: %#v", selected)
		}
		invalid, err := dao.TaskWorkGroups(t.Context(), project.ID, store.TaskWorkQuery{AssignedTo: actor, Limit: 50, GroupID: &first.ID})
		if err != nil {
			return err
		}
		if len(invalid.Items) != 0 || len(invalid.Targets) != 0 {
			t.Fatalf("nonminimal group accepted: %#v", invalid)
		}
		absent, err := dao.TaskWorkGroups(t.Context(), project.ID, store.TaskWorkQuery{AssignedTo: actor, Limit: 50, GroupID: &external.ID})
		if err != nil {
			return err
		}
		if len(absent.Items) != 0 {
			t.Fatalf("group without matching seed: %#v", absent)
		}
		empty, err := dao.TaskWorkGroups(t.Context(), project.ID, store.TaskWorkQuery{AssignedTo: project.ID, Limit: 50})
		if err != nil {
			return err
		}
		if len(empty.Items) != 0 || len(empty.Targets) != 0 || empty.HasMore {
			t.Fatalf("zero seeds: %#v", empty)
		}
		return nil
	}); err != nil {
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
		if len(page.Items) != 1 || page.Items[0].RootCount != 7 || len(page.Items[0].Roots) != 5 || page.Items[0].MemberCount != 9 || page.Items[0].MatchedCount != 2 || page.Items[0].DisplayTaskID != roots[0] || len(page.Targets) != 2 {
			t.Fatalf("root preview: %#v", page)
		}
		if _, err := snapshot.TaskDAO().TaskWorkTargets(t.Context(), project.ID, make([]store.TaskWorkTargetPosition, 201)); err == nil {
			t.Fatal("accepted 201 target batch")
		}
		if _, err := snapshot.TaskDAO().TaskWorkTargets(t.Context(), project.ID, nil); err == nil {
			t.Fatal("accepted empty target batch")
		}
		if _, err := snapshot.TaskDAO().TaskWorkTargets(t.Context(), project.ID, []store.TaskWorkTargetPosition{page.Targets[0], page.Targets[0]}); err == nil {
			t.Fatal("accepted duplicate target keys")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func testWorkTargetsReadFixedKeysAcrossSnapshots(t *testing.T, db *postgres.Store) {
	project := readerProject(t, db, 1)
	actor := readerAssigneeUser(t, db, project.ID, 2, true)
	var expected []store.TaskWorkTargetPosition
	// Opposing creation order makes ordering assertions independent of insertion.
	for groupIndex := 0; groupIndex < 2; groupIndex++ {
		root := readerTask(t, db, project.ID, 10+groupIndex, model.TaskDone)
		for i := 204; i >= 0; i-- {
			id := readerTask(t, db, project.ID, 100+groupIndex*300+i, model.TaskInProgress, root.ID).ID
			expected = append(expected, store.TaskWorkTargetPosition{GroupID: root.ID, TaskID: id})
		}
	}
	slices.SortFunc(expected, func(a, b store.TaskWorkTargetPosition) int {
		if a.GroupID < b.GroupID {
			return -1
		}
		if a.GroupID > b.GroupID {
			return 1
		}
		if a.TaskID < b.TaskID {
			return -1
		}
		if a.TaskID > b.TaskID {
			return 1
		}
		return 0
	})
	ids := make([]string, len(expected))
	for i, key := range expected {
		ids[i] = key.TaskID
	}
	readerExec(t, db, "UPDATE tasks SET assigned_to=$1,started_at=$2 WHERE id=ANY($3::uuid[])", actor, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), ids)
	var keys []store.TaskWorkTargetPosition
	if err := db.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
		groups, err := snapshot.TaskDAO().TaskWorkGroups(t.Context(), project.ID, store.TaskWorkQuery{AssignedTo: actor, Limit: 20})
		if err != nil {
			return err
		}
		if len(groups.Items) != 2 || groups.HasMore || !slices.Equal(groups.Targets, expected) {
			t.Fatalf("all selected keys: %#v", groups)
		}
		keys = groups.Targets
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// Exact-key reads do not recompute membership after the first snapshot.
	readerExec(t, db, "DELETE FROM task_dependencies WHERE project_id=$1", project.ID)
	var actual []store.TaskWorkTargetPosition
	for start := 0; start < len(keys); start += 200 {
		batch := keys[start:min(start+200, len(keys))]
		if err := db.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
			targets, err := snapshot.TaskDAO().TaskWorkTargets(t.Context(), project.ID, batch)
			if err != nil {
				return err
			}
			if len(targets.Items) != len(batch) {
				return fmt.Errorf("batch returned %d tasks for %d keys", len(targets.Items), len(batch))
			}
			for _, item := range targets.Items {
				if item.Task.AssignedTo == nil || *item.Task.AssignedTo != actor {
					t.Fatalf("target owner: %#v", item)
				}
				actual = append(actual, store.TaskWorkTargetPosition{GroupID: item.GroupID, TaskID: item.Task.ID})
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	if !slices.Equal(actual, expected) {
		t.Fatalf("target keys omitted or duplicated: got=%v want=%v", actual, expected)
	}
	readerExec(t, db, "UPDATE tasks SET status='done' WHERE id=$1", keys[0].TaskID)
	if err := db.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
		if _, err := snapshot.TaskDAO().TaskWorkTargets(t.Context(), project.ID, keys[:1]); err == nil {
			t.Fatal("accepted missing ongoing target")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
