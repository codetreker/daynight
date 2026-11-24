package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	transfercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Each case owns its Project and identities. The parent stops reuse after a
// failed case and checks the pool after child cleanup has completed.
func TestProjectDeletionSnapshotsAndRetirement(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	cases := []struct {
		name string
		run  func(*testing.T, *Store)
	}{
		{"WorkerSnapshotAndCompletion", projectDeletionWorkerSnapshotAndCompletion},
		{"ObservationAndTransactionBoundRetirement", projectDeletionObservationAndTransactionBoundRetirement},
		{"MarkPreservesDatabaseFailureAndRejectsSecondMark", projectDeletionMarkPreservesDatabaseFailureAndRejectsSecondMark},
		{"PreservesHistoricalRowsAndCommitsRetirement", projectDeletionPreservesHistoricalRowsAndCommitsRetirement},
		{"AuthorizationAfterTransferAndReturn", projectDeletionAuthorizationAfterTransferAndReturn},
	}
	for _, tc := range cases {
		ok := t.Run(tc.name, func(t *testing.T) {
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
				defer cancel()
				if _, err := database.Pool.Exec(ctx, `DROP TRIGGER IF EXISTS fail_project_mark ON projects; DROP FUNCTION IF EXISTS fail_project_mark()`); err != nil {
					t.Errorf("remove mark fault: %v", err)
					return
				}
				if err := checkFaultTriggerRemoved(ctx, database, "fail_project_mark", "projects"); err != nil {
					t.Error(err)
				}
			})
			tc.run(t, database)
		})
		testutil.AssertPoolReusable(t, database.Pool)
		if !ok {
			return
		}
	}
}

func TestProjectDeletionLocking(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	cases := []struct {
		name string
		run  func(*testing.T, *Store)
	}{
		{"WaitsForDeletedTask", projectDeletionWaitsForDeletedTask},
		{"TaskLockCancellationRollsBack", projectDeletionTaskLockCancellationRollsBack},
		{"WaitingStatementUsesOldProjectSnapshot", projectDeletionWaitingStatementUsesOldProjectSnapshot},
		{"OrdersClaimAndThread", projectDeletionOrdersClaimAndThread},
	}
	for _, tc := range cases {
		ok := t.Run(tc.name, func(t *testing.T) { tc.run(t, database) })
		testutil.AssertPoolReusable(t, database.Pool)
		if !ok {
			return
		}
	}
}

func projectDeletionWorkerSnapshotAndCompletion(t *testing.T, database *Store) {
	s := database
	actor, _, project := testutil.ProjectMembershipFixture(t, s)
	ctx := context.Background()
	claim := model.WorkerClaim{ClaimID: uuid.NewString(), UserID: actor.UserID, WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "machine"}, Platform: model.TaskPlatform("linux"), Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString(), Phase: model.WorkerExecuting, State: model.WorkerActive, ClaimedAt: time.Now().UTC()}
	raw, err := taskproperty.EncodeWorker(&claim)
	if err != nil {
		t.Fatal(err)
	}
	lastSeen := time.Now().UTC().Truncate(time.Microsecond)
	mustQueryExec(t, s, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,$3,$3,'{}','{}')`, actor.UserID, claim.WorkerID, lastSeen)
	mustQueryExec(t, s, `INSERT INTO tasks(id,project_id,title,status,deleted_at)
 SELECT ('00000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,
 $1,'Task ' || i,'todo',CASE WHEN i=130 THEN now() END FROM generate_series(1,130) AS i`, project.ID)
	mustQueryExec(t, s, `INSERT INTO task_properties(task_id,name,value)
 SELECT id,'worker',$2 FROM tasks WHERE project_id=$1`, project.ID, string(raw))
	mustQueryExec(t, s, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'blocked','true')`, queryID(130))
	mustQueryExec(t, s, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'x','text/plain',1),($1,$3,'x','text/plain',1)`, project.ID, queryID(1), queryID(130))
	err = s.ReadProjectDeletion(ctx, project.ID, func(snapshot store.ProjectDeletionSnapshot) error {
		access, err := snapshot.ProjectDAO().ProjectAccess(ctx, actor, project.ID)
		if err != nil || !access.CanTransfer {
			return fmt.Errorf("access: %+v %w", access, err)
		}
		summary, err := snapshot.Summary(ctx)
		if err != nil {
			return err
		}
		if summary.TaskCount != 129 || summary.UnfinishedTaskCount != 129 || summary.AttachmentCount != 1 {
			return fmt.Errorf("summary: %+v", summary)
		}
		count := 0
		err = snapshot.VisitTaskWorkers(ctx, func(f store.ProjectDeletionWorker) error {
			count++
			if f.Worker == nil || f.Worker.ClaimID != claim.ClaimID || f.LastSeenAt == nil || !f.LastSeenAt.Equal(lastSeen) || f.Paused != (f.TaskID == queryID(130)) {
				return fmt.Errorf("worker: %+v", f)
			}
			return nil
		})
		if err != nil {
			return err
		}
		if count != 130 {
			return fmt.Errorf("worker count %d", count)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sentinel := errors.New("rollback")
	c, err := s.WriteProjectDeletion(ctx, project.ID, func(scope store.ProjectDeletionScope) error {
		access, err := scope.ProjectDAO().Authorization(ctx, actor)
		if err != nil || !access.CanTransfer {
			return fmt.Errorf("authorization: %+v %w", access, err)
		}
		if err := scope.ProjectDAO().VisitTaskWorkers(ctx, func(item store.ProjectDeletionWorker) error {
			if item.Title != "" {
				return errors.New("deletion scan loaded task title")
			}
			return nil
		}); err != nil {
			return err
		}
		marked, err := scope.ProjectDAO().MarkDeleted(ctx)
		if err != nil || !marked {
			return fmt.Errorf("mark: %t %w", marked, err)
		}
		return sentinel
	})
	if c.Outcome != store.TransactionNotCommitted || !errors.Is(err, sentinel) {
		t.Fatalf("rollback: %+v %v", c, err)
	}
	c, err = s.WriteProjectDeletion(ctx, project.ID, func(scope store.ProjectDeletionScope) error {
		ok, e := scope.ProjectDAO().MarkDeleted(ctx)
		if e != nil {
			return e
		}
		if !ok {
			return errors.New("not marked")
		}
		return nil
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("commit: %+v %v", c, err)
	}
	c, err = s.WriteProjectDeletion(ctx, project.ID, func(store.ProjectDeletionScope) error { return nil })
	if c.Outcome != store.TransactionNotCommitted || !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("second deletion: %+v %v", c, err)
	}
}

func TestProjectDeletionPreservesWorkerJSONDecodeFailure(t *testing.T) {
	parallelRootDatabaseTest(t)
	// Pre-index storage permits corrupt bytes needed to exercise reader failures.
	s := &Store{Pool: workerIndexOldPool(t)}
	project := testutil.QueryProject(t, s.Pool, s, 10)
	ctx := context.Background()
	for _, raw := range []string{"{", `{"claimId":1}`} {
		id := uuid.NewString()
		mustQueryExec(t, s, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'bad')`, id, project.ID)
		mustQueryExec(t, s, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, id, raw)
		err := s.ReadProjectDeletion(ctx, project.ID, func(snapshot store.ProjectDeletionSnapshot) error {
			return snapshot.VisitTaskWorkers(ctx, func(store.ProjectDeletionWorker) error { return nil })
		})
		if err == nil {
			t.Fatalf("accepted corrupt worker %q", raw)
		}
		if raw == "{" {
			var cause *pgconn.PgError
			if !errors.As(err, &cause) || cause.Code != "22P02" {
				t.Fatalf("lost PostgreSQL JSON conversion cause: %v", err)
			}
		} else {
			var cause *json.UnmarshalTypeError
			if !errors.As(err, &cause) {
				t.Fatalf("lost Worker field decoding cause: %v", err)
			}
		}
		mustQueryExec(t, s, `DELETE FROM task_properties WHERE task_id=$1`, id)
		mustQueryExec(t, s, `DELETE FROM tasks WHERE id=$1`, id)
	}
}

func projectDeletionWaitsForDeletedTask(t *testing.T, database *Store) {
	s := database
	_, _, project := testutil.ProjectMembershipFixture(t, s)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	id := uuid.NewString()
	mustQueryExec(t, s, `INSERT INTO tasks(id,project_id,title,deleted_at) VALUES($1,$2,'historical',now())`, id, project.ID)
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	launched, drained := false, false
	defer func() {
		cancel()
		cleanup, stop := context.WithTimeout(context.Background(), cleanupTimeout)
		defer stop()
		if err := tx.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("release historical Task lock: %v", err)
		}
		if launched && !drained {
			select {
			case <-done:
			case <-cleanup.Done():
				t.Errorf("drain deletion: %v", cleanup.Err())
			}
		}
	}()
	if _, err = tx.Exec(ctx, `SELECT id FROM tasks WHERE id=$1 FOR UPDATE`, id); err != nil {
		t.Fatal(err)
	}
	launched = true
	go func() {
		_, err := s.WriteProjectDeletion(ctx, project.ID, func(store.ProjectDeletionScope) error { return nil })
		done <- err
	}()
	waitTransferTeamLock(t, ctx, s, "WITH goals AS (SELECT id FROM tasks WHERE project_id=", tx.Conn().PgConn().PID())
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		drained = true
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatalf("deletion did not finish: %v", ctx.Err())
	}
}

func projectDeletionObservationAndTransactionBoundRetirement(t *testing.T, database *Store) {
	db := database
	owner, _, project := testutil.ProjectMembershipFixture(t, db)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	before := time.Now().UTC().Add(-time.Second)
	if err := db.ReadProjectDeletion(ctx, project.ID, func(snapshot store.ProjectDeletionSnapshot) error {
		observed, err := snapshot.ObservedAt(ctx)
		if err != nil || observed.Location() != time.UTC || observed.Before(before) || observed.After(time.Now().UTC().Add(time.Second)) {
			return fmt.Errorf("database observation %v: %w", observed, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := (&deletionSnapshot{projectDeletion{tx: tx, projectID: project.ID}}).ObservedAt(ctx); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed observation lost driver error: %v", err)
	}

	task := queryTask(t, db, project.ID, 1000, model.TaskTodo)
	sessionID := uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot)
 VALUES($1,$2,$3,$4,$5,$6,'{}','{"lifecycle":"active"}')`, sessionID, project.ID, task.ID, uuid.NewString(), owner.UserID, uuid.NewString())
	sentinel := errors.New("reject retirement transaction")
	completion, err := db.WriteProjectDeletion(ctx, project.ID, func(scope store.ProjectDeletionScope) error {
		marked, err := scope.ProjectDAO().MarkDeleted(ctx)
		if err != nil || !marked {
			return fmt.Errorf("mark project: %t %w", marked, err)
		}
		dao := scope.SessionDAO()
		facts, err := dao.LockProjectSessions(ctx, project.ID, "", 128)
		if err != nil || len(facts) != 1 || facts[0].ID != sessionID || facts[0].Lifecycle != "active" {
			return fmt.Errorf("session facts: %+v %w", facts, err)
		}
		if err := dao.ApplyProjectSessionRetirement(ctx, []store.ProjectSessionRetirementPlan{{ID: sessionID, Backend: "web", SnapshotPatch: map[string]any{"lifecycle": "draining"}, Receipts: []store.ProjectSessionReceiptTransition{}}}); err != nil {
			return err
		}
		return sentinel
	})
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, sentinel) {
		t.Fatalf("retirement rollback: %+v %v", completion, err)
	}
	var live, unchanged bool
	if err := db.Pool.QueryRow(ctx, `SELECT p.deleted_at IS NULL,s.snapshot->>'lifecycle'='active'
 FROM projects p JOIN task_sessions s ON s.project_id=p.id WHERE p.id=$1 AND s.id=$2`, project.ID, sessionID).Scan(&live, &unchanged); err != nil || !live || !unchanged {
		t.Fatalf("retirement escaped rollback: live=%v unchanged=%v error=%v", live, unchanged, err)
	}
}

func projectDeletionMarkPreservesDatabaseFailureAndRejectsSecondMark(t *testing.T, database *Store) {
	db := database
	_, _, project := testutil.ProjectMembershipFixture(t, db)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var originalEpoch string
	if err := db.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&originalEpoch); err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, db, `CREATE FUNCTION fail_project_mark() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1002', MESSAGE='mark failed'; END $$;
 CREATE TRIGGER fail_project_mark BEFORE UPDATE OF deleted_at ON projects FOR EACH ROW EXECUTE FUNCTION fail_project_mark()`)
	completion, err := db.WriteProjectDeletion(ctx, project.ID, func(scope store.ProjectDeletionScope) error {
		_, err := scope.ProjectDAO().MarkDeleted(ctx)
		return err
	})
	var driver *pgconn.PgError
	if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &driver) || driver.Code != "P1002" {
		t.Fatalf("mark failure outcome: %+v %v", completion, err)
	}
	var live bool
	var epoch string
	if err := db.Pool.QueryRow(ctx, `SELECT deleted_at IS NULL,task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&live, &epoch); err != nil || !live || epoch != originalEpoch {
		t.Fatalf("failed mark changed project: live=%v epoch=%s error=%v", live, epoch, err)
	}
	mustQueryExec(t, db, `DROP TRIGGER fail_project_mark ON projects`)
	completion, err = db.WriteProjectDeletion(ctx, project.ID, func(scope store.ProjectDeletionScope) error {
		first, err := scope.ProjectDAO().MarkDeleted(ctx)
		if err != nil || !first {
			return fmt.Errorf("first mark: %t %w", first, err)
		}
		second, err := scope.ProjectDAO().MarkDeleted(ctx)
		if err != nil || second {
			return fmt.Errorf("second mark: %t %w", second, err)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("mark commit: %+v %v", completion, err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT deleted_at IS NULL,task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&live, &epoch); err != nil || live || epoch == originalEpoch {
		t.Fatalf("mark did not persist: live=%v epoch=%s error=%v", live, epoch, err)
	}
}

func TestPrivateTransferProjectLifecycleAdmissionAndFailures(t *testing.T) {
	parallelRootDatabaseTest(t)
	db, owner, _, project := membershipFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	task := queryTask(t, db, project.ID, 10, model.TaskTodo)
	record := transferRecord(owner.UserID, time.Now().UTC())
	record.ProjectID, record.TaskID = project.ID, task.ID
	completion, err := db.WritePrivateTransfer(ctx, func(dao store.PrivateTransferDAO) error {
		_, _, err := transfercore.Create(ctx, dao, record)
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("create transfer: %+v %v", completion, err)
	}
	check := func(projectID, taskID string) (store.Completion, error) {
		return db.WritePrivateTransfer(ctx, func(dao store.PrivateTransferDAO) error {
			if _, err := dao.Get(ctx, record.ID); err != nil {
				return err
			}
			return dao.LockProjectLifecycle(ctx, projectID, taskID)
		})
	}
	completion, err = check(project.ID, task.ID)
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("live scope: %+v %v", completion, err)
	}
	assertMissing := func(projectID, taskID string) {
		t.Helper()
		completion, err := check(projectID, taskID)
		if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing lifecycle: %+v %v", completion, err)
		}
	}
	assertMissing(project.ID, uuid.NewString())
	mustQueryExec(t, db, `UPDATE tasks SET deleted_at=now() WHERE id=$1`, task.ID)
	assertMissing(project.ID, task.ID)
	mustQueryExec(t, db, `UPDATE tasks SET deleted_at=NULL WHERE id=$1`, task.ID)
	mustQueryExec(t, db, `UPDATE projects SET deleted_at=now() WHERE id=$1`, project.ID)
	assertMissing(project.ID, task.ID)
	mustQueryExec(t, db, `UPDATE projects SET deleted_at=NULL WHERE id=$1`, project.ID)
	completion, err = check(project.ID, "invalid-uuid")
	var driver *pgconn.PgError
	if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &driver) || driver.Code != "22P02" {
		t.Fatalf("task lock failure: %+v %v", completion, err)
	}
	mustQueryExec(t, db, `ALTER TABLE projects RENAME COLUMN deleted_at TO hidden_deleted_at`)
	completion, err = check(project.ID, task.ID)
	if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &driver) || driver.Code != "42703" {
		t.Fatalf("lifecycle read failure: %+v %v", completion, err)
	}
}

func TestPrivateTransferProjectLifecycleSerializesProjectDeletion(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, deletionFirst := range []bool{false, true} {
		t.Run(fmt.Sprintf("deletion-first=%t", deletionFirst), func(t *testing.T) {
			f := attachmentWitnessFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer files.Close()
			record := transferRecord(f.user, time.Now().UTC())
			record.ProjectID, record.TaskID = f.project, f.task
			if _, err := f.database.WritePrivateTransfer(ctx, func(dao store.PrivateTransferDAO) error {
				var err error
				record, _, err = transfercore.Create(ctx, dao, record)
				if err != nil {
					return err
				}
				record, err = transfercore.Reserve(ctx, dao, record.ID, 5, 100)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			namespace, err := filestorage.NewTransferNamespace(record.ID)
			if err != nil {
				t.Fatal(err)
			}
			chunk := model.UploadChunk{TransferID: record.ID, ChunkID: uuid.NewString(), ObjectID: uuid.NewString(), Size: 5, SHA256: fmt.Sprintf("%x", sha256.Sum256([]byte("chunk")))}
			reached := make(chan struct{})
			release, resume := attachmentWitnessPause(t)
			defer resume()
			pause := func() error {
				close(reached)
				select {
				case <-release:
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			write := func() error {
				_, err := f.database.WritePrivateTransfer(ctx, func(dao store.PrivateTransferDAO) error {
					current, err := dao.Get(ctx, record.ID)
					if err != nil {
						return err
					}
					if err := dao.LockProjectLifecycle(ctx, f.project, f.task); err != nil {
						return err
					}
					if !deletionFirst {
						if err := pause(); err != nil {
							return err
						}
					}
					if _, err := files.PutTransfer(ctx, namespace, chunk.ObjectID, strings.NewReader("chunk")); err != nil {
						return err
					}
					if err := dao.InsertUploadChunk(ctx, chunk); err != nil {
						return err
					}
					current, err = transfercore.ConsumeReservation(ctx, dao, record.ID, chunk.Size, current.Version)
					if err != nil {
						return err
					}
					current.Data = []byte(`{"receipt":"confirmed"}`)
					_, err = dao.Put(ctx, current, current.Version)
					return err
				})
				return err
			}
			remove := func() error {
				return attachmentWitnessDelete(ctx, f, true, func() error {
					if deletionFirst {
						return pause()
					}
					return nil
				})
			}
			var mutation, deletion <-chan error
			if deletionFirst {
				deletion = attachmentWitnessAsync(t, ctx, remove)
			} else {
				mutation = attachmentWitnessAsync(t, ctx, write)
			}
			attachmentWitnessWait(t, ctx, reached)
			var blocker int32
			query := `SELECT pid FROM pg_stat_activity WHERE application_name=current_schema() AND state='idle in transaction' AND query LIKE 'SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1%'`
			if deletionFirst {
				query = `SELECT pid FROM pg_stat_activity WHERE application_name=current_schema() AND state='idle in transaction' AND query LIKE 'DELETE FROM project_github_pending_prs%'`
			}
			if err := f.database.Pool.QueryRow(ctx, query).Scan(&blocker); err != nil {
				t.Fatal(err)
			}
			if deletionFirst {
				mutation = attachmentWitnessAsync(t, ctx, write)
			} else {
				deletion = attachmentWitnessAsync(t, ctx, remove)
			}
			attachmentWitnessBlocked(t, ctx, f.database, blocker)
			resume()
			mutationErr := attachmentWitnessResult(t, ctx, mutation)
			if err := attachmentWitnessResult(t, ctx, deletion); err != nil {
				t.Fatal(err)
			}
			if deletionFirst && !errors.Is(mutationErr, model.ErrNotFound) || !deletionFirst && mutationErr != nil {
				t.Fatalf("chunk outcome after lifecycle ordering: %v", mutationErr)
			}
			var count int
			var reserved, outstanding int64
			if err := f.database.Pool.QueryRow(ctx, `SELECT reserved_bytes,outstanding_bytes,(SELECT count(*) FROM private_upload_chunks WHERE transfer_id=$1) FROM private_transfers WHERE id=$1`, record.ID).Scan(&reserved, &outstanding, &count); err != nil {
				t.Fatal(err)
			}
			object, openErr := files.OpenTransfer(ctx, namespace, chunk.ObjectID)
			if deletionFirst {
				if !errors.Is(openErr, fs.ErrNotExist) || count != 0 || reserved != 5 || outstanding != 5 {
					t.Fatalf("deleted Project admitted a chunk: file=%v receipts=%d reservation=%d/%d", openErr, count, reserved, outstanding)
				}
			} else {
				if openErr != nil {
					t.Fatal(openErr)
				}
				content, readErr := io.ReadAll(object.Body)
				closeErr := object.Body.Close()
				if readErr != nil || closeErr != nil || string(content) != "chunk" || count != 1 || reserved != 5 || outstanding != 0 {
					t.Fatalf("ordered chunk did not persist: content=%q read=%v close=%v receipts=%d reservation=%d/%d", content, readErr, closeErr, count, reserved, outstanding)
				}
			}
		})
	}
}

// A real server-side cancellation while the historical Task lock is pending
// exercises the row stream failure after Project and graph locks are acquired.
func projectDeletionTaskLockCancellationRollsBack(t *testing.T, database *Store) {
	db := database
	_, _, project := testutil.ProjectMembershipFixture(t, db)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	taskID := uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title,deleted_at) VALUES($1,$2,'historical',statement_timestamp())`, taskID, project.ID)
	var epoch string
	if err := db.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	blocker, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	type deletionResult struct {
		completion store.Completion
		err        error
		called     bool
	}
	results := make(chan deletionResult, 1)
	operationCtx, stopOperation := context.WithCancel(ctx)
	var probe pgx.Tx
	launched, drained := false, false
	defer func() {
		stopOperation()
		cleanup, stop := context.WithTimeout(context.Background(), cleanupTimeout)
		defer stop()
		if probe != nil {
			if err := probe.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
				t.Errorf("cleanup probe: %v", err)
			}
		}
		if err := blocker.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("cleanup Task blocker: %v", err)
		}
		if launched && !drained {
			select {
			case <-results:
			case <-cleanup.Done():
				t.Errorf("cleanup deletion goroutine: %v", cleanup.Err())
			}
		}
	}()
	if _, err = blocker.Exec(ctx, `SELECT id FROM tasks WHERE id=$1 FOR UPDATE`, taskID); err != nil {
		t.Fatal(err)
	}
	launched = true
	go func() {
		called := false
		completion, err := db.WriteProjectDeletion(operationCtx, project.ID, func(store.ProjectDeletionScope) error { called = true; return nil })
		results <- deletionResult{completion: completion, err: err, called: called}
	}()
	waitTransferTeamLock(t, ctx, db, "WITH goals AS (SELECT id FROM tasks WHERE project_id=", blocker.Conn().PgConn().PID())
	var pid int32
	if err = db.Pool.QueryRow(ctx, `SELECT pid FROM pg_stat_activity WHERE application_name=current_schema() AND wait_event_type='Lock' AND query LIKE 'WITH goals AS (SELECT id FROM tasks WHERE project_id=%' AND $1=ANY(pg_blocking_pids(pid))`, blocker.Conn().PgConn().PID()).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	var canceled bool
	if err = db.Pool.QueryRow(ctx, `SELECT pg_cancel_backend($1)`, pid).Scan(&canceled); err != nil || !canceled {
		t.Fatalf("cancel task lock: %v %v", canceled, err)
	}
	var result deletionResult
	select {
	case result = <-results:
		drained = true
	case <-ctx.Done():
		t.Fatal("deletion did not stop after cancellation")
	}
	var driver *pgconn.PgError
	if result.called || result.completion.Outcome != store.TransactionNotCommitted || !errors.As(result.err, &driver) || driver.Code != "57014" {
		t.Fatalf("canceled task scan: callback=%v completion=%+v error=%v", result.called, result.completion, result.err)
	}
	var live bool
	var after string
	if err = db.Pool.QueryRow(ctx, `SELECT deleted_at IS NULL,task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&live, &after); err != nil || !live || after != epoch {
		t.Fatalf("canceled deletion changed Project: live=%v epoch=%s error=%v", live, after, err)
	}
	probe, err = db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = probe.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE NOWAIT`, project.ID); err != nil {
		probe.Rollback(ctx)
		t.Fatalf("canceled deletion retained Project lock: %v", err)
	}
	if err = probe.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err = blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	testutil.AssertPoolReusable(t, db.Pool)
}

func projectDeletionPreservesHistoricalRowsAndCommitsRetirement(t *testing.T, database *Store) {
	db := database
	owner, _, project := testutil.ProjectMembershipFixture(t, db)
	ctx := t.Context()
	otherID := uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Unrelated','host:other')`, otherID)
	mustQueryExec(t, db, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, otherID, project.Ownership.TeamID)
	mustQueryExec(t, db, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, otherID, owner.UserID)
	var otherBefore string
	if err := db.Pool.QueryRow(ctx, `SELECT to_jsonb(p)::text FROM projects p WHERE id=$1`, otherID).Scan(&otherBefore); err != nil {
		t.Fatal(err)
	}
	task, dependency, sid := uuid.NewString(), uuid.NewString(), uuid.NewString()
	exec := func(sql string, args ...any) { t.Helper(); mustQueryExec(t, db, sql, args...) }
	exec(`INSERT INTO tasks(id,project_id,title,status,version,started_at) VALUES($1,$3,'main','in_progress',7,now()),($2,$3,'dependency','done',3,now())`, task, dependency, project.ID)
	exec(`INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`, project.ID, task, dependency)
	exec(`INSERT INTO task_properties(task_id,name,value) VALUES($1,'blocked','false')`, task)
	exec(`INSERT INTO task_thread_messages(task_id,created_at,author_user_id,author_agent,body) VALUES($1,now(),$2,false,'thread history')`, task, owner.UserID)
	exec(`INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,grant_hash,grant_expires_at,connection_expires_at) VALUES($1,$2,$3,$4,$5,$6,'{"name":"history"}','{"lifecycle":"active","controls":{"x":1}}','abc',now()+interval '1 hour',now()+interval '1 hour')`, sid, project.ID, task, uuid.NewString(), owner.UserID, uuid.NewString())
	exec(`INSERT INTO session_events(session_id,event_seq,event) VALUES($1,1,'{"kind":"history"}')`, sid)
	exec(`INSERT INTO session_timeline(session_id,entry_id,entry_seq,revision,entry) VALUES($1,$2,1,1,'{"text":"history"}')`, sid, uuid.NewString())
	exec(`INSERT INTO session_resources(session_id,resource_id,descriptor,content) VALUES($1,$2,'{"name":"resource"}','history')`, sid, uuid.NewString())
	exec(`INSERT INTO session_archives(session_id,state) VALUES($1,'pending')`, sid)
	exec(`INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt) VALUES($1,$2,1,'abc','{"op":"history"}',$3,$4,'session','{"state":"accepted"}')`, sid, uuid.NewString(), owner.UserID, uuid.NewString())

	exec(`INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'history.txt','text/plain',20)`, project.ID, task)
	preserved := func() string {
		t.Helper()
		var result string
		err := db.Pool.QueryRow(ctx, `SELECT jsonb_build_object(
        'project',(SELECT to_jsonb(p)-'deleted_at'-'updated_at'-'task_cache_epoch' FROM projects p WHERE p.id=$1),
        'ownership',(SELECT to_jsonb(o) FROM project_ownership o WHERE o.project_id=$1),
        'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY g.user_id) FROM project_grants g WHERE g.project_id=$1),
        'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM tasks t WHERE t.project_id=$1),
        'properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.task_id,p.name) FROM task_properties p JOIN tasks t ON t.id=p.task_id WHERE t.project_id=$1),
        'deps',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.task_id,d.depends_on_task_id) FROM task_dependencies d WHERE d.project_id=$1),
        'attachments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.task_id,a.path) FROM task_attachments a WHERE a.project_id=$1),
        'thread',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.task_id,m.message_id) FROM task_thread_messages m JOIN tasks t ON t.id=m.task_id WHERE t.project_id=$1),
        'session',(SELECT to_jsonb(s)-'snapshot'-'grant_hash'-'grant_expires_at'-'connection_expires_at'-'draining_until' FROM task_sessions s WHERE s.id=$2),
        'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.event_seq) FROM session_events e WHERE e.session_id=$2),
        'timeline',(SELECT jsonb_agg(to_jsonb(e) ORDER BY e.entry_seq) FROM session_timeline e WHERE e.session_id=$2),
        'resources',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.resource_id) FROM session_resources r WHERE r.session_id=$2),
        'archives',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.session_id) FROM session_archives a WHERE a.session_id=$2),
        'operations',(SELECT jsonb_agg(to_jsonb(o)-'receipt' ORDER BY o.operation_seq) FROM session_operations o WHERE o.session_id=$2))::text`, project.ID, sid).Scan(&result)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}

	before := preserved()
	var epoch string
	if err := db.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	completion, err := db.WriteProjectDeletion(ctx, project.ID, func(scope store.ProjectDeletionScope) error {
		marked, err := scope.ProjectDAO().MarkDeleted(ctx)
		if err != nil || !marked {
			return fmt.Errorf("mark Project: %t %w", marked, err)
		}
		facts, err := scope.SessionDAO().LockProjectSessions(ctx, project.ID, "", 128)
		if err != nil {
			return err
		}
		if len(facts) != 1 || facts[0].ID != sid || facts[0].Backend != "web" || facts[0].Lifecycle != "active" {
			t.Fatalf("retirement facts: %+v", facts)
		}
		return scope.SessionDAO().ApplyProjectSessionRetirement(ctx, []store.ProjectSessionRetirementPlan{{
			ID: sid, Backend: "web", SnapshotPatch: map[string]any{"lifecycle": "draining"}, SnapshotRemove: []string{"controls"},
			Receipts: []store.ProjectSessionReceiptTransition{{Previous: "accepted", Next: "rejected"}},
		}})
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("deletion completion: %+v %v", completion, err)
	}
	if after := preserved(); after != before {
		t.Fatalf("historical rows changed: before=%s after=%s", before, after)
	}
	var marked, retired bool
	if err := db.Pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL AND task_cache_epoch::text<>$2 FROM projects WHERE id=$1`, project.ID, epoch).Scan(&marked); err != nil || !marked {
		t.Fatalf("Project lifecycle: %t %v", marked, err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT snapshot->>'lifecycle'='draining' AND snapshot->'controls' IS NULL AND grant_hash IS NULL AND grant_expires_at IS NULL AND connection_expires_at IS NULL AND draining_until IS NULL AND (SELECT receipt->>'state'='rejected' FROM session_operations WHERE session_id=$1) FROM task_sessions WHERE id=$1`, sid).Scan(&retired); err != nil || !retired {
		t.Fatalf("Session retirement: %t %v", retired, err)
	}
	var otherAfter string
	if err := db.Pool.QueryRow(ctx, `SELECT to_jsonb(p)::text FROM projects p WHERE id=$1`, otherID).Scan(&otherAfter); err != nil || otherAfter != otherBefore {
		t.Fatalf("unrelated Project changed: before=%s after=%s error=%v", otherBefore, otherAfter, err)
	}
	if err := db.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		p, err := snapshot.ProjectDAO().Project(ctx, otherID)
		if err != nil || p.ID != otherID {
			return fmt.Errorf("unrelated Project read: %+v %w", p, err)
		}
		_, err = snapshot.ProjectDAO().Project(ctx, project.ID)
		if !errors.Is(err, model.ErrNotFound) {
			return fmt.Errorf("deleted Project remained readable: %w", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func waitProjectDeletionWitnessBlock(t *testing.T, ctx context.Context, database *Store, blocker uint32) uint32 {
	t.Helper()
	for {
		var pid uint32
		err := database.Pool.QueryRow(ctx, `SELECT coalesce((SELECT pid FROM pg_stat_activity
 WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) LIMIT 1),0)`, blocker).Scan(&pid)
		if err != nil {
			t.Fatal(err)
		}
		if pid != 0 {
			return pid
		}
		if err := waitThreadClock(ctx); err != nil {
			t.Fatalf("no observed waiter for backend %d: %v", blocker, err)
		}
	}
}

func projectDeletionOrdersClaimAndThread(t *testing.T, database *Store) {
	taskNumber := 2000
	for _, operation := range []string{"claim", "thread"} {
		for _, deletionFirst := range []bool{false, true} {
			for _, taskDeleted := range []bool{false, true} {
				if taskDeleted && (operation != "thread" || !deletionFirst) {
					continue
				}
				taskNumber++
				if !t.Run(fmt.Sprintf("%s/deletion-first=%t/deleted-task=%t", operation, deletionFirst, taskDeleted), func(t *testing.T) {
					principal, _, project := testutil.ProjectMembershipFixture(t, database)
					task := queryTask(t, database, project.ID, taskNumber, model.TaskTodo)
					if taskDeleted {
						mustQueryExec(t, database, `UPDATE tasks SET deleted_at=clock_timestamp() WHERE id=$1`, task.ID)
					}
					ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
					defer cancel()
					table, event, column, id := "projects", "UPDATE OF deleted_at", "id", project.ID
					if !deletionFirst && operation == "claim" {
						table, event, column, id = "task_properties", "INSERT", "task_id", task.ID
					} else if !deletionFirst {
						table, event, column, id = "task_thread_messages", "INSERT", "task_id", task.ID
					}
					const trigger = "block_project_deletion_witness"
					t.Cleanup(func() {
						cleanup, stop := context.WithTimeout(context.Background(), cleanupTimeout)
						defer stop()
						if _, err := database.Pool.Exec(cleanup, "DROP TRIGGER IF EXISTS "+trigger+" ON "+table+"; DROP FUNCTION IF EXISTS "+trigger+"()"); err != nil {
							t.Errorf("remove deletion witness fault: %v", err)
							return
						}
						if err := checkFaultTriggerRemoved(cleanup, database, trigger, table); err != nil {
							t.Error(err)
						}
					})
					target := fmt.Sprintf("BEFORE %s ON %s FOR EACH ROW WHEN (NEW.%s='%s'::uuid)", event, table, column, id)
					mustQueryExec(t, database, `CREATE FUNCTION block_project_deletion_witness() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN PERFORM pg_advisory_xact_lock(13629020); RETURN NEW; END $$;
 CREATE TRIGGER block_project_deletion_witness `+target+` EXECUTE FUNCTION block_project_deletion_witness()`)
					locker, err := database.Pool.Begin(ctx)
					if err != nil {
						t.Fatal(err)
					}
					var writers sync.WaitGroup
					defer func() {
						cancel()
						cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
						defer stop()
						if err := locker.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
							t.Errorf("release deletion witness lock: %v", err)
						}
						finished := make(chan struct{})
						go func() { writers.Wait(); close(finished) }()
						select {
						case <-finished:
						case <-cleanup.Done():
							t.Errorf("drain deletion witnesses: %v", cleanup.Err())
						}
					}()
					if _, err := locker.Exec(ctx, `SELECT pg_advisory_xact_lock(13629020)`); err != nil {
						t.Fatal(err)
					}
					activeClaim := errors.New("fresh deletion scope observed active worker claim")
					mutation, deletion := make(chan error, 1), make(chan error, 1)
					startMutation := func() {
						writers.Go(func() {
							if operation == "thread" {
								_, _, err := threadWitnessAppend(ctx, database, principal, project.ID, task.ID, "retained message", nil)
								mutation <- err
								return
							}
							_, err := database.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
								current, err := scope.TaskDAO().Task(ctx, task.ID)
								if err != nil {
									return err
								}
								claim := &model.WorkerClaim{ClaimID: uuid.NewString(), UserID: principal.UserID, WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "worker"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString(), Phase: model.WorkerExecuting, State: model.WorkerActive, ClaimedAt: current.CreatedAt}
								_, err = scope.TaskDAO().UpdateTask(ctx, task.ID, store.TaskWrite{Title: current.Title, Description: current.Description, AssignedTo: current.AssignedTo,
									RequiredPlatform: current.RequiredPlatform, AllowAgents: current.AllowAgents, Status: model.TaskInProgress,
									DependsOn: current.DependsOn, ExternalDependsOn: current.ExternalDependsOn, Properties: fixtureTaskProperties(t, claim)})
								return err
							})
							mutation <- err
						})
					}
					startDeletion := func() {
						writers.Go(func() {
							_, err := database.WriteProjectDeletion(ctx, project.ID, func(scope store.ProjectDeletionScope) error {
								if _, err := scope.ProjectDAO().Authorization(ctx, principal); err != nil {
									return err
								}
								if err := scope.ProjectDAO().VisitTaskWorkers(ctx, func(item store.ProjectDeletionWorker) error {
									if item.Worker != nil && item.Worker.State == model.WorkerActive {
										return activeClaim
									}
									return nil
								}); err != nil {
									return err
								}
								marked, err := scope.ProjectDAO().MarkDeleted(ctx)
								if err == nil && !marked {
									return errors.New("locked live Project was not marked")
								}
								return err
							})
							deletion <- err
						})
					}
					if deletionFirst {
						startDeletion()
					} else {
						startMutation()
					}
					firstPID := waitProjectDeletionWitnessBlock(t, ctx, database, locker.Conn().PgConn().PID())
					if deletionFirst {
						startMutation()
					} else {
						startDeletion()
					}
					waitProjectDeletionWitnessBlock(t, ctx, database, firstPID)
					if err := locker.Rollback(ctx); err != nil {
						t.Fatal(err)
					}
					mutationErr := receiveQueryResult(t, ctx, mutation)
					deletionErr := receiveQueryResult(t, ctx, deletion)
					writers.Wait()
					mustQueryExec(t, database, "DROP TRIGGER "+trigger+" ON "+table+"; DROP FUNCTION "+trigger+"()")
					assertFaultTriggerRemoved(t, database, trigger, table)
					if deletionFirst {
						if deletionErr != nil || !errors.Is(mutationErr, model.ErrNotFound) {
							t.Fatalf("deletion did not exclude later mutation: deletion=%v mutation=%v", deletionErr, mutationErr)
						}
					} else if operation == "claim" {
						if mutationErr != nil || !errors.Is(deletionErr, activeClaim) {
							t.Fatalf("deletion missed fresh claim: mutation=%v deletion=%v", mutationErr, deletionErr)
						}
					} else if mutationErr != nil || deletionErr != nil {
						t.Fatalf("thread lock direction prevented completion: mutation=%v deletion=%v", mutationErr, deletionErr)
					}
					if operation == "thread" {
						var count int
						want := 1
						if deletionFirst {
							want = 0
						}
						if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM task_thread_messages WHERE task_id=$1`, task.ID).Scan(&count); err != nil || count != want {
							t.Fatalf("retained thread count=%d want=%d: %v", count, want, err)
						}
					} else {
						var version int64
						var worker bool
						want := task.Version + 1
						if deletionFirst {
							want = task.Version
						}
						if err := database.Pool.QueryRow(ctx, `SELECT version,EXISTS(SELECT 1 FROM task_properties WHERE task_id=$1 AND name='worker') FROM tasks WHERE id=$1`, task.ID).Scan(&version, &worker); err != nil || worker == deletionFirst || version != want {
							t.Fatalf("claim escaped transaction order: version=%d worker=%v error=%v", version, worker, err)
						}
					}
				}) {
					return
				}
				testutil.AssertPoolReusable(t, database.Pool)
			}
		}
	}
}

func projectDeletionWaitingStatementUsesOldProjectSnapshot(t *testing.T, database *Store) {
	_, _, project := testutil.ProjectMembershipFixture(t, database)
	task := queryTask(t, database, project.ID, 1000, model.TaskTodo)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	deletion, err := database.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	var waiter pgx.Tx
	var launched, drained bool
	result := make(chan error, 1)
	defer func() {
		cancel()
		cleanup, stop := context.WithTimeout(context.Background(), cleanupTimeout)
		defer stop()
		if err := deletion.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("release deletion transaction: %v", err)
		}
		if launched && !drained {
			select {
			case <-result:
			case <-cleanup.Done():
				t.Errorf("drain waiting statement: %v", cleanup.Err())
				return
			}
		}
		if waiter != nil {
			if err := waiter.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
				t.Errorf("release waiting transaction: %v", err)
			}
		}
	}()
	for _, sql := range []string{`SELECT id FROM projects WHERE id=$1 FOR UPDATE`, `SELECT id FROM tasks WHERE project_id=$1 FOR UPDATE`, `UPDATE projects SET deleted_at=statement_timestamp() WHERE id=$1`} {
		if _, err := deletion.Exec(ctx, sql, project.ID); err != nil {
			t.Fatal(err)
		}
	}
	waiter, err = database.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	launched = true
	go func() {
		var selected bool
		err := waiter.QueryRow(ctx, `SELECT p.deleted_at IS NULL FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1 AND p.deleted_at IS NULL FOR SHARE OF t`, task.ID).Scan(&selected)
		if err == nil && !selected {
			err = errors.New("waiting statement missed the original live Project snapshot")
		}
		result <- err
	}()
	waitProjectDeletionWitnessBlock(t, ctx, database, deletion.Conn().PgConn().PID())
	if err := deletion.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		drained = true
		if err != nil {
			t.Fatalf("waiting statement: %v", err)
		}
	case <-ctx.Done():
		t.Fatalf("waiting statement did not finish: %v", ctx.Err())
	}
	var live bool
	if err := waiter.QueryRow(ctx, `SELECT deleted_at IS NULL FROM projects WHERE id=$1`, project.ID).Scan(&live); err != nil || live {
		t.Fatalf("fresh statement retained old Project: live=%v error=%v", live, err)
	}
}

func projectDeletionAuthorizationAfterTransferAndReturn(t *testing.T, database *Store) {
	original, other, project := testutil.ProjectMembershipFixture(t, database)
	ctx := t.Context()
	target, err := testCreateTeam(database, ctx, other.UserID, uuid.NewString(), "Destination")
	if err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project.ID, other.UserID)
	reference := setSnapshotTaskClaim(t, database, project.ID, 2000, original.UserID, uuid.NewString())
	check := func(actor model.Principal, transferable bool) {
		t.Helper()
		completion, err := database.WriteProjectDeletion(ctx, project.ID, func(scope store.ProjectDeletionScope) error {
			access, err := scope.ProjectDAO().Authorization(ctx, actor)
			if err != nil || access.CanTransfer != transferable {
				return fmt.Errorf("fresh deletion authorization: access=%#v transferable=%t error=%w", access, transferable, err)
			}
			count := 0
			if err := scope.ProjectDAO().VisitTaskWorkers(ctx, func(item store.ProjectDeletionWorker) error {
				count++
				if item.TaskID != reference.TaskID || item.Worker == nil || item.Worker.ClaimID != reference.ClaimID || item.Worker.State != model.WorkerActive {
					return fmt.Errorf("fresh worker observation: %#v", item)
				}
				return nil
			}); err != nil {
				return err
			}
			if count != 1 {
				return fmt.Errorf("worker count=%d", count)
			}
			return nil
		})
		if err != nil || completion.Outcome != store.TransactionCommitted {
			t.Fatalf("locked observations: %#v %v", completion, err)
		}
	}
	check(original, true)
	check(other, false)
	mustQueryExec(t, database, `UPDATE project_ownership SET team_id=$2,version=version+1 WHERE project_id=$1`, project.ID, target.ID)
	check(original, false)
	check(other, true)
	mustQueryExec(t, database, `UPDATE project_ownership SET team_id=$2,version=version+1 WHERE project_id=$1`, project.ID, project.Ownership.TeamID)
	check(other, false)
	check(original, true)
	mustQueryExec(t, database, `DELETE FROM task_properties WHERE task_id=$1 AND name='worker'`, reference.TaskID)
	completion, err := database.WriteProjectDeletion(ctx, project.ID, func(scope store.ProjectDeletionScope) error {
		if err := scope.ProjectDAO().VisitTaskWorkers(ctx, func(store.ProjectDeletionWorker) error { return errors.New("released worker remained visible") }); err != nil {
			return err
		}
		marked, err := scope.ProjectDAO().MarkDeleted(ctx)
		if err == nil && !marked {
			return errors.New("Project not marked after worker release")
		}
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("deletion after release: %#v %v", completion, err)
	}
}
