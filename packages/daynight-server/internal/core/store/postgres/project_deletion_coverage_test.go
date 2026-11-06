package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	transfercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestProjectDeletionObservationAndTransactionBoundRetirement(t *testing.T) {
	db, owner, _, project := membershipFixture(t)
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

	task := queryTask(t, db, project.ID, 10, model.TaskTodo)
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

func TestProjectDeletionMarkPreservesDatabaseFailureAndRejectsSecondMark(t *testing.T) {
	db, _, _, project := membershipFixture(t)
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
