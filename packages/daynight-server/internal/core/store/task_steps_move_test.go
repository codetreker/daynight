package store

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTaskStepsMoveStoreWritesOnlyInclusivePositionInterval(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, model.TaskDone)
	ids := []string{"00000000", "11111111", "abcdef01", "fedcba98"}
	for index, id := range ids {
		seedStoreStep(t, database, task.ID, id, int64(index))
	}
	if _, err := database.Pool.Exec(ctx, `CREATE TABLE moved_rows(id text PRIMARY KEY); CREATE FUNCTION audit_moved_rows() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO moved_rows VALUES(NEW.id); RETURN NEW; END $$; CREATE TRIGGER audit_moved_rows AFTER UPDATE ON task_steps FOR EACH ROW EXECUTE FUNCTION audit_moved_rows()`); err != nil {
		t.Fatal(err)
	}
	read := func() []model.TaskStep {
		t.Helper()
		var rows []model.TaskStep
		if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
			var err error
			rows, err = snapshot.TaskSteps(ctx, task.ID)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return rows
	}
	before := read()
	for _, tc := range []struct {
		target   string
		from, to int64
		order    []int
		affected int
	}{
		{ids[1], 1, 2, []int{0, 2, 1, 3}, 2},
		{ids[1], 2, 0, []int{1, 0, 2, 3}, 3},
		{ids[1], 0, 3, []int{0, 2, 3, 1}, 4},
	} {
		if _, err := database.Pool.Exec(ctx, `DELETE FROM moved_rows`); err != nil {
			t.Fatal(err)
		}
		if err := database.WriteProject(ctx, project.ID, func(tx *ProjectTx) error { return tx.MoveTaskStep(ctx, task.ID, tc.target, tc.from, tc.to) }); err != nil {
			var driver *pgconn.PgError
			if errors.As(err, &driver) {
				t.Fatalf("move did not commit: code=%s message=%s", driver.Code, driver.Message)
			}
			t.Fatal(err)
		}
		after := read()
		for index, source := range tc.order {
			expected := before[source]
			expected.Position = int64(index)
			if after[index] != expected {
				t.Fatalf("move altered non-position fields/order at %d", index)
			}
		}
		var count int
		if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM moved_rows`).Scan(&count); err != nil || count != tc.affected {
			t.Fatalf("interval wrote %d rows, expected %d: %v", count, tc.affected, err)
		}
	}
}

func TestTaskStepsMoveStoreFailuresPreserveCausesAndRollback(t *testing.T) {
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
			err := database.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
				switch mode {
				case "query":
					if _, err := tx.tx.Exec(ctx, `ALTER TABLE task_steps RENAME COLUMN position TO invalid_position`); err != nil {
						return err
					}
					return tx.MoveTaskStep(ctx, task.ID, "00000000", 0, 3)
				case "count":
					return tx.MoveTaskStep(ctx, task.ID, "00000000", 0, 5)
				default:
					return tx.MoveTaskStep(ctx, task.ID, "00000000", 0, -1)
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
