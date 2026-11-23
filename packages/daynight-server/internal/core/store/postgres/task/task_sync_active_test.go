package task_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

func TestTaskSyncActiveTasksStore(t *testing.T) {
	suite := newTaskStoreSuite(t)
	suite.run(t, "VisibilityPrecisionAndSnapshot", testTaskSyncActiveTasksSnapshot)
	suite.run(t, "UnboundedInventory", testTaskSyncActiveTasksUnbounded)
	suite.run(t, "Cancellation", testTaskSyncActiveTasksCancellation)
}

func testTaskSyncActiveTasksSnapshot(t *testing.T, db *postgres.Store) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	project := readerProject(t, db, 1)
	other := readerProject(t, db, 2)
	active := readerTask(t, db, project.ID, 10, model.TaskInProgress)
	readerTask(t, db, project.ID, 11, model.TaskTodo)
	goal := readerTask(t, db, project.ID, 12, model.TaskInProgress)
	deletedGoal := readerTask(t, db, project.ID, 13, model.TaskTodo)
	hiddenChild := readerTask(t, db, project.ID, 14, model.TaskInProgress)
	deleted := readerTask(t, db, project.ID, 15, model.TaskInProgress)
	readerTask(t, db, other.ID, 16, model.TaskInProgress)
	readerExec(t, db, `UPDATE tasks SET type='goal' WHERE id=$1`, goal.ID)
	readerExec(t, db, `UPDATE tasks SET type='goal',deleted_at=now() WHERE id=$1`, deletedGoal.ID)
	readerExec(t, db, `UPDATE tasks SET parent_id=$2,ancestor_deleted_at=(SELECT deleted_at FROM tasks WHERE id=$2) WHERE id=$1`, hiddenChild.ID, deletedGoal.ID)
	readerExec(t, db, `UPDATE tasks SET deleted_at=now() WHERE id=$1`, deleted.ID)
	readerExec(t, db, `UPDATE tasks SET version=9007199254740993 WHERE id=$1`, active.ID)

	before := []store.TaskSyncTaskIdentity{{ID: active.ID, Version: 9007199254740993}}
	if err := db.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		first, err := snapshot.TaskDAO().TaskSyncActiveTasks(ctx, project.ID)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(first, before) {
			t.Fatalf("initial active inventory: %#v", first)
		}
		readerExec(t, db, `UPDATE tasks SET version=version+1,status='done' WHERE id=$1`, active.ID)
		again, err := snapshot.TaskDAO().TaskSyncActiveTasks(ctx, project.ID)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(again, before) {
			t.Fatalf("inventory changed within snapshot: %#v", again)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		actual, err := snapshot.TaskDAO().TaskSyncActiveTasks(ctx, project.ID)
		if err != nil {
			return err
		}
		if actual == nil || len(actual) != 0 {
			t.Fatalf("new snapshot did not observe completion: %#v", actual)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func testTaskSyncActiveTasksUnbounded(t *testing.T, db *postgres.Store) {
	project := readerProject(t, db, 1)
	readerExec(t, db, `INSERT INTO tasks(id,project_id,title,status)
		SELECT md5('sync-active-' || n)::uuid,$1,'batch task','in_progress' FROM generate_series(1,201) AS n`, project.ID)
	if err := db.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
		actual, err := snapshot.TaskDAO().TaskSyncActiveTasks(t.Context(), project.ID)
		if err != nil {
			return err
		}
		if len(actual) != 201 {
			t.Fatalf("inventory truncated: %d", len(actual))
		}
		for i, task := range actual {
			if task.Version != 1 || task.ID == "" || i > 0 && actual[i-1].ID >= task.ID {
				t.Fatalf("invalid inventory at %d: %#v", i, task)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func testTaskSyncActiveTasksCancellation(t *testing.T, db *postgres.Store) {
	project := readerProject(t, db, 1)
	if err := db.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		actual, err := snapshot.TaskDAO().TaskSyncActiveTasks(ctx, project.ID)
		if !errors.Is(err, context.Canceled) || actual != nil {
			t.Fatalf("cancelled inventory: %#v, %v", actual, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
