package postgres

import (
	"bytes"
	"context"
	"errors"
	"io"
	"reflect"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTaskStepsDeleteStoreDeletesTargetAndUpdatesOnlyTail(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, model.TaskDone)
	ids := []string{"00000000", "11111111", "abcdef01", "fedcba98"}
	for index, id := range ids {
		seedStoreStep(t, database, task.ID, id, int64(index))
		mustQueryExec(t, database, `UPDATE task_steps SET status=$3 WHERE task_id=$1 AND id=$2`, task.ID, id,
			[]model.TaskStepStatus{model.TaskStepTodo, model.TaskStepInProgress, model.TaskStepDone, model.TaskStepSkipped}[index])
	}
	mustQueryExec(t, database, `UPDATE task_steps SET description='[Plan](plan.md)' WHERE task_id=$1 AND id=$2`, task.ID, ids[2])
	mustQueryExec(t, database, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests',$2)`, task.ID,
		`[{"url":"opaque-pr-reference","title":"Evidence"}]`)
	parent := snapshotTask(t, database, project.ID, task.ID)
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Errorf("close Step attachment storage: %v", err)
		}
	})
	address, err := attachmentcore.NewAddress(project.ID, task.ID, "plan.md")
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("# Durable attachment\nReferences survive a Step deletion.\n")
	info, err := files.Put(ctx, attachmentcore.Bucket, address.StoragePath, bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	metadata, created, err := database.PutAttachment(ctx, model.Attachment{
		ProjectID: project.ID, TaskID: task.ID, Path: address.RelativePath, ContentType: "text/markdown", SizeBytes: info.Size,
	})
	if err != nil || !created {
		t.Fatalf("attachment fixture metadata: %+v %v", metadata, err)
	}
	if _, err := database.Pool.Exec(ctx, `CREATE TABLE deleted_rows(id text PRIMARY KEY); CREATE TABLE compacted_rows(id text PRIMARY KEY); CREATE FUNCTION audit_deleted_rows() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO deleted_rows VALUES(OLD.id); RETURN OLD; END $$; CREATE FUNCTION audit_compacted_rows() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO compacted_rows VALUES(NEW.id); RETURN NEW; END $$; CREATE TRIGGER audit_deleted_rows AFTER DELETE ON task_steps FOR EACH ROW EXECUTE FUNCTION audit_deleted_rows(); CREATE TRIGGER audit_compacted_rows AFTER UPDATE ON task_steps FOR EACH ROW EXECUTE FUNCTION audit_compacted_rows()`); err != nil {
		t.Fatal(err)
	}
	read := func() []model.TaskStep {
		t.Helper()
		var rows []model.TaskStep
		if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			var err error
			rows, err = snapshot.TaskDAO().TaskSteps(ctx, task.ID)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return rows
	}
	original := read()
	byID := make(map[string]model.TaskStep, len(original))
	for _, row := range original {
		byID[row.ID] = row
	}
	for index, tc := range []struct {
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
		var changedAt time.Time
		if err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
			var err error
			changedAt, err = tx.TaskDAO().ObservedAt(ctx)
			if err != nil {
				return err
			}
			if err := tx.TaskDAO().DeleteTaskStep(ctx, task.ID, tc.id, tc.position, tc.tail); err != nil {
				return err
			}
			return tx.TaskDAO().TouchTask(ctx, task.ID, changedAt)
		}); err != nil {
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
		changedParent := snapshotTask(t, database, project.ID, task.ID)
		if changedParent.Version != parent.Version+int64(index)+1 || !changedParent.UpdatedAt.Equal(changedAt) {
			t.Fatal("Step deletion lost its parent revision or database clock")
		}
		changedParent.Version, changedParent.UpdatedAt = parent.Version, parent.UpdatedAt
		if !reflect.DeepEqual(changedParent, parent) {
			t.Fatal("Step deletion changed parent properties or business fields")
		}
	}
	assertAttachment := func() {
		t.Helper()
		if err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
			actual, err := scope.AttachmentDAO().Attachment(ctx, project.ID, task.ID, address.RelativePath)
			if err != nil {
				return err
			}
			page, err := scope.AttachmentDAO().Attachments(ctx, project.ID, task.ID, AttachmentQuery{Limit: 10})
			if err != nil || !reflect.DeepEqual(actual, metadata) || len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], metadata) {
				t.Fatalf("Step deletion changed referenced attachment metadata: %+v %+v %v", actual, page, err)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		object, err := files.Open(ctx, attachmentcore.Bucket, address.StoragePath)
		if err != nil {
			t.Fatal(err)
		}
		actual, readErr := io.ReadAll(object.Body)
		closeErr := object.Body.Close()
		if readErr != nil || closeErr != nil || !bytes.Equal(actual, payload) || object.Info.Size != int64(len(payload)) {
			t.Fatalf("Step deletion changed referenced attachment bytes: read=%v close=%v", readErr, closeErr)
		}
	}
	assertAttachment()
	var reused model.TaskStep
	if err := writeProjectForTest(database, ctx, project.ID, func(scope ProjectWriteScope) error {
		stamp, err := scope.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		reused = model.TaskStep{ID: ids[2], Position: 0, Title: "new record", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp}
		if err := scope.TaskDAO().InsertTaskStep(ctx, task.ID, reused); err != nil {
			return err
		}
		return scope.TaskDAO().TouchTask(ctx, task.ID, stamp)
	}); err != nil {
		t.Fatal(err)
	}
	recreated := read()
	if len(recreated) != 1 || recreated[0] != reused || !reused.CreatedAt.After(byID[ids[2]].CreatedAt) || !reused.CreatedAt.Equal(reused.UpdatedAt) {
		t.Fatal("Step ID reuse restored deleted content or lost the new record clock")
	}
	afterParent := snapshotTask(t, database, project.ID, task.ID)
	if afterParent.Version != parent.Version+5 || !afterParent.UpdatedAt.Equal(reused.UpdatedAt) {
		t.Fatal("Step ID reuse lost its parent revision or database clock")
	}
	afterParent.Version, afterParent.UpdatedAt = parent.Version, parent.UpdatedAt
	if !reflect.DeepEqual(afterParent, parent) {
		t.Fatal("Step ID reuse changed parent properties or business fields")
	}
	assertAttachment()
}

func TestTaskStepsDeleteStoreFailureCausesAndRollback(t *testing.T) {
	for _, mode := range []string{"missing", "query", "tail_count", "tail_constraint"} {
		t.Run(mode, func(t *testing.T) {
			database := isolatedStore(t)
			ctx := context.Background()
			project := queryProject(t, database, 1)
			task := queryTask(t, database, project.ID, 10, model.TaskTodo)
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
