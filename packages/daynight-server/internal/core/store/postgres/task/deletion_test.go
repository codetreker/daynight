package task_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskdao "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
)

func TestSubtreeDeletionStore(t *testing.T) {
	suite := newTaskStoreSuite(t)
	suite.run(t, "OrdinaryRoot", func(t *testing.T, db *postgres.Store) { testSubtreeDeletion(t, db, false) })
	suite.run(t, "GoalRoot", func(t *testing.T, db *postgres.Store) { testSubtreeDeletion(t, db, true) })
	suite.run(t, "Rollback", testSubtreeDeletionRollback)
	suite.run(t, "ResourceFirst", testSubtreeDeletionResourceFirst)
	suite.run(t, "DeletionFirst", testSubtreeDeletionFirst)
}

func testSubtreeDeletion(t *testing.T, db *postgres.Store, goal bool) {
	project := readerProject(t, db, 1)
	root := readerTask(t, db, project.ID, 20, model.TaskCancelled)
	if goal {
		readerExec(t, db, `UPDATE tasks SET type='goal' WHERE id=$1`, root.ID)
	}
	tree := []model.Task{root}
	for i := 1; i <= 5; i++ {
		child := readerTask(t, db, project.ID, 20+i, model.TaskCancelled)
		readerExec(t, db, `UPDATE tasks SET parent_id=$2 WHERE id=$1`, child.ID, tree[i-1].ID)
		tree = append(tree, child)
	}
	// An explicitly detached source can also be one of the hidden descendants.
	var source model.Task
	if !goal {
		readerExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,external) VALUES($1,$2,$3,'task',false)`, project.ID, tree[3].ID, root.ID)
		source = readerTask(t, db, project.ID, 10, model.TaskCancelled, root.ID)
	}
	hidden := readerTask(t, db, project.ID, 30, model.TaskCancelled)
	pruned := readerTask(t, db, project.ID, 31, model.TaskCancelled)
	old := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	readerExec(t, db, `UPDATE tasks SET parent_id=$2,ancestor_deleted_at=$3 WHERE id=$1`, hidden.ID, root.ID, old)
	readerExec(t, db, `UPDATE tasks SET parent_id=$2,ancestor_deleted_at=$3 WHERE id=$1`, pruned.ID, hidden.ID, old)
	physical := readerTask(t, db, project.ID, 32, model.TaskCancelled)
	readerExec(t, db, `UPDATE tasks SET parent_id=$2,deleted_at=$3 WHERE id=$1`, physical.ID, root.ID, old)
	var tombstone model.TaskTombstone
	err := readerWriteProject(db, t.Context(), project.ID, func(scope store.ProjectWriteScope) error {
		var err error
		tombstone, err = scope.TaskDAO().DeleteTask(t.Context(), root.ID, !goal)
		return err
	})
	mustOK(t, err)
	for i, before := range tree {
		var version int64
		var updated time.Time
		var deleted, inherited *time.Time
		var status model.TaskStatus
		var parent *string
		mustOK(t, db.Pool.QueryRow(t.Context(), `SELECT version,updated_at,deleted_at,ancestor_deleted_at,status,parent_id::text FROM tasks WHERE id=$1`, before.ID).
			Scan(&version, &updated, &deleted, &inherited, &status, &parent))
		wantVersion := before.Version
		if i == 0 || (i == 3 && !goal) {
			wantVersion++
		}
		if version != wantVersion || status != before.Status || (i != 0 && (parent == nil || *parent != tree[i-1].ID)) {
			t.Fatalf("subtree row %d changed business facts: version=%d status=%s parent=%v", i, version, status, parent)
		}
		if i == 0 {
			if deleted == nil || !deleted.Equal(tombstone.DeletedAt) || inherited != nil {
				t.Fatalf("root tombstone: deleted=%v inherited=%v", deleted, inherited)
			}
		} else if deleted != nil || inherited == nil || !inherited.Equal(tombstone.DeletedAt) || ((i != 3 || goal) && !updated.Equal(before.UpdatedAt)) {
			t.Fatalf("descendant %d: deleted=%v inherited=%v updated=%v", i, deleted, inherited, updated)
		}
	}
	for _, id := range []string{hidden.ID, pruned.ID} {
		var inherited time.Time
		mustOK(t, db.Pool.QueryRow(t.Context(), `SELECT ancestor_deleted_at FROM tasks WHERE id=$1`, id).Scan(&inherited))
		if !inherited.Equal(old) {
			t.Fatalf("already hidden branch %s overwritten: %v", id, inherited)
		}
	}
	var inherited *time.Time
	mustOK(t, db.Pool.QueryRow(t.Context(), `SELECT ancestor_deleted_at FROM tasks WHERE id=$1`, physical.ID).Scan(&inherited))
	if inherited != nil {
		t.Fatalf("physically deleted branch marked: %v", inherited)
	}
	if !goal {
		var sourceVersion, references int64
		mustOK(t, db.Pool.QueryRow(t.Context(), `SELECT version FROM tasks WHERE id=$1`, source.ID).Scan(&sourceVersion))
		mustOK(t, db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM task_dependencies WHERE project_id=$1 AND depends_on_task_id=$2`, project.ID, root.ID).Scan(&references))
		if sourceVersion != source.Version+1 || references != 0 {
			t.Fatalf("explicit detach: version=%d references=%d", sourceVersion, references)
		}
	}
	mustOK(t, db.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
		for _, row := range tree {
			if _, err := snapshot.TaskDAO().Task(t.Context(), project.ID, row.ID); !errors.Is(err, model.ErrTaskDeleted) {
				return fmt.Errorf("hidden row %s readable: %w", row.ID, err)
			}
		}
		return nil
	}))
}

func testSubtreeDeletionRollback(t *testing.T, db *postgres.Store) {
	project := readerProject(t, db, 1)
	root := readerTask(t, db, project.ID, 20, model.TaskCancelled)
	child := readerTask(t, db, project.ID, 10, model.TaskCancelled, root.ID)
	readerExec(t, db, `UPDATE tasks SET parent_id=$2 WHERE id=$1`, child.ID, root.ID)
	var epoch string
	mustOK(t, db.Pool.QueryRow(t.Context(), `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch))
	cause := errors.New("failure after subtree and epoch writes")
	err := readerWriteProject(db, t.Context(), project.ID, func(scope store.ProjectWriteScope) error {
		if _, err := scope.TaskDAO().DeleteTask(t.Context(), root.ID, true); err != nil {
			return err
		}
		if err := scope.ProjectDAO().InvalidateTaskCache(t.Context()); err != nil {
			return err
		}
		return cause
	})
	if !errors.Is(err, cause) {
		t.Fatalf("lost injected failure: %v", err)
	}
	for _, row := range []model.Task{root, child} {
		var version int64
		var updated time.Time
		var deleted, inherited *time.Time
		mustOK(t, db.Pool.QueryRow(t.Context(), `SELECT version,updated_at,deleted_at,ancestor_deleted_at FROM tasks WHERE id=$1`, row.ID).Scan(&version, &updated, &deleted, &inherited))
		if version != row.Version || !updated.Equal(row.UpdatedAt) || deleted != nil || inherited != nil {
			t.Fatalf("rollback changed %s: version=%d updated=%v deleted=%v inherited=%v", row.ID, version, updated, deleted, inherited)
		}
	}
	var after string
	var references int
	mustOK(t, db.Pool.QueryRow(t.Context(), `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&after))
	mustOK(t, db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM task_dependencies WHERE task_id=$1 AND depends_on_task_id=$2`, child.ID, root.ID).Scan(&references))
	if after != epoch || references != 1 {
		t.Fatalf("rollback lost epoch or dependency: epoch=%s/%s refs=%d", epoch, after, references)
	}
}

func testSubtreeDeletionResourceFirst(t *testing.T, db *postgres.Store) {
	project := readerProject(t, db, 1)
	root := readerTask(t, db, project.ID, 20, model.TaskCancelled)
	child := readerTask(t, db, project.ID, 10, model.TaskCancelled)
	source := readerTask(t, db, project.ID, 5, model.TaskCancelled, root.ID)
	readerExec(t, db, `UPDATE tasks SET parent_id=$2 WHERE id=$1`, child.ID, root.ID)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	resource, err := db.Pool.Begin(ctx)
	mustOK(t, err)
	defer resource.Rollback(context.Background())
	_, err = taskdao.NewWriter(resource, project.ID).TaskHeader(ctx, source.ID)
	mustOK(t, err)
	done := make(chan error, 1)
	go func() {
		done <- readerWriteProject(db, ctx, project.ID, func(scope store.ProjectWriteScope) error {
			_, err := scope.TaskDAO().DeleteTask(ctx, root.ID, true)
			return err
		})
	}()
	testutil.WaitForQueryLock(t, db.Pool, "WITH RECURSIVE subtree")
	// Waiting on the smaller reference source must not have locked the subtree.
	_, err = resource.Exec(ctx, `SELECT id FROM tasks WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT`, []string{child.ID, root.ID})
	mustOK(t, err)
	_, err = resource.Exec(ctx, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,'00000001',0,'before deletion','','todo',now(),now())`, child.ID)
	mustOK(t, err)
	mustOK(t, resource.Commit(ctx))
	mustOK(t, testutil.ReceiveQueryResult(t, ctx, done))
	var rows int
	mustOK(t, db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_steps WHERE task_id=$1`, child.ID).Scan(&rows))
	if rows != 1 {
		t.Fatal("resource committed before deletion was lost")
	}
}

func testSubtreeDeletionFirst(t *testing.T, db *postgres.Store) {
	project := readerProject(t, db, 1)
	root := readerTask(t, db, project.ID, 20, model.TaskCancelled)
	child := readerTask(t, db, project.ID, 10, model.TaskCancelled)
	readerExec(t, db, `UPDATE tasks SET parent_id=$2 WHERE id=$1`, child.ID, root.ID)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	deleted := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- readerWriteProject(db, ctx, project.ID, func(scope store.ProjectWriteScope) error {
			if _, err := scope.TaskDAO().DeleteTask(ctx, root.ID, false); err != nil {
				return err
			}
			close(deleted)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
	}()
	select {
	case <-deleted:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	resource, err := db.Pool.Begin(ctx)
	mustOK(t, err)
	defer resource.Rollback(context.Background())
	result := make(chan error, 1)
	go func() {
		header, err := taskdao.NewWriter(resource, project.ID).TaskHeader(ctx, child.ID)
		if err == nil && header.DeletedAt == nil {
			err = errors.New("resource lock admitted hidden descendant")
		}
		result <- err
	}()
	testutil.WaitThreadBackendLock(t, db.Pool, resource.Conn().PgConn().PID())
	close(release)
	mustOK(t, testutil.ReceiveQueryResult(t, ctx, done))
	mustOK(t, testutil.ReceiveQueryResult(t, ctx, result))
}
