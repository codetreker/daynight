package postgres

import (
	"context"
	"errors"
	"testing"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTaskStepsDeleteStoreFailureCausesAndRollback(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	for index, id := range []string{"00000000", "11111111", "abcdef01", "fedcba98"} {
		seedStoreStep(t, database, task.ID, id, int64(index))
	}
	state := func(t *testing.T) string {
		t.Helper()
		var result string
		if err := database.Pool.QueryRow(ctx, `SELECT jsonb_build_object('task',to_jsonb(t),'steps',(SELECT jsonb_agg(to_jsonb(s) ORDER BY position) FROM task_steps s WHERE task_id=t.id))::text FROM tasks t WHERE id=$1`, task.ID).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := state(t)
	for _, mode := range []string{"missing", "query", "tail_count", "tail_constraint"} {
		if !t.Run(mode, func(t *testing.T) {
			if before != state(t) {
				t.Fatal("previous fault changed the shared delete fixture")
			}
			if mode == "tail_constraint" {
				if _, err := database.Pool.Exec(ctx, `ALTER TABLE task_steps ADD CONSTRAINT refuse_compaction CHECK (position>=0 AND (id<>'11111111' OR position=1))`); err != nil {
					t.Fatal(err)
				}
			}
			err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
				switch mode {
				case "missing":
					return tx.TaskDAO().DeleteTaskStep(ctx, task.ID, "ffffffff", 0, 3)
				case "query":
					if _, err := tx.(*ProjectTx).tx.Exec(ctx, `ALTER TABLE task_steps RENAME COLUMN id TO invalid_id`); err != nil {
						return err
					}
					return tx.TaskDAO().DeleteTaskStep(ctx, task.ID, "00000000", 0, 3)
				case "tail_count":
					return tx.TaskDAO().DeleteTaskStep(ctx, task.ID, "00000000", 0, 4)
				default:
					return tx.TaskDAO().DeleteTaskStep(ctx, task.ID, "00000000", 0, 3)
				}
			})
			var failure *TransactionError
			if !errors.As(err, &failure) || failure.CommitAttempted || failure.CleanupFailed || failure.Outcome != TransactionNotCommitted {
				t.Fatalf("delete store failure completion: %+v %v", failure, err)
			}
			if mode == "missing" || mode == "tail_count" {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatal("affected-row mismatch marker lost")
				}
			} else {
				var driver *pgconn.PgError
				if !errors.As(err, &driver) {
					t.Fatal("driver cause lost")
				}
				if mode == "tail_constraint" && driver.Code != "23514" {
					t.Fatal(driver.Code)
				}
			}
			if before != state(t) {
				t.Fatal("failed delete left target loss or partial tail/parent changes")
			}
			assertMigrationPoolReusable(t, database.Pool)
			if mode == "tail_constraint" {
				if _, err := database.Pool.Exec(ctx, "ALTER TABLE task_steps DROP CONSTRAINT refuse_compaction"); err != nil {
					t.Fatal(err)
				}
				var retained bool
				if err := database.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT FROM pg_constraint WHERE conrelid='task_steps'::regclass AND conname='refuse_compaction')").Scan(&retained); err != nil || retained {
					t.Fatalf("delete fault constraint was retained: %t %v", retained, err)
				}
			}
		}) {
			return
		}
	}
}

func TestTaskStepsDeleteLostCommitReceiptKeepsUnknownAndCurrentFacts(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	for index, id := range []string{"00000000", "11111111", "abcdef01"} {
		seedStoreStep(t, database, task.ID, id, int64(index))
	}
	transaction, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	lost := errors.New("private delete Commit receipt lost")
	err = transact(ctx, &threadCommitResponseLoss{Tx: transaction, cause: lost}, func(raw pgx.Tx) error {
		tx := &ProjectTx{tx: raw, projectID: project.ID}
		if _, err := raw.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project.ID); err != nil {
			return err
		}
		if _, err := tx.TaskDAO().TaskHeader(ctx, task.ID); err != nil {
			return err
		}
		stamp, err := tx.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		if err := tx.TaskDAO().DeleteTaskStep(ctx, task.ID, "11111111", 1, 1); err != nil {
			return err
		}
		return tx.TaskDAO().TouchTask(ctx, task.ID, stamp)
	})
	var failure *TransactionError
	if !errors.As(err, &failure) || failure.Phase != "commit" || !failure.CommitAttempted || failure.CleanupFailed || failure.Outcome != TransactionUnknown || !errors.Is(err, lost) {
		t.Fatalf("unknown delete completion: %+v %v", failure, err)
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
		if header.Version != task.Version+1 || len(rows) != 2 || rows[0].ID != "00000000" || rows[0].Position != 0 || rows[1].ID != "abcdef01" || rows[1].Position != 1 {
			t.Fatal("current read facts do not reflect retained rows/version")
		}
		_, err = snapshot.TaskDAO().TaskStep(ctx, task.ID, "11111111")
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatal("current target absence not observed")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
