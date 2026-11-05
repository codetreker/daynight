package store

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	task := queryTask(t, database, project.ID, 10, model.TaskInProgress)
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
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	other := queryTask(t, database, project.ID, 11, model.TaskDone)
	seedStoreStep(t, database, task.ID, "00abcdef", 0)
	seedStoreStep(t, database, other.ID, "00abcdef", 0)
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		header, err := snapshot.TaskDAO().TaskHeader(ctx, project.ID, task.ID)
		if err != nil || header.Version != task.Version || header.DeletedAt != nil {
			t.Fatalf("header: %+v %v", header, err)
		}
		mustQueryExec(t, database, `WITH changed AS (UPDATE tasks SET version=version+1 WHERE id=$1) UPDATE task_steps SET title='New state' WHERE task_id=$1`, task.ID)
		steps, err := snapshot.TaskDAO().TaskSteps(ctx, task.ID)
		if err != nil || len(steps) != 1 || steps[0].Title != "Coding" || steps[0].CreatedAt.Location() != time.UTC || steps[0].CreatedAt.Nanosecond() != 123456000 {
			t.Fatalf("mixed snapshot: %+v %v", steps, err)
		}
		single, err := snapshot.TaskDAO().TaskStep(ctx, task.ID, "00abcdef")
		if err != nil || !reflect.DeepEqual(single, steps[0]) {
			t.Fatalf("single: %+v %v", single, err)
		}
		empty, err := snapshot.TaskDAO().TaskSteps(ctx, queryID(999))
		if err != nil || empty == nil || len(empty) != 0 {
			t.Fatalf("empty: %+v %v", empty, err)
		}
		if _, err := snapshot.TaskDAO().TaskStep(ctx, task.ID, "00000000"); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing child: %v", err)
		}
		if _, err := snapshot.TaskDAO().TaskHeader(ctx, queryID(999), task.ID); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("cross-project header: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `UPDATE tasks SET deleted_at='2026-11-03T11:12:13Z' WHERE id=$1`, task.ID)
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		header, err := snapshot.TaskDAO().TaskHeader(ctx, project.ID, task.ID)
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
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	seedStoreStep(t, database, task.ID, "00000000", 0)
	mustQueryExec(t, database, `UPDATE task_steps SET created_at='infinity' WHERE task_id=$1`, task.ID)
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		if _, err := snapshot.TaskDAO().TaskSteps(ctx, task.ID); err == nil {
			t.Fatal("scan failure concealed")
		}
		if _, err := snapshot.TaskDAO().TaskStep(ctx, task.ID, "00000000"); err == nil {
			t.Fatal("item scan failure concealed")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `DROP TABLE task_steps`)
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		_, err := snapshot.TaskDAO().TaskSteps(ctx, task.ID)
		return err
	}); err == nil {
		t.Fatal("query failure concealed")
	}
	mustQueryExec(t, database, `ALTER TABLE tasks RENAME COLUMN version TO missing_version`)
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		_, err := snapshot.TaskDAO().TaskHeader(ctx, project.ID, task.ID)
		return err
	}); err == nil {
		t.Fatal("parent query failure concealed")
	}
}

func TestTaskStepsCommitLostReceiptKeepsUnknownAndCurrentFacts(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	transaction, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	lost := errors.New("private lost commit receipt")
	err = transact(ctx, &threadCommitResponseLoss{Tx: transaction, cause: lost}, func(raw pgx.Tx) error {
		tx := &ProjectTx{tx: raw, projectID: project.ID}
		if _, err := raw.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project.ID); err != nil {
			return err
		}
		header, err := tx.TaskHeader(ctx, task.ID)
		if err != nil {
			return err
		}
		stamp, err := tx.ObservedAt(ctx)
		if err != nil {
			return err
		}
		if err := tx.InsertTaskStep(ctx, task.ID, model.TaskStep{ID: "abcdef01", Position: 0, Title: "Committed once", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp}); err != nil {
			return err
		}
		if header.Version != task.Version {
			t.Fatal("wrong locked version")
		}
		return tx.TouchTask(ctx, task.ID, stamp)
	})
	var failure *TransactionError
	if !errors.As(err, &failure) || failure.Outcome != TransactionUnknown || failure.Phase != "commit" || !failure.CommitAttempted || failure.CleanupFailed || !errors.Is(err, lost) {
		t.Fatalf("lost receipt classification: %+v %v", failure, err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		header, err := snapshot.TaskDAO().TaskHeader(ctx, project.ID, task.ID)
		if err != nil {
			return err
		}
		rows, err := snapshot.TaskDAO().TaskSteps(ctx, task.ID)
		if err != nil {
			return err
		}
		if header.Version != task.Version+1 || len(rows) != 1 || rows[0].ID != "abcdef01" {
			t.Fatal("current read facts do not reflect applied commit")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTaskStepsDeferredPositionFailureIsInternalAndRollsBack(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	seedStoreStep(t, database, task.ID, "00000000", 0)
	err := database.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
		stamp, err := tx.ObservedAt(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.tx.Exec(ctx, `INSERT INTO task_steps SELECT task_id,'abcdef01',position,title,description,status,created_at,updated_at FROM task_steps WHERE task_id=$1`, task.ID); err != nil {
			return err
		}
		return tx.TouchTask(ctx, task.ID, stamp)
	})
	var failure *TransactionError
	var cause *pgconn.PgError
	if !errors.As(err, &failure) || failure.Phase != "commit" || failure.Outcome != TransactionUnknown || !errors.As(err, &cause) || cause.Code != "23505" {
		t.Fatalf("deferred constraint cause changed: %+v %v", failure, err)
	}
	var version int64
	var count int
	if err := database.Pool.QueryRow(ctx, `SELECT version,(SELECT count(*) FROM task_steps WHERE task_id=$1) FROM tasks WHERE id=$1`, task.ID).Scan(&version, &count); err != nil || version != task.Version || count != 1 {
		t.Fatal("deferred violation partially committed")
	}
}

func TestTaskStepsWriteStoreFailureChainsAndRollback(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	seedStoreStep(t, database, task.ID, "00000000", 0)
	before := ""
	state := func() string {
		t.Helper()
		var result string
		if err := database.Pool.QueryRow(ctx, `SELECT jsonb_build_object('task',to_jsonb(t),'steps',(SELECT jsonb_agg(to_jsonb(s) ORDER BY position) FROM task_steps s WHERE task_id=t.id))::text FROM tasks t WHERE id=$1`, task.ID).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before = state()
	for _, operation := range []string{"shift", "insert", "touch", "missing"} {
		t.Run(operation, func(t *testing.T) {
			err := database.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
				if _, err := tx.TaskHeader(ctx, task.ID); err != nil {
					return err
				}
				rows, err := tx.TaskSteps(ctx, task.ID)
				if err != nil {
					return err
				}
				if len(rows) != 1 || rows[0].ID != "00000000" {
					t.Fatal("wrong locked collection")
				}
				stamp, err := tx.ObservedAt(ctx)
				if err != nil {
					return err
				}
				switch operation {
				case "shift":
					if _, err := tx.tx.Exec(ctx, `ALTER TABLE task_steps RENAME COLUMN position TO invalid_position`); err != nil {
						return err
					}
					return tx.InsertTaskStep(ctx, task.ID, model.TaskStep{ID: "abcdef01", Position: 0, Title: "x", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp})
				case "insert":
					return tx.InsertTaskStep(ctx, task.ID, model.TaskStep{ID: "00000000", Position: 0, Title: "x", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp})
				case "touch":
					if _, err := tx.tx.Exec(ctx, `ALTER TABLE tasks RENAME COLUMN updated_at TO invalid_updated_at`); err != nil {
						return err
					}
					return tx.TouchTask(ctx, task.ID, stamp)
				default:
					return tx.TouchTask(ctx, queryID(999), stamp)
				}
			})
			var transaction *TransactionError
			if !errors.As(err, &transaction) || transaction.CommitAttempted || transaction.Outcome != TransactionNotCommitted {
				t.Fatalf("store refusal completion: %+v %v", transaction, err)
			}
			if operation == "missing" {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatal("missing touch marker lost")
				}
			} else {
				var cause *pgconn.PgError
				if !errors.As(err, &cause) {
					t.Fatal("driver cause lost")
				}
			}
			if after := state(); after != before {
				t.Fatal("store failure left partial rows or parent changes")
			}
		})
	}
}
