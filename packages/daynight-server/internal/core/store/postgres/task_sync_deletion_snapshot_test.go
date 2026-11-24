package postgres

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestTaskSyncDeletionAcrossEpochAndRollback(t *testing.T) {
	parallelRootDatabaseTest(t)
	db, _, _, project := membershipFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	root := queryTask(t, db, project.ID, 10, model.TaskCancelled)
	child := queryTask(t, db, project.ID, 11, model.TaskCancelled)
	mustQueryExec(t, db, `UPDATE tasks SET parent_id=$2 WHERE id=$1`, child.ID, root.ID)
	var original string
	if err := db.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&original); err != nil {
		t.Fatal(err)
	}
	read := func(epoch string, since *time.Time) model.TaskSync {
		t.Helper()
		var result model.TaskSync
		err := db.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
			var fault *model.Fault
			var err error
			result, fault, err = taskcore.ReadSync(ctx, snapshot.TaskDAO(), snapshot.ObservedAt, project.ID, epoch, since, time.Second, model.TaskSync{})
			if fault != nil {
				t.Fatalf("sync fault: %v", fault)
			}
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	since := root.UpdatedAt.Add(-time.Second)
	cause := errors.New("rollback")
	err := writeProjectForTest(db, ctx, project.ID, func(scope store.ProjectWriteScope) error {
		if _, err := scope.TaskDAO().DeleteTask(ctx, root.ID, false); err != nil {
			return err
		}
		if err := scope.ProjectDAO().InvalidateTaskCache(ctx); err != nil {
			return err
		}
		return cause
	})
	if !errors.Is(err, cause) {
		t.Fatalf("rollback: %v", err)
	}
	rolledBack := read(original, &since)
	if rolledBack.Epoch != original || rolledBack.Mode != "delta" || len(rolledBack.DeletedTaskIDs) != 0 || len(rolledBack.Tasks) != 2 {
		t.Fatalf("rollback projection: %+v", rolledBack)
	}
	var deleted model.TaskTombstone
	err = writeProjectForTest(db, ctx, project.ID, func(scope store.ProjectWriteScope) error {
		var err error
		deleted, err = scope.TaskDAO().DeleteTask(ctx, root.ID, false)
		if err != nil {
			return err
		}
		return scope.ProjectDAO().InvalidateTaskCache(ctx)
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := read(original, &since)
	if snapshot.Epoch == original || snapshot.Mode != "snapshot" || len(snapshot.DeletedTaskIDs) != 0 || snapshot.CoverageUpdatedAt == nil || snapshot.CoverageUpdatedAt.Before(deleted.DeletedAt) {
		t.Fatalf("old epoch: %+v", snapshot)
	}
	delta := read(snapshot.Epoch, &since)
	want := []string{root.ID, child.ID}
	slices.Sort(want)
	if delta.Mode != "delta" || !slices.Equal(delta.DeletedTaskIDs, want) || delta.CoverageUpdatedAt == nil || delta.CoverageUpdatedAt.Before(deleted.DeletedAt) || len(delta.Tasks) != 0 {
		t.Fatalf("new epoch delta: %+v want=%v", delta, want)
	}
}
