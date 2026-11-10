package postgres

import (
	"context"
	"errors"
	"testing"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTaskStepsMoveStoreFailuresPreserveCausesAndRollback(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	for index, id := range []string{"00000000", "11111111", "abcdef01", "fedcba98"} {
		seedStoreStep(t, database, task.ID, id, int64(index))
	}
	state := func() string {
		t.Helper()
		var result string
		if err := database.Pool.QueryRow(ctx, `SELECT jsonb_build_object('task',to_jsonb(t),'steps',(SELECT jsonb_agg(to_jsonb(s) ORDER BY position) FROM task_steps s WHERE task_id=t.id))::text FROM tasks t WHERE id=$1`, task.ID).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := state()
	for _, mode := range []string{"query", "count", "constraint"} {
		t.Run(mode, func(t *testing.T) {
			err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
				switch mode {
				case "query":
					if _, err := tx.(*ProjectTx).tx.Exec(ctx, `ALTER TABLE task_steps RENAME COLUMN position TO invalid_position`); err != nil {
						return err
					}
					return tx.TaskDAO().MoveTaskStep(ctx, task.ID, "00000000", 0, 3)
				case "count":
					return tx.TaskDAO().MoveTaskStep(ctx, task.ID, "00000000", 0, 5)
				default:
					return tx.TaskDAO().MoveTaskStep(ctx, task.ID, "00000000", 0, -1)
				}
			})
			var failure *TransactionError
			if !errors.As(err, &failure) || failure.CommitAttempted || failure.CleanupFailed || failure.Outcome != TransactionNotCommitted {
				t.Fatalf("store move failure completion: %+v %v", failure, err)
			}
			if mode == "count" {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatal("count mismatch marker lost")
				}
			} else {
				var driver *pgconn.PgError
				if !errors.As(err, &driver) {
					t.Fatal("driver cause lost")
				}
				if mode == "constraint" && driver.Code != "23514" {
					t.Fatal(driver.Code)
				}
			}
			if before != state() {
				t.Fatal("failed interval left partial positions or parent change")
			}
		})
	}
}
