package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/reviewassignment"
	"github.com/jackc/pgx/v5"
)

func TestReviewAssignmentLocksAndRollback(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	project := queryProject(t, s, 1).ID
	owner := b2Principal(t, s, project).UserID
	workerID := queryID(20)
	mustQueryExec(t, s, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot,review_enabled) VALUES($1,$2,now(),now(),'{}','{}',true)`, owner, workerID)
	mustQueryExec(t, s, `INSERT INTO project_github(project_id,repository_id) VALUES($1,30)`, project)
	mustQueryExec(t, s, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,30,1,10,'url','title','open',false,'main','sha',now(),now(),now(),1)`, project)
	sentinel := errors.New("rollback")
	completion, err := s.WriteReviewAssignment(ctx, project, func(w store.ReviewAssignmentWrite) error {
		if _, err := w.LockAuthorization(ctx, owner); err != nil {
			return err
		}
		repo, err := w.LockConnection(ctx)
		if err != nil || repo == nil || (repo.RepositoryID == nil || *repo.RepositoryID != 30) {
			return fmt.Errorf("connection: %v %v", repo, err)
		}
		worker, err := w.LockWorker(ctx, owner, workerID)
		if err != nil || !worker.ReviewEnabled {
			return fmt.Errorf("worker: %+v %v", worker, err)
		}
		now, err := w.ObservedAt(ctx)
		if err != nil {
			return err
		}
		pr, err := w.PullRequest(ctx, 30, 1)
		if err != nil || pr == nil || pr.State != "open" {
			return fmt.Errorf("pr: %+v %v", pr, err)
		}
		if inserted, err := w.Insert(ctx, owner, 30, 10, workerID, now); err != nil || !inserted {
			return fmt.Errorf("insert %t %v", inserted, err)
		}
		return sentinel
	})
	if !errors.Is(err, sentinel) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", completion, err)
	}
	var count int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM project_pr_review_assignments`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rolled back %d %v", count, err)
	}
	completion, err = s.WriteReviewAssignment(ctx, project, func(w store.ReviewAssignmentWrite) error {
		_, err := w.LockAuthorization(ctx, queryID(999))
		return err
	})
	if !errors.Is(err, model.ErrNotFound) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("authorization %+v %v", completion, err)
	}
}

func TestReviewAssignmentWorkerLockBlocksChangesUntilCompletion(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	project := queryProject(t, s, 1).ID
	owner := b2Principal(t, s, project).UserID
	workerID := queryID(20)
	mustQueryExec(t, s, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot,review_enabled) VALUES($1,$2,now(),now(),'{}','{}',true)`, owner, workerID)
	mustQueryExec(t, s, `INSERT INTO project_github(project_id,repository_id) VALUES($1,30)`, project)
	held := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		completion, err := s.WriteReviewAssignment(ctx, project, func(w store.ReviewAssignmentWrite) error {
			if _, err := w.LockAuthorization(ctx, owner); err != nil {
				return err
			}
			if _, err := w.LockConnection(ctx); err != nil {
				return err
			}
			if _, err := w.LockWorker(ctx, owner, workerID); err != nil {
				return err
			}
			close(held)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		if err == nil && completion.Outcome != store.TransactionCommitted {
			err = fmt.Errorf("completion %+v", completion)
		}
		done <- err
	}()
	select {
	case <-held:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	updated := make(chan error, 1)
	go func() {
		_, err := s.Pool.Exec(ctx, `UPDATE workers SET review_enabled=false WHERE user_id=$1 AND worker_id=$2`, owner, workerID)
		updated <- err
	}()
	waitForQueryLock(t, s, "UPDATE workers SET review_enabled=false WHERE user_id=$1 AND worker_id=$2")
	close(release)
	if err := receiveQueryResult(t, ctx, done); err != nil {
		t.Fatal(err)
	}
	if err := receiveQueryResult(t, ctx, updated); err != nil {
		t.Fatal(err)
	}
	var enabled bool
	if err := s.Pool.QueryRow(ctx, `SELECT review_enabled FROM workers WHERE user_id=$1 AND worker_id=$2`, owner, workerID).Scan(&enabled); err != nil || enabled {
		t.Fatalf("worker update: %v %v", enabled, err)
	}
}

func TestReviewAssignmentConcurrentWritesPreserveFirstOwner(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	project := queryProject(t, s, 1).ID
	owner := b2Principal(t, s, project).UserID
	results := make(chan bool, 2)
	failures := make(chan error, 2)
	for _, id := range []string{queryID(10), queryID(11)} {
		go func(workerID string) {
			var inserted bool
			completion, err := s.WriteReviewAssignment(ctx, project, func(w store.ReviewAssignmentWrite) error {
				var e error
				inserted, e = w.Insert(ctx, owner, 30, 40, workerID, time.Now())
				return e
			})
			if err != nil {
				failures <- err
				return
			}
			if completion.Outcome != store.TransactionCommitted {
				failures <- fmt.Errorf("completion %+v", completion)
				return
			}
			results <- inserted
		}(id)
	}
	successes := 0
	for range 2 {
		select {
		case inserted := <-results:
			if inserted {
				successes++
			}
		case err := <-failures:
			t.Fatal(err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if successes != 1 {
		t.Fatalf("insert successes: %d", successes)
	}
	var count int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM project_pr_review_assignments WHERE user_id=$1 AND project_id=$2 AND repository_id=30 AND github_pr_id=40`, owner, project).Scan(&count); err != nil || count != 1 {
		t.Fatalf("retained count %d %v", count, err)
	}
}

func TestReviewAssignmentSeesRevocationAfterAuthorizationLockWait(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	project := queryProject(t, s, 1).ID
	owner := b2Principal(t, s, project).UserID
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `DELETE FROM team_members WHERE user_id=$1 AND team_id=(SELECT team_id FROM project_ownership WHERE project_id=$2)`, owner, project); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM project_grants WHERE user_id=$1 AND project_id=$2`, owner, project); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := s.WriteReviewAssignment(ctx, project, func(w store.ReviewAssignmentWrite) error { _, err := w.LockAuthorization(ctx, owner); return err })
		result <- err
	}()
	waitForQueryLock(t, s, "SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2 FOR SHARE")
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = receiveQueryResult(t, ctx, result); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("revocation not observed: %v", err)
	}
}

func TestReviewAssignmentSeesConnectionAndPRAfterProjectLockWait(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	project := queryProject(t, s, 1).ID
	owner := b2Principal(t, s, project).UserID
	mustQueryExec(t, s, `INSERT INTO project_github(project_id,repository_id) VALUES($1,30)`, project)
	mustQueryExec(t, s, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,30,1,10,'url','title','open',false,'main','sha',now(),now(),now(),1)`, project)
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE project_github SET repository_id=31 WHERE project_id=$1`, project); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE project_pull_requests SET state='closed' WHERE project_id=$1 AND repository_id=30 AND number=1`, project); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := s.WriteReviewAssignment(ctx, project, func(w store.ReviewAssignmentWrite) error {
			if _, err := w.LockAuthorization(ctx, owner); err != nil {
				return err
			}
			repo, err := w.LockConnection(ctx)
			if err != nil {
				return err
			}
			if repo == nil || (repo.RepositoryID == nil || *repo.RepositoryID != 31) {
				return fmt.Errorf("stale repository %v", repo)
			}
			pr, err := w.PullRequest(ctx, 30, 1)
			if err != nil {
				return err
			}
			if pr == nil || pr.State != "closed" {
				return fmt.Errorf("stale pr %+v", pr)
			}
			return nil
		})
		result <- err
	}()
	waitForQueryLock(t, s, "SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE")
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = receiveQueryResult(t, ctx, result); err != nil {
		t.Fatal(err)
	}
}

func TestReviewAssignmentUnknownCommitReadbackPreservesOwner(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx := t.Context()
	project := queryProject(t, s, 1).ID
	owner := b2Principal(t, s, project).UserID
	id := queryID(10)
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	lost := errors.New("lost commit response")
	err = transact(ctx, &threadCommitResponseLoss{Tx: tx, cause: lost}, func(tx pgx.Tx) error {
		_, err := reviewassignment.NewWriter(tx, project).Insert(ctx, owner, 30, 40, id, time.Now())
		return err
	})
	var failure *store.TransactionError
	if !errors.As(err, &failure) || failure.Outcome != store.TransactionUnknown || !errors.Is(err, lost) {
		t.Fatalf("unknown %v", err)
	}
	if err := s.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		a, err := sc.(store.ReviewAssignmentSnapshot).ReviewAssignment(ctx, owner, project, 30, 40)
		if err != nil {
			return err
		}
		if a == nil || a.WorkerID != id {
			return fmt.Errorf("readback %+v", a)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	completion, err := s.WriteReviewAssignment(ctx, project, func(w store.ReviewAssignmentWrite) error {
		inserted, err := w.Insert(ctx, owner, 30, 40, queryID(11), time.Now())
		if inserted {
			return errors.New("existing assignment overwritten")
		}
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("re-observation %+v %v", completion, err)
	}
}

func TestReviewAssignmentWriteAdmissionFailures(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	ctx := t.Context()
	project := queryProject(t, db, 1).ID
	deleted := queryProject(t, db, 2).ID
	mustQueryExec(t, db, `UPDATE projects SET deleted_at=statement_timestamp() WHERE id=$1`, deleted)

	for _, tc := range []struct {
		name    string
		project string
	}{
		{"missing", queryID(999)},
		{"deleted", deleted},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			completion, err := db.WriteReviewAssignment(ctx, tc.project, func(store.ReviewAssignmentWrite) error {
				called = true
				return nil
			})
			if called || completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("called=%v completion=%+v err=%v", called, completion, err)
			}
		})
	}

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	called := false
	completion, err := db.WriteReviewAssignment(cancelled, project, func(store.ReviewAssignmentWrite) error {
		called = true
		return nil
	})
	if called || completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled begin: called=%v completion=%+v err=%v", called, completion, err)
	}

	closed := closedStore(t)
	completion, err = closed.WriteReviewAssignment(ctx, project, func(store.ReviewAssignmentWrite) error {
		called = true
		return nil
	})
	var failure *store.Error
	if called || completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &failure) || failure.Phase != "begin review assignment" {
		t.Fatalf("closed pool begin: called=%v completion=%+v err=%v", called, completion, err)
	}
}
