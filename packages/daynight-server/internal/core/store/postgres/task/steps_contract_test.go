package task_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"reflect"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type writerStepHeader struct {
	model.TaskHeader
	UpdatedAt time.Time
}

func writerStepReadRows(t *testing.T, database *postgres.Store, projectID, taskID string) (writerStepHeader, []model.TaskStep) {
	t.Helper()
	var header writerStepHeader
	var rows []model.TaskStep
	if err := writerTransaction(t, database, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		reader := task.NewReader(tx)
		var err error
		header.TaskHeader, err = reader.TaskHeader(t.Context(), projectID, taskID)
		if err != nil {
			return err
		}
		rows, err = reader.TaskSteps(t.Context(), taskID)
		if err != nil {
			return err
		}
		if err := tx.QueryRow(t.Context(), "SELECT updated_at FROM tasks WHERE id=$1", taskID).Scan(&header.UpdatedAt); err != nil {
			return err
		}
		header.UpdatedAt = header.UpdatedAt.UTC()
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return header, rows
}

func TestTaskStepsChangeStoreUpdatesOneExistingTarget(t *testing.T) {
	database := writerStore(t)
	ctx := context.Background()
	project := writerProject(t, database, 1)
	task := writerTask(t, database, project.ID, 10, model.TaskDone)
	testutil.SeedStep(t, database.Pool, task.ID, "00000000", 0)
	testutil.SeedStep(t, database.Pool, task.ID, "abcdef01", 1)
	var before []model.TaskStep
	if err := writerRead(t, database, func(dao store.TaskReader) error {
		var err error
		before, err = dao.TaskSteps(ctx, task.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	stamp := time.Date(2026, 11, 4, 3, 4, 5, 654321000, time.UTC)
	target := before[0]
	target.Title, target.Description, target.Status, target.UpdatedAt = "  Paired title  ", "# Paired body\n", model.TaskStepSkipped, stamp
	if err := writerWrite(t, database, project.ID, func(dao store.TaskWriteDAO) error { return dao.UpdateTaskStep(ctx, task.ID, target) }); err != nil {
		t.Fatal(err)
	}
	if err := writerRead(t, database, func(dao store.TaskReader) error {
		after, err := dao.TaskSteps(ctx, task.ID)
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

func TestTaskStepsDeleteStoreDeletesTargetAndUpdatesOnlyTail(t *testing.T) {
	database := writerStore(t)
	ctx := context.Background()
	project := writerProject(t, database, 1)
	task := writerTask(t, database, project.ID, 10, model.TaskDone)
	ids := []string{"00000000", "11111111", "abcdef01", "fedcba98"}
	for index, id := range ids {
		testutil.SeedStep(t, database.Pool, task.ID, id, int64(index))
		testutil.MustExec(t, database.Pool, `UPDATE task_steps SET status=$3 WHERE task_id=$1 AND id=$2`, task.ID, id,
			[]model.TaskStepStatus{model.TaskStepTodo, model.TaskStepInProgress, model.TaskStepDone, model.TaskStepSkipped}[index])
	}
	testutil.MustExec(t, database.Pool, `UPDATE task_steps SET description='[Plan](plan.md)' WHERE task_id=$1 AND id=$2`, task.ID, ids[2])
	testutil.MustExec(t, database.Pool, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests',$2)`, task.ID,
		`[{"url":"opaque-pr-reference","title":"Evidence"}]`)
	parent := testutil.SnapshotTask(t, database, project.ID, task.ID)
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
		if err := writerRead(t, database, func(dao store.TaskReader) error {
			var err error
			rows, err = dao.TaskSteps(ctx, task.ID)
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
		if err := writerWrite(t, database, project.ID, func(dao store.TaskWriteDAO) error {
			var err error
			changedAt, err = dao.ObservedAt(ctx)
			if err != nil {
				return err
			}
			if err := dao.DeleteTaskStep(ctx, task.ID, tc.id, tc.position, tc.tail); err != nil {
				return err
			}
			return dao.TouchTask(ctx, task.ID, changedAt)
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
		changedParent := testutil.SnapshotTask(t, database, project.ID, task.ID)
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
		if err := writerTransaction(t, database, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
			dao := attachment.NewReader(tx)
			actual, err := dao.Attachment(ctx, project.ID, task.ID, address.RelativePath)
			if err != nil {
				return err
			}
			page, err := dao.Attachments(ctx, project.ID, task.ID, store.AttachmentQuery{Limit: 10})
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
	if err := writerWrite(t, database, project.ID, func(dao store.TaskWriteDAO) error {
		stamp, err := dao.ObservedAt(ctx)
		if err != nil {
			return err
		}
		reused = model.TaskStep{ID: ids[2], Position: 0, Title: "new record", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp}
		if err := dao.InsertTaskStep(ctx, task.ID, reused); err != nil {
			return err
		}
		return dao.TouchTask(ctx, task.ID, stamp)
	}); err != nil {
		t.Fatal(err)
	}
	recreated := read()
	if len(recreated) != 1 || recreated[0] != reused || !reused.CreatedAt.After(byID[ids[2]].CreatedAt) || !reused.CreatedAt.Equal(reused.UpdatedAt) {
		t.Fatal("Step ID reuse restored deleted content or lost the new record clock")
	}
	afterParent := testutil.SnapshotTask(t, database, project.ID, task.ID)
	if afterParent.Version != parent.Version+5 || !afterParent.UpdatedAt.Equal(reused.UpdatedAt) {
		t.Fatal("Step ID reuse lost its parent revision or database clock")
	}
	afterParent.Version, afterParent.UpdatedAt = parent.Version, parent.UpdatedAt
	if !reflect.DeepEqual(afterParent, parent) {
		t.Fatal("Step ID reuse changed parent properties or business fields")
	}
	assertAttachment()
}

func TestTaskStepsMoveStoreWritesOnlyInclusivePositionInterval(t *testing.T) {
	database := writerStore(t)
	ctx := context.Background()
	project := writerProject(t, database, 1)
	task := writerTask(t, database, project.ID, 10, model.TaskDone)
	ids := []string{"00000000", "11111111", "abcdef01", "fedcba98"}
	for index, id := range ids {
		testutil.SeedStep(t, database.Pool, task.ID, id, int64(index))
	}
	if _, err := database.Pool.Exec(ctx, `CREATE TABLE moved_rows(id text PRIMARY KEY); CREATE FUNCTION audit_moved_rows() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO moved_rows VALUES(NEW.id); RETURN NEW; END $$; CREATE TRIGGER audit_moved_rows AFTER UPDATE ON task_steps FOR EACH ROW EXECUTE FUNCTION audit_moved_rows()`); err != nil {
		t.Fatal(err)
	}
	read := func() []model.TaskStep {
		t.Helper()
		var rows []model.TaskStep
		if err := writerRead(t, database, func(dao store.TaskReader) error {
			var err error
			rows, err = dao.TaskSteps(ctx, task.ID)
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
		if err := writerWrite(t, database, project.ID, func(dao store.TaskWriteDAO) error {
			return dao.MoveTaskStep(ctx, task.ID, tc.target, tc.from, tc.to)
		}); err != nil {
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

func TestTaskStepsWritesPreserveParentAcrossExecutionPolicies(t *testing.T) {
	database := writerStore(t)
	project := writerProject(t, database, 1)
	dependency := writerTask(t, database, project.ID, 10, model.TaskDone)
	for index, policy := range []string{"todo", "in_progress", "done", "active_worker", "invalid_worker"} {
		t.Run(policy, func(t *testing.T) {
			task := writerTask(t, database, project.ID, 20+index, model.TaskTodo, dependency.ID)
			testutil.MustExec(t, database.Pool, `UPDATE tasks SET required_platform='linux',assigned_to=$2,allow_agents=true WHERE id=$1`, task.ID, testutil.QueryID(500))
			testutil.MustExec(t, database.Pool, `UPDATE task_dependencies SET external=true WHERE task_id=$1`, task.ID)
			testutil.MustExec(t, database.Pool, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests',$2)`, task.ID, `[{"url":"opaque\u0000url","title":"Evidence"}]`)
			if policy == "active_worker" {
				testutil.MustExec(t, database.Pool, `UPDATE tasks SET status='in_progress',started_at='2026-01-01' WHERE id=$1`, task.ID)
				testutil.MustExec(t, database.Pool, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, task.ID, fmt.Sprintf(`{"claimId":%q,"state":"active","userId":%q,"workerId":%q,"machine":{"id":%q,"name":"Build machine"},"platform":"linux","agent":"codex","agentControlMode":"herdr","worktreeId":%q,"phase":"preparing","claimedAt":"2026-01-01T00:00:00Z"}`, testutil.QueryID(501+index), testutil.QueryID(500), testutil.QueryID(510), testutil.QueryID(511), testutil.QueryID(512)))
				testutil.MustExec(t, database.Pool, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,grant_hash,grant_expires_at,grant_kind) VALUES($1,$2,$3,$4,$5,$6,'{}','{}','secret','2099-01-01','connect')`, testutil.QueryID(520+index), project.ID, task.ID, testutil.QueryID(501+index), testutil.QueryID(500), testutil.QueryID(530+index))
			} else if policy == "invalid_worker" {
				testutil.MustExec(t, database.Pool, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker','invalid JSON')`, task.ID)
			} else if policy != "todo" {
				testutil.MustExec(t, database.Pool, `UPDATE tasks SET status=$2,started_at='2026-01-01',completed_at=CASE WHEN $2='done' THEN '2026-01-02'::timestamptz ELSE NULL END WHERE id=$1`, task.ID, policy)
			}
			testutil.SeedStepWitnessRows(t, database.Pool, task.ID, 4)
			parent := testutil.StepWitnessState(t, database.Pool, task.ID, true)
			for _, operation := range []string{"add", "change", "status", "move", "delete"} {
				header, before := writerStepReadRows(t, database, project.ID, task.ID)
				if err := writerWrite(t, database, project.ID, func(dao store.TaskWriteDAO) error {
					if _, err := dao.TaskHeader(t.Context(), task.ID); err != nil {
						return err
					}
					return testutil.MutateStep(t.Context(), dao, task.ID, operation)
				}); err != nil {
					t.Fatal(err)
				}
				afterHeader, after := writerStepReadRows(t, database, project.ID, task.ID)
				if afterHeader.Version != header.Version+1 || testutil.StepWitnessState(t, database.Pool, task.ID, true) != parent {
					t.Fatal("step write changed parent policy, ownership, materials or revision increment")
				}
				byID := make(map[string]model.TaskStep, len(before))
				for _, row := range before {
					byID[row.ID] = row
				}
				for _, row := range after {
					original, exists := byID[row.ID]
					if !exists {
						expected := model.TaskStep{ID: "12345678", Position: 0, Title: "new", Description: "new body", Status: model.TaskStepTodo, CreatedAt: afterHeader.UpdatedAt, UpdatedAt: afterHeader.UpdatedAt}
						if row != expected {
							t.Fatal("added row lost its exact fields or shared database clock")
						}
						continue
					}
					if operation == "change" || operation == "status" {
						if row.ID == before[0].ID {
							if operation == "change" {
								original.Title, original.Description = "new title", "new description"
							} else {
								original.Status = model.TaskStepDone
							}
							original.UpdatedAt = afterHeader.UpdatedAt
							if row != original {
								t.Fatal("target fields, creation time or shared change clock changed")
							}
							continue
						}
					}
					original.Position = row.Position
					if !reflect.DeepEqual(row, original) {
						t.Fatal("step write changed retained identity, content, status or timestamps")
					}
				}
				if afterHeader.UpdatedAt.Nanosecond()%1000 != 0 {
					t.Fatal("parent timestamp lost PostgreSQL microsecond precision")
				}
			}
		})
	}
}

func TestTaskStepsStorageErrorsPropagate(t *testing.T) {
	database := writerStore(t)
	ctx := context.Background()
	project := writerProject(t, database, 1)
	task := writerTask(t, database, project.ID, 10, model.TaskTodo)
	testutil.SeedStep(t, database.Pool, task.ID, "00000000", 0)
	testutil.MustExec(t, database.Pool, `UPDATE task_steps SET created_at='infinity' WHERE task_id=$1`, task.ID)
	if err := writerRead(t, database, func(dao store.TaskReader) error {
		if _, err := dao.TaskSteps(ctx, task.ID); err == nil {
			t.Fatal("scan failure concealed")
		}
		if _, err := dao.TaskStep(ctx, task.ID, "00000000"); err == nil {
			t.Fatal("item scan failure concealed")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, database.Pool, `DROP TABLE task_steps`)
	if err := writerRead(t, database, func(dao store.TaskReader) error {
		_, err := dao.TaskSteps(ctx, task.ID)
		return err
	}); err == nil {
		t.Fatal("query failure concealed")
	}
	testutil.MustExec(t, database.Pool, `ALTER TABLE tasks RENAME COLUMN version TO missing_version`)
	if err := writerRead(t, database, func(dao store.TaskReader) error {
		_, err := dao.TaskHeader(ctx, project.ID, task.ID)
		return err
	}); err == nil {
		t.Fatal("parent query failure concealed")
	}
}
