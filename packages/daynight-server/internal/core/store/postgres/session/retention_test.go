package session_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
)

func TestArchiveRetentionPersistence(t *testing.T) {
	db := isolatedStore(t)
	task, id := prepareArchiveSession(t, db)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	first := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	publish := func(at time.Time) {
		t.Helper()
		sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
			if err := dao.SetSessionArchiveReady(ctx, id, archiveHashOf("archive"), 7, "archive/path"); err != nil {
				return err
			}
			return dao.(store.SessionArchiveRetentionDAO).RecordSessionArchiveSuccess(ctx, id, at)
		})
	}
	publish(first)
	publish(first.Add(time.Hour))
	second := uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot)
 SELECT $2,project_id,task_id,$2,owner_user_id,$2,registration,snapshot FROM task_sessions WHERE id=$1`, id, second)
	publicationFailure := errors.New("abort publication")
	publication, publicationErr := db.WriteSession(ctx, func(scope store.SessionScope) error {
		dao := scope.SessionDAO()
		if err := dao.SetSessionArchiveReady(ctx, second, archiveHashOf("second"), 6, "second/path"); err != nil {
			return err
		}
		if err := dao.(store.SessionArchiveRetentionDAO).RecordSessionArchiveSuccess(ctx, second, first); err != nil {
			return err
		}
		return publicationFailure
	})
	if !errors.Is(publicationErr, publicationFailure) || publication.Outcome != store.TransactionNotCommitted {
		t.Fatalf("publication rollback: %+v %v", publication, publicationErr)
	}
	var archiveRows, retentionRows int
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM session_archives WHERE session_id=$1),(SELECT count(*) FROM session_archive_retention WHERE session_id=$1)`, second).Scan(&archiveRows, &retentionRows); err != nil || archiveRows != 0 || retentionRows != 0 {
		t.Fatalf("partial publication: %d %d %v", archiveRows, retentionRows, err)
	}
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if err := dao.SetSessionArchiveReady(ctx, second, archiveHashOf("second"), 6, "second/path"); err != nil {
			return err
		}
		return dao.(store.SessionArchiveRetentionDAO).RecordSessionArchiveSuccess(ctx, second, first.Add(48*time.Hour))
	})
	var secondFirst time.Time
	if err := db.Pool.QueryRow(ctx, `SELECT first_succeeded_at FROM session_archive_retention WHERE session_id=$1`, second).Scan(&secondFirst); err != nil || !secondFirst.Equal(first.Add(48*time.Hour)) {
		t.Fatalf("claims share publication clock: %v %v", secondFirst, err)
	}
	var original store.ArchiveRetention
	read := func() store.ArchiveRetentionFacts {
		t.Helper()
		var facts store.ArchiveRetentionFacts
		completion, err := db.WriteArchiveRetention(ctx, task.ProjectID, func(dao store.ArchiveRetentionDAO) error {
			var err error
			facts, err = dao.ArchiveRetentionFacts(ctx, task.ProjectID, task.ID, id)
			return err
		})
		if err != nil || completion.Outcome != store.TransactionCommitted {
			t.Fatalf("read: %+v %v", completion, err)
		}
		return facts
	}
	facts := read()
	original = facts.Archive
	if original.FirstSucceededAt == nil || !original.FirstSucceededAt.Equal(first) || original.Version != 1 || len(facts.Members) != 1 || facts.Members[0].TaskID != task.ID {
		t.Fatalf("first success: %+v", facts)
	}
	deadline := first.Add(7 * 24 * time.Hour)
	original.ExpiresAt = &deadline
	original.Reason = "scheduled"
	original.Members = facts.Members
	sentinel := errors.New("rollback after retention save")
	completion, err := db.WriteArchiveRetention(ctx, task.ProjectID, func(dao store.ArchiveRetentionDAO) error {
		if _, err := dao.ArchiveRetentionFacts(ctx, task.ProjectID, task.ID, id); err != nil {
			return err
		}
		if _, err := dao.SaveArchiveRetention(ctx, 1, original); err != nil {
			return err
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", completion, err)
	}
	if after := read().Archive; after.ExpiresAt != nil || after.Version != 1 {
		t.Fatalf("rollback persisted: %+v", after)
	}
	completion, err = db.WriteArchiveRetention(ctx, task.ProjectID, func(dao store.ArchiveRetentionDAO) error {
		if _, err := dao.ArchiveRetentionFacts(ctx, task.ProjectID, task.ID, id); err != nil {
			return err
		}
		saved, err := dao.SaveArchiveRetention(ctx, 1, original)
		if err != nil {
			return err
		}
		if saved.Version != 2 || saved.ExpiresAt == nil || !saved.ExpiresAt.Equal(deadline) {
			t.Fatalf("saved: %+v", saved)
		}
		_, err = dao.SaveArchiveRetention(ctx, 1, original)
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "version_conflict" {
			t.Fatalf("stale write: %v", err)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("commit: %+v %v", completion, err)
	}
	if after := read().Archive; after.Version != 2 || !reflect.DeepEqual(after.Members, original.Members) || !after.FirstSucceededAt.Equal(first) {
		t.Fatalf("readback: %+v", after)
	}

	other := queryTask(t, db, task.ProjectID, 3, model.TaskCancelled)
	external := queryTask(t, db, task.ProjectID, 4, model.TaskInProgress)
	mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,false),($1,$3,$4,true)`, task.ProjectID, task.ID, other.ID, external.ID)
	facts = read()
	if len(facts.Members) != 2 {
		t.Fatalf("external member entered chain: %+v", facts.Members)
	}
	mustQueryExec(t, db, `UPDATE tasks SET status='in_progress',version=version+1,cancelled_at=NULL WHERE id=$1`, other.ID)
	facts = read()
	var reopened bool
	for _, m := range facts.Members {
		if m.TaskID == other.ID {
			reopened = m.Status == "in_progress" && m.Version == other.Version+1 && m.CancelledAt == nil
		}
	}
	if !reopened {
		t.Fatalf("stale member: %+v", facts.Members)
	}
	mustQueryExec(t, db, `DELETE FROM task_dependencies WHERE task_id=$1`, task.ID)
	if facts = read(); len(facts.Members) != 1 {
		t.Fatalf("detached member retained: %+v", facts.Members)
	}

	missing := uuid.NewString()
	_, err = db.WriteArchiveRetention(ctx, task.ProjectID, func(dao store.ArchiveRetentionDAO) error {
		_, err := dao.ArchiveRetentionFacts(ctx, missing, task.ID, id)
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("cross-project accepted: %v", err)
	}
	_, err = db.WriteArchiveRetention(ctx, task.ProjectID, func(dao store.ArchiveRetentionDAO) error {
		_, err := dao.ArchiveRetentionFacts(ctx, task.ProjectID, missing, id)
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("wrong task accepted: %v", err)
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	_, err = db.WriteArchiveRetention(canceled, task.ProjectID, func(store.ArchiveRetentionDAO) error { t.Fatal("canceled writer called callback"); return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %v", err)
	}
	_, err = db.WriteArchiveRetention(ctx, task.ProjectID, func(dao store.ArchiveRetentionDAO) error {
		_, err := dao.ArchiveRetentionFacts(canceled, task.ProjectID, task.ID, id)
		return err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("facts cancellation: %v", err)
	}
	_, err = db.WriteArchiveRetention(ctx, task.ProjectID, func(dao store.ArchiveRetentionDAO) error {
		_, err := dao.SaveArchiveRetention(canceled, 2, original)
		return err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("save cancellation: %v", err)
	}
	mustQueryExec(t, db, `UPDATE session_archive_retention SET members='{}' WHERE session_id=$1`, id)
	_, err = db.WriteArchiveRetention(ctx, task.ProjectID, func(dao store.ArchiveRetentionDAO) error {
		_, err := dao.ArchiveRetentionFacts(ctx, task.ProjectID, task.ID, id)
		return err
	})
	if err == nil {
		t.Fatal("invalid stored members silently accepted")
	}
	mustQueryExec(t, db, `UPDATE session_archive_retention SET members='[]',expired_at=$2 WHERE session_id=$1`, id, first)
	_, err = db.WriteArchiveRetention(ctx, task.ProjectID, func(dao store.ArchiveRetentionDAO) error {
		_, err := dao.SaveArchiveRetention(ctx, 2, original)
		return err
	})
	var expiredFault *model.Fault
	if !errors.As(err, &expiredFault) || expiredFault.Code != "version_conflict" {
		t.Fatalf("expired record revived: %v", err)
	}
}

func TestArchiveRetentionWaitsForGraphTransaction(t *testing.T) {
	db := isolatedStore(t)
	task, id := prepareArchiveSession(t, db)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if err := dao.SetSessionArchiveReady(ctx, id, archiveHashOf("archive"), 7, "archive/path"); err != nil {
			return err
		}
		return dao.(store.SessionArchiveRetentionDAO).RecordSessionArchiveSuccess(ctx, id, time.Now())
	})
	blocker, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	var locked string
	if err := blocker.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 FOR UPDATE`, task.ProjectID).Scan(&locked); err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.Exec(ctx, `UPDATE tasks SET status='in_progress',completed_at=NULL,version=version+1 WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var facts store.ArchiveRetentionFacts
	var completion store.Completion
	var readErr error
	go func() {
		defer close(done)
		completion, readErr = db.WriteArchiveRetention(ctx, task.ProjectID, func(dao store.ArchiveRetentionDAO) error {
			var err error
			facts, err = dao.ArchiveRetentionFacts(ctx, task.ProjectID, task.ID, id)
			return err
		})
	}()
	defer func() { cancel(); _ = blocker.Rollback(context.Background()); <-done }()
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR SHARE", blocker.Conn().PgConn().PID())
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	<-done
	if readErr != nil || completion.Outcome != store.TransactionCommitted || len(facts.Members) != 1 || facts.Members[0].Status != "in_progress" || facts.Members[0].CompletedAt != nil || facts.Members[0].Version != task.Version+1 {
		t.Fatalf("stale graph after wait: %+v %+v %v", facts, completion, readErr)
	}
}
