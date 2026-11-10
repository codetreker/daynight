package postgres

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func admissionCompletionRows(t *testing.T, database *Store, ctx context.Context, owner string) string {
	t.Helper()
	var rows string
	if err := database.Pool.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY worker_id),'[]'::jsonb)::text FROM workers w WHERE user_id=$1`, owner).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	return rows
}

func admissionCompletionSeed(t *testing.T, database *Store, ctx context.Context, owner, id string) model.WorkerSnapshot {
	t.Helper()
	var saved model.WorkerSnapshot
	completion, err := database.WriteWorker(ctx, func(scope WorkerScope) error {
		admission, err := scope.AdmitWorker(ctx, owner, id, 120*time.Second)
		if err != nil {
			return err
		}
		value := workerSnapshotFixture(owner, id, admission.ObservedAt)
		value.Telemetry.SampledAt = admission.ObservedAt.Add(24 * time.Hour)
		saved, err = scope.WorkerDAO().UpsertWorker(ctx, value)
		if err != nil {
			return err
		}
		if _, err := scope.WorkerDAO().SetWorkerConfiguration(ctx, owner, id, 1, storeWorkerConfiguration()); err != nil {
			return err
		}
		return scope.WorkerDAO().SetWorkerConfigurationObservation(ctx, owner, id, 1, model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{}})
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("seed Worker transaction: %+v %v", completion, err)
	}
	return saved
}

func TestWorkerAdmissionCompletionClockRollbackAndSQLFailure(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	owner, id := uuid.NewString(), uuid.NewString()
	initial := admissionCompletionSeed(t, database, ctx, owner, id)
	if _, err := database.Pool.Exec(ctx, `UPDATE workers SET last_seen_at=statement_timestamp()+interval '1 hour' WHERE user_id=$1 AND worker_id=$2`, owner, id); err != nil {
		t.Fatal(err)
	}
	var stored model.WorkerSnapshot
	var admission WorkerAdmission
	var afterWrite time.Time
	completion, err := database.WriteWorker(ctx, func(scope WorkerScope) error {
		var err error
		admission, err = scope.AdmitWorker(ctx, owner, id, 120*time.Second)
		if err != nil {
			return err
		}
		if admission.ActiveCount != 0 || admission.LastSeenAt == nil || !admission.LastSeenAt.After(admission.ObservedAt) {
			t.Errorf("future target counted as active: %+v", admission)
		}
		updated := initial
		updated.LastReportedAt = admission.ObservedAt
		updated.Telemetry.Machine.Name = "Database-clock report"
		stored, err = scope.WorkerDAO().UpsertWorker(ctx, updated)
		if err != nil {
			return err
		}
		afterWrite, err = scope.ObservedAt(ctx)
		return err
	})
	if err != nil || completion.Outcome != TransactionCommitted || !stored.LastReportedAt.Equal(admission.ObservedAt) || afterWrite.Before(stored.LastReportedAt) || afterWrite.Sub(stored.LastReportedAt) > 10*time.Second || !stored.Telemetry.SampledAt.After(stored.LastReportedAt) {
		t.Fatalf("database clock was not persisted: %+v stored=%+v observed=%v err=%v", completion, stored, afterWrite, err)
	}
	if actual := readWorkerSnapshot(t, database, owner, id, afterWrite); !reflect.DeepEqual(actual, stored) {
		t.Fatalf("future timestamp repair did not persist: got=%+v want=%+v", actual, stored)
	}

	before := admissionCompletionRows(t, database, ctx, owner)
	refusal := &model.Fault{Code: "not_found", Message: "Configuration Project was not found.", Cause: model.ErrNotFound}
	newID := uuid.NewString()
	completion, err = database.WriteWorker(ctx, func(scope WorkerScope) error {
		admission, err := scope.AdmitWorker(ctx, owner, newID, 120*time.Second)
		if err != nil {
			return err
		}
		if _, err := scope.WorkerDAO().UpsertWorker(ctx, workerSnapshotFixture(owner, newID, admission.ObservedAt)); err != nil {
			return err
		}
		return refusal
	})
	if completion.Outcome != TransactionNotCommitted || !errors.Is(err, refusal) || !errors.Is(err, model.ErrNotFound) || admissionCompletionRows(t, database, ctx, owner) != before {
		t.Fatalf("callback refusal committed a partial report: %+v %v", completion, err)
	}
	admissionCompletionSeed(t, database, ctx, owner, newID)
	before = admissionCompletionRows(t, database, ctx, owner)
	if _, err := database.Pool.Exec(ctx, `ALTER TABLE workers RENAME COLUMN last_seen_at TO unavailable_last_seen_at`); err != nil {
		t.Fatal(err)
	}
	restored := false
	t.Cleanup(func() {
		if !restored {
			cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			if _, err := database.Pool.Exec(cleanup, `ALTER TABLE workers RENAME COLUMN unavailable_last_seen_at TO last_seen_at`); err != nil {
				t.Errorf("restore Worker timestamp column: %v", err)
			}
		}
	})
	completion, admissionErr := database.WriteWorker(ctx, func(scope WorkerScope) error {
		_, err := scope.AdmitWorker(ctx, owner, id, 120*time.Second)
		return err
	})
	if _, err := database.Pool.Exec(ctx, `ALTER TABLE workers RENAME COLUMN unavailable_last_seen_at TO last_seen_at`); err != nil {
		t.Fatal(err)
	}
	restored = true
	var driver *pgconn.PgError
	if completion.Outcome != TransactionNotCommitted || !errors.As(admissionErr, &driver) || driver.Code != "42703" || admissionCompletionRows(t, database, ctx, owner) != before {
		t.Fatalf("failed admission changed rows or lost SQL cause: %+v %v", completion, admissionErr)
	}
	completion, err = database.WriteWorker(ctx, func(scope WorkerScope) error {
		admission, err := scope.AdmitWorker(ctx, owner, id, 120*time.Second)
		if err != nil {
			return err
		}
		updated := stored
		updated.LastReportedAt = admission.ObservedAt
		updated.Telemetry.Machine.Name = "Recovered after SQL failure"
		stored, err = scope.WorkerDAO().UpsertWorker(ctx, updated)
		return err
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("SQL failure retained its admission lock: %+v %v", completion, err)
	}
	if actual := readWorkerSnapshot(t, database, owner, id, stored.LastReportedAt); !reflect.DeepEqual(actual, stored) {
		t.Fatalf("recovered report did not persist: got=%+v want=%+v", actual, stored)
	}
}

func admissionCompletionLock(t *testing.T, database *Store, ctx context.Context, owner string) pgx.Tx {
	t.Helper()
	tx, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tx.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("release admission holder: %v", err)
		}
	})
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('worker-admission:' || $1::uuid::text, 0))`, owner); err != nil {
		t.Fatal(err)
	}
	return tx
}

func admissionCompletionWait(t *testing.T, database *Store, ctx context.Context, holder pgx.Tx, done <-chan struct{}) {
	t.Helper()
	for {
		var blocked bool
		if err := database.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=current_schema() AND $1=ANY(pg_blocking_pids(pid)))`, holder.Conn().PgConn().PID()).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		select {
		case <-done:
			t.Fatal("Worker transaction completed before the owner lock was released")
		case <-ctx.Done():
			t.Fatal("Worker transaction did not wait for the owner lock")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestWorkerAdmissionCompletionWaitResamplesAndCancellationReleasesLock(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	owner, active, added := uuid.NewString(), uuid.NewString(), uuid.NewString()
	initial := admissionCompletionSeed(t, database, ctx, owner, active)
	if _, err := database.Pool.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot)
 SELECT user_id,gen_random_uuid(),created_at,last_seen_at,telemetry,task_snapshot
 FROM workers CROSS JOIN generate_series(1,99) WHERE user_id=$1 AND worker_id=$2`, owner, active); err != nil {
		t.Fatal(err)
	}
	holder := admissionCompletionLock(t, database, ctx, owner)
	type result struct {
		completion Completion
		admission  WorkerAdmission
		stored     model.WorkerSnapshot
		err        error
	}
	out, done := make(chan result, 1), make(chan struct{})
	go func() {
		var value result
		value.completion, value.err = database.WriteWorker(ctx, func(scope WorkerScope) error {
			var err error
			value.admission, err = scope.AdmitWorker(ctx, strings.ToUpper(owner), added, 120*time.Second)
			if err != nil {
				return err
			}
			value.stored, err = scope.WorkerDAO().UpsertWorker(ctx, workerSnapshotFixture(owner, added, value.admission.ObservedAt))
			return err
		})
		out <- value
		close(done)
	}()
	received := false
	t.Cleanup(func() {
		cancel()
		if !received {
			select {
			case <-out:
			case <-time.After(5 * time.Second):
				t.Error("waiting Worker transaction did not exit")
			}
		}
	})
	admissionCompletionWait(t, database, ctx, holder, done)
	admissionCompletionSeed(t, database, ctx, uuid.NewString(), uuid.NewString())
	var fixtureAt time.Time
	if err := database.Pool.QueryRow(ctx, `UPDATE workers SET last_seen_at=statement_timestamp()-interval '121 seconds' WHERE user_id=$1 AND worker_id=$2 RETURNING statement_timestamp()`, owner, active).Scan(&fixtureAt); err != nil {
		t.Fatal(err)
	}
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	written := <-out
	received = true
	if written.err != nil || written.completion.Outcome != TransactionCommitted || written.admission.ActiveCount != 99 || !written.admission.ObservedAt.After(fixtureAt) || !written.stored.LastReportedAt.Equal(written.admission.ObservedAt) {
		t.Fatalf("waiting transaction did not resample after lock: %+v", written)
	}
	if actual := readWorkerSnapshot(t, database, owner, added, written.admission.ObservedAt); !reflect.DeepEqual(actual, written.stored) {
		t.Fatalf("waiting report did not persist: got=%+v want=%+v", actual, written.stored)
	}

	holder = admissionCompletionLock(t, database, ctx, owner)
	before := admissionCompletionRows(t, database, ctx, owner)
	canceled, stop := context.WithCancel(ctx)
	defer stop()
	cancelOut, cancelDone := make(chan result, 1), make(chan struct{})
	go func() {
		var value result
		value.completion, value.err = database.WriteWorker(canceled, func(scope WorkerScope) error {
			var err error
			value.admission, err = scope.AdmitWorker(canceled, owner, active, 120*time.Second)
			if err != nil {
				return err
			}
			initial.LastReportedAt = value.admission.ObservedAt
			value.stored, err = scope.WorkerDAO().UpsertWorker(canceled, initial)
			return err
		})
		cancelOut <- value
		close(cancelDone)
	}()
	cancelReceived := false
	t.Cleanup(func() {
		stop()
		if !cancelReceived {
			select {
			case <-cancelOut:
			case <-time.After(5 * time.Second):
				t.Error("canceled Worker transaction did not exit")
			}
		}
	})
	admissionCompletionWait(t, database, ctx, holder, cancelDone)
	stop()
	canceledResult := <-cancelOut
	cancelReceived = true
	var cancellation *TransactionError
	if !errors.Is(canceledResult.err, context.Canceled) || !errors.As(canceledResult.err, &cancellation) || cancellation.CommitAttempted || canceledResult.completion.Outcome != cancellation.Outcome {
		t.Fatalf("lock-wait cancellation lost its completion facts: %+v", canceledResult)
	}
	if cancellation.CleanupFailed {
		if cancellation.Phase != "cleanup" || canceledResult.completion.Outcome != TransactionUnknown {
			t.Fatalf("failed cleanup manufactured a confirmed rollback: %+v", canceledResult)
		}
	} else if cancellation.Phase != "operation" || canceledResult.completion.Outcome != TransactionNotCommitted {
		t.Fatalf("successful rollback lost its completion: %+v", canceledResult)
	}
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if after := admissionCompletionRows(t, database, ctx, owner); after != before {
		t.Fatal("canceled admission changed Worker rows")
	}
	var updated model.WorkerSnapshot
	completion, err := database.WriteWorker(ctx, func(scope WorkerScope) error {
		admission, err := scope.AdmitWorker(ctx, owner, added, 120*time.Second)
		if err != nil {
			return err
		}
		if admission.ActiveCount != 100 || admission.LastSeenAt == nil || !admission.LastSeenAt.Equal(written.stored.LastReportedAt) {
			t.Errorf("later transaction lost committed count or target: %+v", admission)
		}
		next := written.stored
		next.LastReportedAt = admission.ObservedAt
		next.Telemetry.Machine.Name = "Active report after cancellation"
		updated, err = scope.WorkerDAO().UpsertWorker(ctx, next)
		return err
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("cancellation retained the owner lock: %+v %v", completion, err)
	}
	if actual := readWorkerSnapshot(t, database, owner, added, updated.LastReportedAt); !reflect.DeepEqual(actual, updated) {
		t.Fatalf("active report at capacity did not persist: got=%+v want=%+v", actual, updated)
	}
}
