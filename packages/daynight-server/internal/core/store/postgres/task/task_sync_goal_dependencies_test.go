package task_test

import (
	"context"
	"errors"
	"io"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
)

func TestTaskSyncGoalDependsOnStore(t *testing.T) {
	suite := newTaskStoreSuite(t)
	suite.run(t, "SelectedLiveGoalEndpoints", testSyncGoalDependsOnEndpoints)
	suite.run(t, "SummaryWindowAndSnapshot", testSyncGoalDependsOnSnapshot)
	suite.run(t, "Cancellation", testSyncGoalDependsOnCancellation)
}

func testSyncGoalDependsOnEndpoints(t *testing.T, db *postgres.Store) {
	project := readerProject(t, db, 1)
	other := readerProject(t, db, 2)
	ids := make([]string, 10)
	for index := range ids {
		ids[index] = readerTask(t, db, project.ID, 10+index, model.TaskTodo).ID
	}
	foreign := readerTask(t, db, other.ID, 30, model.TaskTodo)
	readerExec(t, db, `UPDATE tasks SET type='goal' WHERE id=ANY($1::uuid[])`, append(slices.Clone(ids[:9]), foreign.ID))
	readerExec(t, db, `UPDATE tasks SET status='done' WHERE id=$1`, ids[1])
	readerExec(t, db, `UPDATE tasks SET status='cancelled',cancelled_at=now() WHERE id=$1`, ids[2])
	readerExec(t, db, `UPDATE tasks SET deleted_at=now() WHERE id=ANY($1::uuid[])`, []string{ids[4], ids[6]})
	for _, target := range []string{ids[1], ids[2], ids[4], ids[9], foreign.ID, readerID(99)} {
		insertGoalEdge(t, db, project.ID, ids[0], target, false)
	}
	// An ordinary edge between Goals must not become an acceptance edge.
	readerExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`, project.ID, ids[0], ids[3])
	insertGoalEdge(t, db, project.ID, ids[6], ids[1], false)
	insertGoalEdge(t, db, project.ID, ids[9], ids[1], false)
	insertGoalEdge(t, db, other.ID, foreign.ID, ids[1], false)
	selected := []string{ids[0], ids[0], ids[5], ids[6], ids[9], foreign.ID, readerID(98)}
	want := map[string][]string{ids[0]: {ids[1], ids[2]}, ids[5]: {}}
	if err := db.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
		got, err := snapshot.TaskDAO().TaskSyncGoalDependsOn(t.Context(), project.ID, selected)
		if err == nil && !reflect.DeepEqual(got, want) {
			t.Fatalf("selected Goal prerequisites = %#v; want %#v", got, want)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	readerExec(t, db, `UPDATE projects SET deleted_at=now() WHERE id=$1`, project.ID)
	if err := db.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
		got, err := snapshot.TaskDAO().TaskSyncGoalDependsOn(t.Context(), project.ID, selected)
		if err == nil && (got == nil || len(got) != 0) {
			t.Fatalf("deleted Project exposed Goal prerequisites: %#v", got)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func testSyncGoalDependsOnSnapshot(t *testing.T, db *postgres.Store) {
	ctx := t.Context()
	project := readerProject(t, db, 1)
	first := readerTask(t, db, project.ID, 10, model.TaskTodo)
	second := readerTask(t, db, project.ID, 11, model.TaskDone)
	owner := readerTask(t, db, project.ID, 12, model.TaskTodo)
	readerTask(t, db, project.ID, 13, model.TaskTodo)
	readerExec(t, db, `UPDATE tasks SET type='goal' WHERE id=ANY($1::uuid[])`, []string{first.ID, second.ID, owner.ID})
	insertGoalEdge(t, db, project.ID, owner.ID, first.ID, false)
	stamp := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	boundary := stamp.Add(time.Microsecond)
	readerExec(t, db, `UPDATE tasks SET updated_at=$2 WHERE project_id=$1`, project.ID, stamp)
	readerExec(t, db, `UPDATE tasks SET updated_at=$2 WHERE id=$1`, owner.ID, boundary)
	read := func(snapshot store.SnapshotScope, lower *time.Time) (map[string][]string, error) {
		rows, err := snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, lower, 160)
		if err != nil {
			return nil, err
		}
		selected := []string{}
		for _, row := range rows {
			if row.Type == model.TaskTypeGoal {
				selected = append(selected, row.ID)
			}
		}
		return snapshot.TaskDAO().TaskSyncGoalDependsOn(ctx, project.ID, selected)
	}
	if err := db.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		initial, err := read(snapshot, nil)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(initial, map[string][]string{first.ID: {}, second.ID: {}, owner.ID: {first.ID}}) {
			t.Fatalf("full summary selection: %#v", initial)
		}
		before, err := read(snapshot, &boundary)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(before, map[string][]string{owner.ID: {first.ID}}) {
			t.Fatalf("delta summary selection: %#v", before)
		}
		readerExec(t, db, `UPDATE task_dependencies SET depends_on_task_id=$2 WHERE project_id=$1 AND task_id=$3`, project.ID, second.ID, owner.ID)
		readerExec(t, db, `UPDATE tasks SET version=version+1,updated_at=$2 WHERE id=$1`, owner.ID, boundary.Add(time.Microsecond))
		again, err := read(snapshot, &boundary)
		if err == nil && !reflect.DeepEqual(again, before) {
			t.Fatalf("summary and Goal prerequisites crossed snapshots: %#v / %#v", before, again)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		got, err := read(snapshot, &boundary)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(got, map[string][]string{owner.ID: {second.ID}}) {
			t.Fatalf("fresh snapshot missed edge replacement: %#v", got)
		}
		future := boundary.Add(time.Second)
		empty, err := read(snapshot, &future)
		if err == nil && (empty == nil || len(empty) != 0) {
			t.Fatalf("empty delta: %#v", empty)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	readerExec(t, db, `DELETE FROM task_dependencies WHERE project_id=$1 AND task_id=$2`, project.ID, owner.ID)
	if err := db.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		got, err := read(snapshot, &boundary)
		if err == nil && !reflect.DeepEqual(got, map[string][]string{owner.ID: {}}) {
			t.Fatalf("last edge removal must return an explicit empty slice: %#v", got)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func testSyncGoalDependsOnCancellation(t *testing.T, db *postgres.Store) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	err := db.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
		got, err := snapshot.TaskDAO().TaskSyncGoalDependsOn(ctx, readerID(1), []string{readerID(2)})
		if got != nil {
			t.Fatalf("canceled query returned results: %#v", got)
		}
		return err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation chain: %v", err)
	}
}

func TestTaskSyncGoalDependsOnEmptySelection(t *testing.T) {
	got, err := task.NewReader(nil).TaskSyncGoalDependsOn(t.Context(), readerID(1), nil)
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("empty selection must not query: %#v, %v", got, err)
	}
}

func TestTaskSyncGoalDependsOnFailuresDiscardPartialResults(t *testing.T) {
	f := newFixture(t)
	goal := mustTask(t, task.NewWriter(f.tx, f.project), store.TaskWrite{Type: model.TaskTypeGoal, Title: "Goal"})
	for _, scanFailure := range []bool{false, true} {
		got, err := task.NewReader(&interruptedTx{Tx: f.tx, target: 1, scanFailure: scanFailure}).TaskSyncGoalDependsOn(t.Context(), f.project, []string{goal.ID})
		if got != nil || !errors.Is(err, io.ErrUnexpectedEOF) {
			t.Fatalf("stream failure returned partial data or lost cause: %#v, %v", got, err)
		}
	}
	_, err := f.tx.Exec(t.Context(), `DROP TABLE task_dependencies`)
	mustOK(t, err)
	got, err := task.NewReader(f.tx).TaskSyncGoalDependsOn(t.Context(), f.project, []string{goal.ID})
	if got != nil || err == nil || errors.Is(err, model.ErrNotFound) {
		t.Fatalf("query failure returned partial data or became not-found: %#v, %v", got, err)
	}
}
