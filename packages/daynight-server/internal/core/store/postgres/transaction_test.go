package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestReadSnapshotCommitCancellationRetainsUnknownOutcome(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	for _, missing := range []bool{false, true} {
		name := "existing"
		if missing {
			name = "missing"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			attempted := false
			traced := taskMutationTracedStore(t, database, taskMutationTrace{match: func(sql string) bool {
				if strings.EqualFold(strings.TrimSpace(sql), "commit") {
					attempted = true
					return true
				}
				return false
			}, cancel: cancel})
			callbackDone := false
			err := traced.ReadSnapshot(ctx, func(scope SnapshotScope) error {
				id := project.ID
				if missing {
					id = queryID(999)
				}
				_, err := scope.ProjectDAO().Project(ctx, id)
				if missing && !errors.Is(err, model.ErrNotFound) || !missing && err != nil {
					return err
				}
				callbackDone = true
				return nil
			})
			var completion *TransactionError
			var databaseError *Error
			if !callbackDone || !attempted || !errors.Is(err, context.Canceled) || !errors.As(err, &completion) || !completion.CommitAttempted || completion.Outcome != TransactionUnknown || !errors.As(err, &databaseError) || databaseError.Unwrap() == nil {
				t.Fatalf("snapshot commit lost typed completion or original cause: callback=%t attempted=%t completion=%+v error=%v", callbackDone, attempted, completion, err)
			}
			assertMigrationPoolReusable(t, traced.Pool)
		})
	}
}

// interruptObservedQuery verifies that the request context interrupts an actual
// database operation, rather than expiring during pool acquisition or BEGIN.
// A nil cancel waits for ctx's deadline; otherwise cancel is called only after
// PostgreSQL reports the query as active.
func interruptObservedQuery(t *testing.T, ctx context.Context, cancel context.CancelFunc, observer *pgxpool.Conn, tx pgx.Tx) error {
	t.Helper()
	pid := tx.Conn().PgConn().PID()
	observed := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			var active bool
			err := observer.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND state='active' AND query='SELECT pg_sleep(30)')`, pid).Scan(&active)
			if err != nil {
				observed <- fmt.Errorf("observe running query: %w", err)
				return
			}
			if active {
				if cancel != nil {
					cancel()
				}
				observed <- nil
				return
			}
			select {
			case <-ticker.C:
			case <-ctx.Done():
				observed <- fmt.Errorf("query was not observed before interruption: %w", ctx.Err())
				return
			}
		}
	}()
	_, err := tx.Exec(ctx, "SELECT pg_sleep(30)")
	if observeErr := <-observed; observeErr != nil {
		t.Fatal(observeErr)
	}
	return err
}

func cancellationObserver(t *testing.T, ctx context.Context, pool *pgxpool.Pool) *pgxpool.Conn {
	t.Helper()
	observer, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(observer.Release)
	return observer
}

func TestTransactRollbackSurvivesCancellation(t *testing.T) {
	pool := emptyPool(t)
	if _, err := pool.Exec(context.Background(), "CREATE TABLE rollback_marker (id int)"); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "INSERT INTO rollback_marker VALUES (1)"); err != nil {
			return err
		}
		cancel()
		return context.Canceled
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation cause lost: %v", err)
	}
	var count int
	if err := pool.QueryRow(context.Background(), "SELECT count(*) FROM rollback_marker").Scan(&count); err != nil || count != 0 {
		t.Fatalf("canceled write persisted: %d, %v", count, err)
	}
	assertMigrationPoolReusable(t, pool)
}

func TestReadOnlySnapshotWaitsForCanceledConnectionCleanup(t *testing.T) {
	pool := emptyPool(t)
	bounded, stop := context.WithTimeout(context.Background(), 30*time.Second)
	defer stop()
	observer := cancellationObserver(t, bounded, pool)
	ctx, cancel := context.WithCancel(bounded)
	defer cancel()
	err := ReadOnlySnapshot(ctx, pool, func(tx pgx.Tx) error { return interruptObservedQuery(t, ctx, cancel, observer, tx) })
	observer.Release()
	var failure *TransactionError
	if !errors.As(err, &failure) || failure.Phase != "operation" || failure.CommitAttempted || failure.CleanupFailed || failure.Outcome != TransactionNotCommitted || !errors.Is(err, context.Canceled) || !errors.Is(err, pgconn.ErrConnClosed) {
		t.Fatalf("canceled read snapshot: %#v %v", failure, err)
	}
	if failed, state := DatabaseErrorFacts(err); failed {
		t.Fatalf("confirmed connection cleanup became a database failure: %q %v", state, err)
	}
	assertMigrationPoolReusable(t, pool)
}

func TestReadOnlySnapshotPreservesAdditionalCleanupFailure(t *testing.T) {
	pool := emptyPool(t)
	bounded, stop := context.WithTimeout(context.Background(), 30*time.Second)
	defer stop()
	observer := cancellationObserver(t, bounded, pool)
	tx, err := pool.BeginTx(bounded, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(bounded, 250*time.Millisecond)
	defer cancel()
	cleanup := errors.New("extra cleanup failure")
	err = transactReadOnly(ctx, &rollbackFailureTx{Tx: tx, failure: cleanup}, func(tx pgx.Tx) error { return interruptObservedQuery(t, ctx, nil, observer, tx) })
	observer.Release()
	var failure *TransactionError
	if !errors.As(err, &failure) || failure.Phase != "cleanup" || !failure.CleanupFailed || !errors.Is(err, context.DeadlineExceeded) || !errors.Is(err, pgconn.ErrConnClosed) || !errors.Is(err, cleanup) {
		t.Fatalf("additional cleanup failure lost: %#v %v", failure, err)
	}
	if failed, _ := DatabaseErrorFacts(err); !failed {
		t.Fatal("additional cleanup failure was not classified as a database failure")
	}
	assertMigrationPoolReusable(t, pool)
}

func TestReadOnlySnapshotRetainsDatabaseFailureAfterCanceledConnection(t *testing.T) {
	pool := emptyPool(t)
	bounded, stop := context.WithTimeout(context.Background(), 30*time.Second)
	defer stop()
	observer := cancellationObserver(t, bounded, pool)
	ctx, cancel := context.WithCancel(bounded)
	defer cancel()
	driver := &pgconn.PgError{Code: "23505", Message: "private"}
	err := ReadOnlySnapshot(ctx, pool, func(tx pgx.Tx) error {
		return errors.Join(interruptObservedQuery(t, ctx, cancel, observer, tx), driver)
	})
	observer.Release()
	var failure *TransactionError
	failed, state := DatabaseErrorFacts(err)
	if !failed || state != driver.Code || !errors.As(err, &failure) || failure.Phase != "operation" || failure.CleanupFailed || failure.Outcome != TransactionNotCommitted || !errors.Is(err, context.Canceled) || !errors.Is(err, pgconn.ErrConnClosed) || !errors.Is(err, driver) {
		t.Fatalf("canceled read lost database failure or completion facts: %#v %v", failure, err)
	}
	assertMigrationPoolReusable(t, pool)
}

func TestTransactPreservesOperationAndCleanupFailures(t *testing.T) {
	pool := emptyPool(t)
	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	primary, cleanup := errors.New("operation failed"), errors.New("rollback failed")
	wrapped := &rollbackFailureTx{Tx: tx, failure: cleanup}
	err = transact(context.Background(), wrapped, func(pgx.Tx) error { return primary })
	if !errors.Is(err, primary) || !errors.Is(err, cleanup) {
		t.Fatalf("transaction failure chain: %v", err)
	}
	if !wrapped.bounded {
		t.Fatal("rollback did not use a fresh bounded context")
	}
	assertMigrationPoolReusable(t, pool)
}

func TestTransactRollbackOnPanic(t *testing.T) {
	pool := emptyPool(t)
	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	func() {
		defer func() {
			if recovered := recover(); recovered != "operation panic" {
				t.Fatalf("panic propagation: %v", recovered)
			}
		}()
		_ = transact(context.Background(), tx, func(pgx.Tx) error { panic("operation panic") })
	}()
	assertMigrationPoolReusable(t, pool)
}

func TestTransactDoesNotSuppressJoinedClosedRollbackFailure(t *testing.T) {
	pool := emptyPool(t)
	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	cleanup := errors.New("rollback diagnostic failed")
	err = transact(context.Background(), &rollbackFailureTx{Tx: tx, failure: cleanup}, func(pgx.Tx) error { return nil })
	if !errors.Is(err, cleanup) || !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("joined closed-transaction error was suppressed: %v", err)
	}
	assertMigrationPoolReusable(t, pool)
}

type rollbackFailureTx struct {
	pgx.Tx
	failure error
	bounded bool
}

func (tx *rollbackFailureTx) Rollback(ctx context.Context) error {
	deadline, present := ctx.Deadline()
	tx.bounded = ctx.Err() == nil && present && time.Until(deadline) > 0 && time.Until(deadline) <= cleanupTimeout
	return errors.Join(tx.Tx.Rollback(ctx), tx.failure)
}

func TestTransactCommitKnownnessUsesActualDatabaseCompletion(t *testing.T) {
	pool := emptyPool(t)
	if _, err := pool.Exec(context.Background(), "CREATE TABLE commit_marker (id int)"); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	lost := errors.New("commit response lost")
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	err = transact(ctx, &threadCommitResponseLoss{Tx: tx, cause: lost}, func(tx pgx.Tx) error { _, err := tx.Exec(ctx, "INSERT INTO commit_marker VALUES(1)"); return err })
	var failure *TransactionError
	if !errors.As(err, &failure) || failure.Phase != "commit" || failure.Outcome != TransactionUnknown || !failure.CommitAttempted || failure.CleanupFailed || !errors.Is(err, lost) {
		t.Fatalf("unknown commit: %#v %v", failure, err)
	}
	if failure.Error() != "transaction commit failed" {
		t.Fatal("transaction diagnostic exposed its cause")
	}
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM commit_marker").Scan(&count); err != nil || count != 1 {
		t.Fatalf("lost receipt did not retain actual commit: %d %v", count, err)
	}
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error { _, _ = tx.Exec(ctx, "SELECT 1/0"); return nil })
	if !errors.As(err, &failure) || failure.Outcome != TransactionNotCommitted || !failure.CommitAttempted || !errors.Is(err, pgx.ErrTxCommitRollback) {
		t.Fatalf("explicit rollback: %#v %v", failure, err)
	}
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cleanup := errors.New("postcommit cleanup error")
	err = transact(ctx, &rollbackFailureTx{Tx: tx, failure: cleanup}, func(tx pgx.Tx) error { _, err := tx.Exec(ctx, "INSERT INTO commit_marker VALUES(2)"); return err })
	if !errors.As(err, &failure) || failure.Outcome != TransactionCommitted || failure.Phase != "cleanup" || !failure.CleanupFailed || !errors.Is(err, cleanup) {
		t.Fatalf("successful commit changed classification: %#v %v", failure, err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM commit_marker").Scan(&count); err != nil || count != 2 {
		t.Fatalf("postcommit cleanup undid actual commit: %d %v", count, err)
	}
}

func TestTransactCancellationBeforeCommitIsConfirmedRollback(t *testing.T) {
	pool := emptyPool(t)
	tx, err := pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	err = transact(ctx, tx, func(pgx.Tx) error { cancel(); return nil })
	var failure *TransactionError
	if !errors.As(err, &failure) || failure.Phase != "operation" || failure.CommitAttempted || failure.Outcome != TransactionNotCommitted || !errors.Is(err, context.Canceled) {
		t.Fatalf("precommit cancellation: %#v %v", failure, err)
	}
}

type classificationTx struct {
	pgx.Tx
	commit, rollback error
}

func (tx classificationTx) Commit(context.Context) error   { return tx.commit }
func (tx classificationTx) Rollback(context.Context) error { return tx.rollback }

func TestTransactionFailureClassification(t *testing.T) {
	fault := &model.Fault{Code: "not_found", Message: "not found"}
	driver := &pgconn.PgError{Code: "23505", Message: "private"}
	cleanup := errors.New("cleanup")
	for _, tc := range []struct {
		name      string
		tx        classificationTx
		operation error
		failure   bool
		state     string
		outcome   TransactionOutcome
	}{
		{"domain refusal", classificationTx{}, fault, false, "", TransactionNotCommitted},
		{"driver and refusal", classificationTx{}, errors.Join(fault, driver), true, "23505", TransactionNotCommitted},
		{"failed cleanup", classificationTx{rollback: cleanup}, fault, true, "", TransactionUnknown},
		{"unknown commit", classificationTx{commit: driver, rollback: pgx.ErrTxClosed}, nil, true, "23505", TransactionUnknown},
		{"committed with cleanup failure", classificationTx{rollback: cleanup}, nil, true, "", TransactionCommitted},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := transact(context.Background(), tc.tx, func(pgx.Tx) error { return tc.operation })
			failed, state := DatabaseErrorFacts(err)
			var transaction *TransactionError
			if failed != tc.failure || state != tc.state || !errors.As(err, &transaction) || transaction.Outcome != tc.outcome {
				t.Fatalf("facts=(%v,%q), transaction=%+v, error=%v", failed, state, transaction, err)
			}
			if tc.operation != nil && !errors.Is(err, tc.operation) || tc.tx.commit != nil && !errors.Is(err, tc.tx.commit) || tc.tx.rollback == cleanup && !errors.Is(err, cleanup) {
				t.Fatalf("transaction lost cause: %v", err)
			}
		})
	}
}

func TestThreadCompletionFailuresPreserveFaultAndCause(t *testing.T) {
	fault := &model.Fault{Code: "invalid_input", Message: "invalid"}
	cleanup := errors.New("cleanup")
	completion, err := writeThread(context.Background(), classificationTx{rollback: cleanup}, func(ThreadScope) error { return fault })
	var stage *ThreadTransactionError
	failed, _ := DatabaseErrorFacts(err)
	if !errors.As(err, &stage) || !stage.RollbackFailed || completion.Outcome != TransactionUnknown || !failed || !errors.Is(err, fault) || !errors.Is(err, cleanup) {
		t.Fatalf("rollback: completion=%+v stage=%+v err=%v", completion, stage, err)
	}
	commit := &pgconn.PgError{Code: "08006", Message: "private"}
	completion, err = writeThread(context.Background(), classificationTx{commit: commit, rollback: pgx.ErrTxClosed}, func(ThreadScope) error { return nil })
	failed, state := DatabaseErrorFacts(err)
	if !errors.As(err, &stage) || !stage.OutcomeUnknown || completion.Outcome != TransactionUnknown || !failed || state != "08006" || !errors.Is(err, commit) {
		t.Fatalf("commit: completion=%+v stage=%+v state=%q err=%v", completion, stage, state, err)
	}
}
func TestReadOnlySnapshotCleansConnectionAfterQueryDeadline(t *testing.T) {
	pool := emptyPool(t)
	bounded, stop := context.WithTimeout(context.Background(), 30*time.Second)
	defer stop()
	observer := cancellationObserver(t, bounded, pool)
	ready, err := pool.Acquire(bounded)
	if err != nil {
		t.Fatal(err)
	}
	ready.Release()
	ctx, cancel := context.WithTimeout(bounded, 250*time.Millisecond)
	defer cancel()
	err = ReadOnlySnapshot(ctx, pool, func(tx pgx.Tx) error { return interruptObservedQuery(t, ctx, nil, observer, tx) })
	observer.Release()
	var failure *TransactionError
	if !errors.As(err, &failure) || failure.Phase != "operation" || failure.CommitAttempted || failure.CleanupFailed || failure.Outcome != TransactionNotCommitted || !errors.Is(err, context.DeadlineExceeded) || !errors.Is(err, pgconn.ErrConnClosed) {
		t.Fatalf("deadline cleanup lost its outcome or cause: %#v %v", failure, err)
	}
	if failed, state := DatabaseErrorFacts(err); failed {
		t.Fatalf("confirmed deadline cleanup became a database failure: %q %v", state, err)
	}
	assertMigrationPoolReusable(t, pool)
}

type deadlineRollbackTx struct {
	pgx.Tx
	deadline time.Time
}

func (tx *deadlineRollbackTx) Rollback(ctx context.Context) error {
	tx.deadline, _ = ctx.Deadline()
	<-ctx.Done()
	return ctx.Err()
}

func TestGitHubSignalCleanupHonorsRequestDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	deadline, _ := ctx.Deadline()
	tx := &deadlineRollbackTx{}
	started := time.Now()
	err := transactSignal(ctx, tx, func(pgx.Tx) error { return errors.New("operation failed") })
	var failure *TransactionError
	if !errors.As(err, &failure) || !failure.CleanupFailed || failure.Outcome != TransactionUnknown || !tx.deadline.Equal(deadline) {
		t.Fatalf("cleanup deadline=%s transaction=%+v error=%v", tx.deadline, failure, err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("cleanup exceeded request deadline: %v", elapsed)
	}
}
