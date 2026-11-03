package store

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTaskStepsDeleteStoreDeletesTargetAndUpdatesOnlyTail(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, core.TaskDone)
	ids := []string{"00000000", "11111111", "abcdef01", "fedcba98"}
	for index, id := range ids {
		seedStoreStep(t, database, task.ID, id, int64(index))
	}
	if _, err := database.Pool.Exec(ctx, `CREATE TABLE deleted_rows(id text PRIMARY KEY); CREATE TABLE compacted_rows(id text PRIMARY KEY); CREATE FUNCTION audit_deleted_rows() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO deleted_rows VALUES(OLD.id); RETURN OLD; END $$; CREATE FUNCTION audit_compacted_rows() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO compacted_rows VALUES(NEW.id); RETURN NEW; END $$; CREATE TRIGGER audit_deleted_rows AFTER DELETE ON task_steps FOR EACH ROW EXECUTE FUNCTION audit_deleted_rows(); CREATE TRIGGER audit_compacted_rows AFTER UPDATE ON task_steps FOR EACH ROW EXECUTE FUNCTION audit_compacted_rows()`); err != nil {
		t.Fatal(err)
	}
	read := func() []core.TaskStep {
		t.Helper()
		var rows []core.TaskStep
		if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
			var err error
			rows, err = snapshot.TaskSteps(ctx, task.ID)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return rows
	}
	original := read()
	byID := make(map[string]core.TaskStep, len(original))
	for _, row := range original {
		byID[row.ID] = row
	}
	for _, tc := range []struct {
		id             string
		position, tail int64
		order          []string
	}{
		{ids[1], 1, 2, []string{ids[0], ids[2], ids[3]}},
		{ids[3], 2, 0, []string{ids[0], ids[2]}},
		{ids[0], 0, 1, []string{ids[2]}},
		{ids[2], 0, 0, []string{}},
	} {
		if _, err := database.Pool.Exec(ctx, `TRUNCATE deleted_rows,compacted_rows`); err != nil {
			t.Fatal(err)
		}
		if err := database.WriteProject(ctx, project.ID, func(tx *ProjectTx) error { return tx.DeleteTaskStep(ctx, task.ID, tc.id, tc.position, tc.tail) }); err != nil {
			t.Fatal(err)
		}
		actual := read()
		if actual == nil || len(actual) != len(tc.order) {
			t.Fatal("delete returned absent/wrong remaining collection")
		}
		for index, id := range tc.order {
			expected := byID[id]
			expected.Position = int64(index)
			if actual[index] != expected {
				t.Fatal("delete altered a retained record")
			}
		}
		var removed, compacted int64
		if err := database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM deleted_rows),(SELECT count(*) FROM compacted_rows)`).Scan(&removed, &compacted); err != nil || removed != 1 || compacted != tc.tail {
			t.Fatalf("delete/tail wrote %d/%d, expected 1/%d: %v", removed, compacted, tc.tail, err)
		}
		var removedID string
		if err := database.Pool.QueryRow(ctx, `SELECT id FROM deleted_rows`).Scan(&removedID); err != nil || removedID != tc.id {
			t.Fatal("wrong physical target removed")
		}
	}
}

func TestTaskStepsDeleteStoreFailureCausesAndRollback(t *testing.T) {
	for _, mode := range []string{"missing", "query", "tail_count", "tail_constraint"} {
		t.Run(mode, func(t *testing.T) {
			database := isolatedStore(t)
			ctx := context.Background()
			project := queryProject(t, database, 1)
			task := queryTask(t, database, project.ID, 10, core.TaskTodo)
			for index, id := range []string{"00000000", "11111111", "abcdef01", "fedcba98"} {
				seedStoreStep(t, database, task.ID, id, int64(index))
			}
			if mode == "tail_constraint" {
				if _, err := database.Pool.Exec(ctx, `ALTER TABLE task_steps ADD CONSTRAINT refuse_compaction CHECK (position>=0 AND (id<>'11111111' OR position=1))`); err != nil {
					t.Fatal(err)
				}
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
			err := database.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
				switch mode {
				case "missing":
					return tx.DeleteTaskStep(ctx, task.ID, "ffffffff", 0, 3)
				case "query":
					if _, err := tx.tx.Exec(ctx, `ALTER TABLE task_steps RENAME COLUMN id TO invalid_id`); err != nil {
						return err
					}
					return tx.DeleteTaskStep(ctx, task.ID, "00000000", 0, 3)
				case "tail_count":
					return tx.DeleteTaskStep(ctx, task.ID, "00000000", 0, 4)
				default:
					return tx.DeleteTaskStep(ctx, task.ID, "00000000", 0, 3)
				}
			})
			var failure *TransactionError
			if !errors.As(err, &failure) || failure.CommitAttempted || failure.CleanupFailed || failure.Outcome != TransactionNotCommitted {
				t.Fatalf("delete store failure completion: %+v %v", failure, err)
			}
			if mode == "missing" || mode == "tail_count" {
				if !errors.Is(err, core.ErrNotFound) {
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
			if before != state() {
				t.Fatal("failed delete left target loss or partial tail/parent changes")
			}
		})
	}
}

func TestTaskStepsDeleteLostCommitReceiptKeepsUnknownAndCurrentFacts(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, core.TaskTodo)
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
		if _, err := tx.TaskHeader(ctx, task.ID); err != nil {
			return err
		}
		stamp, err := tx.ObservedAt(ctx)
		if err != nil {
			return err
		}
		if err := tx.DeleteTaskStep(ctx, task.ID, "11111111", 1, 1); err != nil {
			return err
		}
		return tx.TouchTask(ctx, task.ID, stamp)
	})
	var failure *TransactionError
	if !errors.As(err, &failure) || failure.Phase != "commit" || !failure.CommitAttempted || failure.CleanupFailed || failure.Outcome != TransactionUnknown || !errors.Is(err, lost) {
		t.Fatalf("unknown delete completion: %+v %v", failure, err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		header, err := snapshot.TaskHeader(ctx, project.ID, task.ID)
		if err != nil {
			return err
		}
		rows, err := snapshot.TaskSteps(ctx, task.ID)
		if err != nil {
			return err
		}
		if header.Version != task.Version+1 || len(rows) != 2 || rows[0].ID != "00000000" || rows[0].Position != 0 || rows[1].ID != "abcdef01" || rows[1].Position != 1 {
			t.Fatal("current read facts do not reflect retained rows/version")
		}
		_, err = snapshot.TaskStep(ctx, task.ID, "11111111")
		if !errors.Is(err, core.ErrNotFound) {
			t.Fatal("current target absence not observed")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
