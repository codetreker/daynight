package task_test

import (
	"slices"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskdao "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
)

func TestResourceVisibilityStore(t *testing.T) {
	suite := newTaskStoreSuite(t)
	suite.run(t, "WorkSyncAndAssigneesExcludeHiddenChildren", testWorkSyncAndAssigneesExcludeHiddenChildren)
	suite.run(t, "RetainedDependenciesUsePhysicalOrdinaryRows", testRetainedDependenciesUsePhysicalOrdinaryRows)
}

func testWorkSyncAndAssigneesExcludeHiddenChildren(t *testing.T, db *postgres.Store) {
	project := readerProject(t, db, 1)
	actor := readerAssigneeUser(t, db, project.ID, 2, true)
	former := readerAssigneeUser(t, db, project.ID, 3, true)
	goal := readerTask(t, db, project.ID, 10, model.TaskTodo)
	liveGoal := readerTask(t, db, project.ID, 13, model.TaskInProgress)
	hidden := readerTask(t, db, project.ID, 11, model.TaskInProgress)
	visible := readerTask(t, db, project.ID, 12, model.TaskInProgress, hidden.ID)
	readerExec(t, db, `UPDATE tasks SET type='goal',deleted_at=now() WHERE id=$1`, goal.ID)
	readerExec(t, db, `UPDATE tasks SET type='goal',assigned_to=$2,started_at=now() WHERE id=$1`, liveGoal.ID, actor)
	readerExec(t, db, `UPDATE tasks SET parent_id=$2,assigned_to=$3,started_at=now() WHERE id=$1`, hidden.ID, goal.ID, former)
	readerExec(t, db, `UPDATE tasks SET assigned_to=$2,started_at=now() WHERE id=$1`, visible.ID, actor)
	readerExec(t, db, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, former)
	if err := db.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
		dao := snapshot.TaskDAO()
		groups, err := dao.TaskWorkGroups(t.Context(), project.ID, store.TaskWorkQuery{AssignedTo: actor, Limit: 1})
		if err != nil {
			return err
		}
		if len(groups.Items) != 1 || groups.Items[0].ID != visible.ID || groups.Items[0].MemberCount != 1 || groups.HasMore {
			t.Fatalf("work includes hidden member: %+v", groups)
		}
		targets, err := dao.TaskWorkTargets(t.Context(), project.ID, []string{visible.ID, hidden.ID, liveGoal.ID}, nil, 20)
		if err != nil {
			return err
		}
		if len(targets.Items) != 1 || targets.Items[0].Task.ID != visible.ID {
			t.Fatalf("work targets: %+v", targets)
		}
		rows, err := dao.TaskSyncTasks(t.Context(), project.ID, nil, 160)
		if err != nil {
			return err
		}
		if len(rows) != 2 || !slices.ContainsFunc(rows, func(row model.TaskViewRecord) bool { return row.ID == visible.ID }) || !slices.ContainsFunc(rows, func(row model.TaskViewRecord) bool { return row.ID == liveGoal.ID }) {
			t.Fatalf("sync rows: %+v", rows)
		}
		people, err := dao.ResolveTaskAssignees(t.Context(), project.ID, []string{former})
		if err != nil {
			return err
		}
		if len(people) != 1 || people[0].Qualified {
			t.Fatalf("hidden assignee qualified: %+v", people)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	people, err := readerAssigneeRead(t, db, project.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if slices.ContainsFunc(people, func(f model.TaskAssigneeFact) bool { return f.UserID == former }) {
		t.Fatalf("hidden assignee in catalogue: %+v", people)
	}
}

func testRetainedDependenciesUsePhysicalOrdinaryRows(t *testing.T, db *postgres.Store) {
	f := newFixtureWithStore(t, db)
	ctx := t.Context()
	writer := taskdao.NewWriter(f.tx, f.project)
	goal := mustTask(t, writer, store.TaskWrite{Title: "goal"})
	prerequisite := mustTask(t, writer, store.TaskWrite{Title: "hidden prerequisite", Status: model.TaskDone})
	middle := mustTask(t, writer, store.TaskWrite{Title: "hidden dependent", Status: model.TaskInProgress, DependsOn: []string{prerequisite.ID}})
	last := mustTask(t, writer, store.TaskWrite{Title: "visible dependent", DependsOn: []string{middle.ID}})
	liveGoal := mustTask(t, writer, store.TaskWrite{Title: "live goal"})
	_, err := f.tx.Exec(ctx, `UPDATE tasks SET type='goal' WHERE id=$1`, liveGoal.ID)
	mustOK(t, err)
	_, err = f.tx.Exec(ctx, `UPDATE tasks SET type='goal',deleted_at=statement_timestamp() WHERE id=$1`, goal.ID)
	mustOK(t, err)
	_, err = f.tx.Exec(ctx, `UPDATE tasks SET parent_id=$1 WHERE id=ANY($2::uuid[])`, goal.ID, []string{prerequisite.ID, middle.ID})
	mustOK(t, err)
	visible, err := writer.VisibleTaskIDs(ctx, []string{liveGoal.ID, prerequisite.ID, middle.ID, last.ID})
	mustOK(t, err)
	if len(visible) != 1 || visible[0] != last.ID {
		t.Fatalf("visible dependency targets: %v", visible)
	}
	facts, err := writer.TasksByID(ctx, []string{liveGoal.ID, prerequisite.ID, middle.ID})
	mustOK(t, err)
	if len(facts) != 2 || !slices.Contains(taskIDs(facts), prerequisite.ID) || !slices.Contains(taskIDs(facts), middle.ID) {
		t.Fatalf("retained facts: %+v", facts)
	}
	dependents, err := writer.ActiveDependentIDs(ctx, prerequisite.ID)
	mustOK(t, err)
	if len(dependents) != 1 || dependents[0] != middle.ID {
		t.Fatalf("hidden dependent lost: %v", dependents)
	}
	reachable, err := writer.Reachable(ctx, last.ID, prerequisite.ID, store.DependencyReplacement{TaskID: last.ID, DependsOn: []string{middle.ID}})
	mustOK(t, err)
	if !reachable {
		t.Fatal("path through hidden task lost")
	}
	current, err := writer.Task(ctx, last.ID)
	mustOK(t, err)
	if current.Ready || !slices.Equal(current.BlockedBy, []string{middle.ID}) {
		t.Fatalf("hidden unfinished prerequisite did not block: %+v", current)
	}
	_, err = f.tx.Exec(ctx, `UPDATE tasks SET status='done' WHERE id=$1`, middle.ID)
	mustOK(t, err)
	current, err = writer.Task(ctx, last.ID)
	mustOK(t, err)
	if !current.Ready || len(current.BlockedBy) != 0 {
		t.Fatalf("hidden completed prerequisite did not satisfy: %+v", current)
	}
}
