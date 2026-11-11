package task_test

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

func TestTaskSyncDependencyStatesStore(t *testing.T) {
	suite := newTaskStoreSuite(t)
	suite.run(t, "SnapshotAndDelta", testSyncDependencyStatesSnapshotAndDelta)
	suite.run(t, "SameSnapshot", testSyncDependencyStatesSameSnapshot)
}

func testSyncDependencyStatesSnapshotAndDelta(t *testing.T, db *postgres.Store) {
	ctx := t.Context()
	project := readerProject(t, db, 1)
	other := readerProject(t, db, 2)
	goal := readerTask(t, db, project.ID, 10, model.TaskTodo)
	hiddenDone := readerTask(t, db, project.ID, 11, model.TaskDone)
	hiddenPending := readerTask(t, db, project.ID, 12, model.TaskTodo)
	owner := readerTask(t, db, project.ID, 13, model.TaskTodo, hiddenDone.ID, hiddenPending.ID)
	independent := readerTask(t, db, project.ID, 14, model.TaskTodo)
	missingOwner := readerTask(t, db, project.ID, 16, model.TaskDone)
	missingID := readerID(17)
	readerTask(t, db, other.ID, 15, model.TaskTodo)
	stamp := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	readerExec(t, db, `UPDATE tasks SET updated_at=$2 WHERE project_id=$1`, project.ID, stamp)
	readerExec(t, db, `UPDATE tasks SET type='goal',deleted_at=$2 WHERE id=$1`, goal.ID, stamp)
	readerExec(t, db, `UPDATE tasks SET parent_id=$1 WHERE id=ANY($2::uuid[])`, goal.ID, []string{hiddenDone.ID, hiddenPending.ID})
	readerExec(t, db, `UPDATE tasks SET version=9007199254740993 WHERE id=$1`, owner.ID)
	readerExec(t, db, `UPDATE task_dependencies SET external=true WHERE task_id=$1 AND depends_on_task_id=$2`, owner.ID, hiddenPending.ID)
	readerExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`, project.ID, missingOwner.ID, missingID)
	read := func(lower *time.Time) map[string]model.TaskDependencyState {
		t.Helper()
		var states map[string]model.TaskDependencyState
		if err := db.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
			var err error
			states, err = snapshot.TaskDAO().TaskSyncDependencyStates(ctx, project.ID, lower)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return states
	}
	states := read(nil)
	if len(states) != 3 || !reflect.DeepEqual(states[owner.ID], model.TaskDependencyState{TaskVersion: 9007199254740993, BlockedBy: []string{hiddenPending.ID}}) ||
		!reflect.DeepEqual(states[independent.ID], model.TaskDependencyState{TaskVersion: independent.Version, BlockedBy: []string{}, Ready: true}) ||
		!reflect.DeepEqual(states[missingOwner.ID], model.TaskDependencyState{TaskVersion: missingOwner.Version, BlockedBy: []string{missingID}}) {
		t.Fatalf("snapshot states: %#v", states)
	}
	window := stamp.Add(time.Microsecond)
	if states = read(&window); states == nil || len(states) != 0 {
		t.Fatalf("empty delta must be an empty map: %#v", states)
	}
	readerExec(t, db, `UPDATE tasks SET status='done',updated_at=$2 WHERE id=$1`, hiddenPending.ID, window)
	states = read(&window)
	if len(states) != 1 || !reflect.DeepEqual(states[owner.ID], model.TaskDependencyState{TaskVersion: 9007199254740993, BlockedBy: []string{}, Ready: true}) {
		t.Fatalf("hidden prerequisite change must patch unchanged owner: %#v", states)
	}
	strict := window.Add(time.Nanosecond)
	if states = read(&strict); len(states) != 0 {
		t.Fatalf("sub-microsecond lower bound selected older change: %#v", states)
	}
	readerExec(t, db, `UPDATE tasks SET updated_at=$2 WHERE id=$1`, independent.ID, strict.Add(time.Microsecond))
	if states = read(&strict); len(states) != 1 || !states[independent.ID].Ready {
		t.Fatalf("owner update must patch its own state: %#v", states)
	}
}

func testSyncDependencyStatesSameSnapshot(t *testing.T, db *postgres.Store) {
	ctx := t.Context()
	project := readerProject(t, db, 1)
	predecessor := readerTask(t, db, project.ID, 10, model.TaskTodo)
	owner := readerTask(t, db, project.ID, 11, model.TaskTodo, predecessor.ID)
	if err := db.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		dao := snapshot.TaskDAO()
		epoch, err := dao.TaskCacheEpoch(ctx, project.ID)
		if err != nil {
			return err
		}
		old, err := dao.TaskSyncDependencyStates(ctx, project.ID, nil)
		if err != nil {
			return err
		}
		oldTasks, err := dao.TaskSyncTasks(ctx, project.ID, nil, 160)
		if err != nil {
			return err
		}
		observed, err := snapshot.ObservedAt(ctx)
		if err != nil {
			return err
		}
		readerExec(t, db, `UPDATE tasks SET status='done',updated_at=clock_timestamp() WHERE id=$1`, predecessor.ID)
		readerExec(t, db, `UPDATE tasks SET title='new owner',version=version+1,updated_at=clock_timestamp() WHERE id=$1`, owner.ID)
		readerExec(t, db, `UPDATE projects SET task_cache_epoch=gen_random_uuid() WHERE id=$1`, project.ID)
		again, err := dao.TaskSyncDependencyStates(ctx, project.ID, nil)
		if err != nil {
			return err
		}
		againEpoch, err := dao.TaskCacheEpoch(ctx, project.ID)
		if err != nil {
			return err
		}
		againTasks, err := dao.TaskSyncTasks(ctx, project.ID, nil, 160)
		if err != nil {
			return err
		}
		againObserved, err := snapshot.ObservedAt(ctx)
		if err != nil {
			return err
		}
		if old[owner.ID].Ready || old[owner.ID].TaskVersion != owner.Version || len(oldTasks) != 2 || oldTasks[1].ID != owner.ID || oldTasks[1].Version != old[owner.ID].TaskVersion ||
			!reflect.DeepEqual(old, again) || !reflect.DeepEqual(oldTasks, againTasks) || epoch != againEpoch || observed.IsZero() || againObserved.Before(observed) {
			t.Fatalf("snapshot changed: states=%#v/%#v tasks=%#v/%#v epoch=%s/%s time=%s/%s", old, again, oldTasks, againTasks, epoch, againEpoch, observed, againObserved)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		dao := snapshot.TaskDAO()
		states, err := dao.TaskSyncDependencyStates(ctx, project.ID, nil)
		if err != nil {
			return err
		}
		tasks, err := dao.TaskSyncTasks(ctx, project.ID, nil, 160)
		if err == nil && (!states[owner.ID].Ready || states[owner.ID].TaskVersion != owner.Version+1 || len(tasks) != 2 || tasks[1].ID != owner.ID || tasks[1].Version != states[owner.ID].TaskVersion || tasks[1].TitlePreview != "new owner") {
			t.Fatalf("fresh snapshot missed update: states=%#v tasks=%#v", states, tasks)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTaskSyncDependencyStatesCancellation(t *testing.T) {
	db := readerStore(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	err := db.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
		_, err := snapshot.TaskDAO().TaskSyncDependencyStates(ctx, readerID(1), nil)
		return err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
}

func TestTaskSyncDependencyStatesFailures(t *testing.T) {
	for _, test := range []struct{ name, ddl string }{
		{"query", `DROP TABLE task_dependencies`},
		{"decode", `ALTER VIEW task_resource_rows RENAME TO resource_source;
			CREATE VIEW task_resource_rows AS SELECT id,project_id,type,status,'invalid'::text AS version,effective_deleted_at FROM resource_source`},
	} {
		t.Run(test.name, func(t *testing.T) {
			db := readerStore(t)
			project := readerProject(t, db, 1)
			readerTask(t, db, project.ID, 10, model.TaskTodo)
			readerExec(t, db, test.ddl)
			err := db.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
				_, err := snapshot.TaskDAO().TaskSyncDependencyStates(t.Context(), project.ID, nil)
				return err
			})
			if err == nil || errors.Is(err, model.ErrNotFound) || strings.Contains(err.Error(), "invalid") {
				t.Fatalf("dependency projection failure lost or exposed: %v", err)
			}
		})
	}
}
