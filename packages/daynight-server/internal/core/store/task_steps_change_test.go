package store

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTaskStepsChangeStoreUpdatesOneExistingTarget(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, model.TaskDone)
	seedStoreStep(t, database, task.ID, "00000000", 0)
	seedStoreStep(t, database, task.ID, "abcdef01", 1)
	var before []model.TaskStep
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		var err error
		before, err = snapshot.TaskDAO().TaskSteps(ctx, task.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	stamp := time.Date(2026, 11, 4, 3, 4, 5, 654321000, time.UTC)
	target := before[0]
	target.Title, target.Description, target.Status, target.UpdatedAt = "  Paired title  ", "# Paired body\n", model.TaskStepSkipped, stamp
	if err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error { return tx.TaskDAO().UpdateTaskStep(ctx, task.ID, target) }); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		after, err := snapshot.TaskDAO().TaskSteps(ctx, task.ID)
		if err != nil {
			return err
		}
		if len(after) != 2 || after[0] != target || after[1] != before[1] {
			t.Fatal("narrow update changed identity, order, createdAt or other rows")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTaskStepsChangeStoreFailuresKeepCausesAndRollback(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	seedStoreStep(t, database, task.ID, "00000000", 0)
	state := func() string {
		t.Helper()
		var result string
		if err := database.Pool.QueryRow(ctx, `SELECT jsonb_build_object('task',to_jsonb(t),'steps',(SELECT jsonb_agg(to_jsonb(s) ORDER BY position) FROM task_steps s WHERE task_id=t.id))::text FROM tasks t WHERE id=$1`, task.ID).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := state()
	for _, mode := range []string{"missing", "query", "constraint"} {
		t.Run(mode, func(t *testing.T) {
			err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
				rows, err := tx.TaskDAO().TaskSteps(ctx, task.ID)
				if err != nil {
					return err
				}
				target := rows[0]
				target.Title, target.Description = "new title", "new description"
				switch mode {
				case "missing":
					target.ID = "ffffffff"
				case "query":
					if _, err := tx.(*ProjectTx).tx.Exec(ctx, `ALTER TABLE task_steps RENAME COLUMN description TO missing_description`); err != nil {
						return err
					}
				case "constraint":
					target.Status = "invalid"
				}
				return tx.TaskDAO().UpdateTaskStep(ctx, task.ID, target)
			})
			var transaction *TransactionError
			if !errors.As(err, &transaction) || transaction.CommitAttempted || transaction.CleanupFailed || transaction.Outcome != TransactionNotCommitted {
				t.Fatalf("failure completion: %+v %v", transaction, err)
			}
			if mode == "missing" {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatal("missing row cause lost")
				}
			} else {
				var cause *pgconn.PgError
				if !errors.As(err, &cause) {
					t.Fatal("driver cause lost")
				}
				if mode == "constraint" && cause.Code != "23514" {
					t.Fatal(cause.Code)
				}
			}
			if after := state(); !reflect.DeepEqual(before, after) {
				t.Fatal("failure partially saved paired fields")
			}
		})
	}
}
