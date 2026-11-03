package store

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func seedStoreStep(t *testing.T, database *Store, taskID, id string, position int64) {
	t.Helper()
	mustQueryExec(t, database, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at)
 VALUES($1,$2,$3,'Coding','## Result','done','2026-11-03T10:11:12.123456Z','2026-11-03T11:12:13.654321Z')`, taskID, id, position)
}

func TestTaskStepsMigrationPreservesExistingTaskAndAddsConstraints(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:29]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, core.TaskInProgress)
	var before, after string
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(t)::text FROM tasks t WHERE id=$1`, task.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(t)::text FROM tasks t WHERE id=$1`, task.ID).Scan(&after); err != nil || before != after {
		t.Fatalf("existing task changed: %v", err)
	}
	seedStoreStep(t, database, task.ID, "00abcdef", 0)
	for _, sql := range []string{
		`INSERT INTO task_steps SELECT task_id,'00ABCDEF',1,title,description,status,created_at,updated_at FROM task_steps`,
		`INSERT INTO task_steps SELECT task_id,'00000001',-1,title,description,status,created_at,updated_at FROM task_steps`,
		`INSERT INTO task_steps SELECT task_id,'00000001',1,title,description,'review',created_at,updated_at FROM task_steps`,
		`INSERT INTO task_steps SELECT task_id,id,1,title,description,status,created_at,updated_at FROM task_steps`,
		`INSERT INTO task_steps SELECT task_id,'00000001',position,title,description,status,created_at,updated_at FROM task_steps`,
	} {
		if _, err := pool.Exec(ctx, sql); err == nil {
			t.Fatalf("constraint accepted: %s", sql)
		}
	}
	seedStoreStep(t, database, task.ID, "00000001", 1)
	// The unique position constraint is deferred so a single transaction can
	// exchange dense positions without a temporary sentinel.
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `UPDATE task_steps SET position=1-position WHERE task_id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestTaskStepsParentAndRowsShareSnapshot(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, core.TaskTodo)
	other := queryTask(t, database, project.ID, 11, core.TaskDone)
	seedStoreStep(t, database, task.ID, "00abcdef", 0)
	seedStoreStep(t, database, other.ID, "00abcdef", 0)
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		header, err := snapshot.TaskHeader(ctx, project.ID, task.ID)
		if err != nil || header.Version != task.Version || header.DeletedAt != nil {
			t.Fatalf("header: %+v %v", header, err)
		}
		mustQueryExec(t, database, `WITH changed AS (UPDATE tasks SET version=version+1 WHERE id=$1) UPDATE task_steps SET title='New state' WHERE task_id=$1`, task.ID)
		steps, err := snapshot.TaskSteps(ctx, task.ID)
		if err != nil || len(steps) != 1 || steps[0].Title != "Coding" || steps[0].CreatedAt.Location() != time.UTC || steps[0].CreatedAt.Nanosecond() != 123456000 {
			t.Fatalf("mixed snapshot: %+v %v", steps, err)
		}
		single, err := snapshot.TaskStep(ctx, task.ID, "00abcdef")
		if err != nil || !reflect.DeepEqual(single, steps[0]) {
			t.Fatalf("single: %+v %v", single, err)
		}
		empty, err := snapshot.TaskSteps(ctx, queryID(999))
		if err != nil || empty == nil || len(empty) != 0 {
			t.Fatalf("empty: %+v %v", empty, err)
		}
		if _, err := snapshot.TaskStep(ctx, task.ID, "00000000"); !errors.Is(err, core.ErrNotFound) {
			t.Fatalf("missing child: %v", err)
		}
		if _, err := snapshot.TaskHeader(ctx, queryID(999), task.ID); !errors.Is(err, core.ErrNotFound) {
			t.Fatalf("cross-project header: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `UPDATE tasks SET deleted_at='2026-11-03T11:12:13Z' WHERE id=$1`, task.ID)
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		header, err := snapshot.TaskHeader(ctx, project.ID, task.ID)
		if err != nil || header.Version != task.Version+1 || header.DeletedAt == nil || header.DeletedAt.Location() != time.UTC {
			t.Fatalf("updated header: %+v %v", header, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTaskStepsStorageErrorsPropagate(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, core.TaskTodo)
	seedStoreStep(t, database, task.ID, "00000000", 0)
	mustQueryExec(t, database, `UPDATE task_steps SET created_at='infinity' WHERE task_id=$1`, task.ID)
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		if _, err := snapshot.TaskSteps(ctx, task.ID); err == nil {
			t.Fatal("scan failure concealed")
		}
		if _, err := snapshot.TaskStep(ctx, task.ID, "00000000"); err == nil {
			t.Fatal("item scan failure concealed")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `DROP TABLE task_steps`)
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		_, err := snapshot.TaskSteps(ctx, task.ID)
		return err
	}); err == nil {
		t.Fatal("query failure concealed")
	}
	mustQueryExec(t, database, `ALTER TABLE tasks RENAME COLUMN version TO missing_version`)
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		_, err := snapshot.TaskHeader(ctx, project.ID, task.ID)
		return err
	}); err == nil {
		t.Fatal("parent query failure concealed")
	}
}
