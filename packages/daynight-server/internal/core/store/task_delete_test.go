package store

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func TestTaskSoftDeleteMigrationPreservesHistory(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:16]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status,version,properties)
		VALUES($1,$2,'Historic','Opaque description','done',9007199254740993,'{"pullRequests":[],"worker":null}')`, queryID(11), project.ID)
	var before, after string
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(t)::text FROM tasks t`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := migrate(ctx, pool, schemaMigrations); err != nil {
			t.Fatal(err)
		}
		var marker bool
		if err := pool.QueryRow(ctx, `SELECT (to_jsonb(t)-'deleted_at')::text,deleted_at IS NULL FROM tasks t`).Scan(&after, &marker); err != nil || before != after || !marker {
			t.Fatalf("migration changed existing task facts: %s %s %v", before, after, err)
		}
	}
	if task := snapshotTask(t, database, project.ID, queryID(11)); task.Version != 9007199254740993 || task.Status != core.TaskDone {
		t.Fatal("existing task no longer decodes")
	}
}

func TestTaskDeleteAndDependentLookupFailuresPreserveCauses(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	pre := queryTask(t, database, project.ID, 11, core.TaskDone)
	dependent := queryTask(t, database, project.ID, 12, core.TaskTodo, pre.ID)
	var expired *ProjectTx
	if err := database.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
		expired = tx
		ids, err := tx.DependentIDs(ctx, pre.ID)
		if err != nil || !reflect.DeepEqual(ids, []string{dependent.ID}) {
			t.Fatalf("direct dependent lookup: %v %v", ids, err)
		}
		if err := tx.DeleteTask(ctx, queryID(99)); !errors.Is(err, core.ErrNotFound) {
			t.Fatalf("missing delete swallowed: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
		if err := tx.DeleteTask(ctx, dependent.ID); err != nil {
			return err
		}
		ids, err := tx.DependentIDs(ctx, pre.ID)
		if err != nil || len(ids) != 0 {
			t.Fatalf("deleted sources retained as live dependents: %v %v", ids, err)
		}
		return tx.DeleteTask(ctx, pre.ID)
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		_, err := snapshot.Task(ctx, project.ID, pre.ID)
		if !errors.Is(err, core.ErrTaskDeleted) {
			t.Fatalf("deleted marker was not observed: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []func() error{
		func() error { _, err := expired.DependentIDs(ctx, pre.ID); return err },
		func() error { return expired.DeleteTask(ctx, pre.ID) },
	} {
		err := operation()
		var failure *Error
		if !errors.As(err, &failure) || errors.Is(err, core.ErrNotFound) {
			t.Fatalf("closed transaction lost database cause: %v", err)
		}
	}
}
