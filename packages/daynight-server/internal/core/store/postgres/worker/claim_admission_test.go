package worker_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	pgworker "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func claimTransaction(t *testing.T, db *postgres.Store, ctx context.Context) pgx.Tx {
	t.Helper()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	return tx
}

func claimTarget(t *testing.T, tx pgx.Tx, user, id string) *model.WorkerDesiredConfiguration {
	t.Helper()
	got, err := pgworker.NewClaimAdmission(tx).ClaimWorkerConfiguration(t.Context(), user, id)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func startClaimWaiter(t *testing.T, ctx context.Context, db *postgres.Store, holder pgx.Tx, queryPrefix string, operation func(context.Context, pgx.Tx) error) (pgx.Tx, context.CancelFunc, <-chan error) {
	t.Helper()
	waiter, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	conn := waiter.Conn().PgConn()
	transport := conn.Conn()
	cleanupDone := conn.CleanupDone()
	holderPID, waiterPID := holder.Conn().PgConn().PID(), conn.PID()
	waiting, cancel := context.WithCancel(ctx)
	result, finished := make(chan error, 1), make(chan struct{})
	go func() {
		err := operation(waiting, waiter)
		close(finished)
		result <- err
	}()
	t.Cleanup(func() {
		cancel()
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if err := holder.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("release claim holder: %v", err)
		}
		select {
		case <-finished:
		case <-cleanup.Done():
			select {
			case <-finished:
			default:
				// Closing the transport unblocks driver I/O before rollback.
				t.Error("claim waiter did not exit after cancellation")
				_ = transport.Close()
				<-finished
			}
		}
		rollback, stopRollback := context.WithTimeout(context.Background(), 5*time.Second)
		defer stopRollback()
		if err := waiter.Rollback(rollback); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			if !errors.Is(err, pgconn.ErrConnClosed) {
				t.Errorf("rollback claim waiter: %v", err)
				return
			}
			select {
			case <-cleanupDone:
			case <-rollback.Done():
				t.Errorf("claim waiter connection did not close: %v", rollback.Err())
			}
		}
	})
	for {
		var blocked bool
		err := db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM pg_stat_activity
 WHERE datname=current_database() AND application_name=current_schema() AND pid=$1
 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(pid)) AND starts_with(query,$3))`,
			waiterPID, holderPID, queryPrefix).Scan(&blocked)
		if err != nil {
			t.Fatal(err)
		}
		if blocked {
			return waiter, cancel, result
		}
		select {
		case <-finished:
			t.Fatalf("backend %d completed before waiting on backend %d for %q", waiterPID, holderPID, queryPrefix)
		default:
		}
		if err := testutil.WaitThreadClock(ctx); err != nil {
			t.Fatalf("backend %d did not wait on backend %d for %q: %v", waiterPID, holderPID, queryPrefix, err)
		}
	}
}

func TestClaimWorkerConfigurationAuthoritativeRawAndInitialization(t *testing.T) {
	db := workerStorage(t)
	ctx := t.Context()
	user, id := testutil.QueryID(1), testutil.QueryID(2)
	tx := claimTransaction(t, db, ctx)
	if got := claimTarget(t, tx, user, id); got != nil {
		t.Fatalf("missing Worker: %+v", got)
	}
	writer := pgworker.NewWriter(tx)
	if _, err := writer.UpsertWorker(ctx, testutil.WorkerSnapshotFixture(user, id, time.Now().UTC())); err != nil {
		t.Fatal(err)
	}
	if got := claimTarget(t, tx, user, id); got != nil {
		t.Fatalf("uninitialized Worker: %+v", got)
	}
	raw := json.RawMessage(`{"maxConcurrent":"future-value","future":{"preserved":true}}`)
	expected, err := writer.SetWorkerConfigurationRaw(ctx, user, id, 9223372036854775807, raw, false)
	if err != nil {
		t.Fatal(err)
	}
	execute(t, tx, `UPDATE workers SET configuration_observation='{"invalid":"observation"}' WHERE user_id=$1 AND worker_id=$2`, user, id)
	got := claimTarget(t, tx, user, id)
	if got == nil || got.Revision != expected.Revision || !got.UpdatedAt.Equal(expected.UpdatedAt) || got.UpdatedAt.Location() != time.UTC || !reflect.DeepEqual(got.Raw, expected.Raw) || got.ValueValid || got.ArchiveSessions != nil || !reflect.DeepEqual(got.Value, model.WorkerConfiguration{}) {
		t.Fatalf("narrow authoritative target: %+v expected %+v", got, expected)
	}
	for _, foreign := range []struct{ user, id string }{{testutil.QueryID(3), id}, {user, testutil.QueryID(4)}} {
		if got := claimTarget(t, tx, foreign.user, foreign.id); got != nil {
			t.Fatalf("foreign identity: %+v", got)
		}
	}
}

func TestClaimWorkerConfigurationExcludesConfigurationWritesUntilCompletion(t *testing.T) {
	db := workerStorage(t)
	for _, commit := range []bool{false, true} {
		if !t.Run(map[bool]string{false: "rollback", true: "commit"}[commit], func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			user, id := uuid.NewString(), uuid.NewString()
			testutil.PutWorkerSnapshot(t, db, testutil.WorkerSnapshotFixture(user, id, time.Now().UTC()))
			first := admissionTransaction(t, db, ctx)
			if got := claimTarget(t, first, user, id); got != nil {
				t.Fatal(got)
			}
			second, _, result := startClaimWaiter(t, ctx, db, first, "UPDATE workers SET configuration_revision=",
				func(ctx context.Context, tx pgx.Tx) error {
					_, err := pgworker.NewWriter(tx).SetWorkerConfiguration(ctx, user, id, 1, testutil.WorkerConfiguration())
					return err
				})
			var err error
			if commit {
				err = first.Commit(ctx)
			} else {
				err = first.Rollback(ctx)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := testutil.ReceiveQueryResult(t, ctx, result); err != nil {
				t.Fatal(err)
			}
			if err := second.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			fresh := admissionTransaction(t, db, ctx)
			if got := claimTarget(t, fresh, user, id); got == nil || got.Revision != "1" {
				t.Fatalf("released row lock: %+v", got)
			}
		}) {
			return
		}
		testutil.AssertPoolReusable(t, db.Pool)
	}
}

func TestClaimWorkerConfigurationReadsConfigurationCommittedBeforeItsLock(t *testing.T) {
	db := workerStorage(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	user, id := testutil.QueryID(1), testutil.QueryID(2)
	testutil.PutWorkerSnapshot(t, db, testutil.WorkerSnapshotFixture(user, id, time.Now().UTC()))
	first, second := claimTransaction(t, db, ctx), claimTransaction(t, db, ctx)
	if _, err := pgworker.NewWriter(first).SetWorkerConfiguration(ctx, user, id, 9, testutil.WorkerConfiguration()); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	var got *model.WorkerDesiredConfiguration
	go func() {
		var err error
		got, err = pgworker.NewClaimAdmission(second).ClaimWorkerConfiguration(ctx, user, id)
		result <- err
	}()
	testutil.WaitThreadBackendLock(t, db.Pool, second.Conn().PgConn().PID())
	if err := first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, result); err != nil {
		t.Fatal(err)
	}
	if got == nil || got.Revision != "9" {
		t.Fatalf("stale configuration after lock: %+v", got)
	}
}

func TestClaimWorkerConfigurationMissingRowBlocksFirstReportUntilCompletion(t *testing.T) {
	db := workerStorage(t)
	for _, commit := range []bool{false, true} {
		if !t.Run(map[bool]string{false: "rollback", true: "commit"}[commit], func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			user, id := uuid.NewString(), uuid.NewString()
			first := admissionTransaction(t, db, ctx)
			if got := claimTarget(t, first, user, id); got != nil {
				t.Fatal(got)
			}
			second, _, result := startClaimWaiter(t, ctx, db, first, "SELECT pg_advisory_xact_lock(hashtextextended('worker-admission:",
				func(ctx context.Context, tx pgx.Tx) error {
					writer := pgworker.NewWriter(tx)
					admission, err := writer.AdmitWorker(ctx, user, id, time.Minute)
					if err != nil {
						return err
					}
					_, err = writer.UpsertWorker(ctx, testutil.WorkerSnapshotFixture(user, id, admission.ObservedAt))
					return err
				})
			var err error
			if commit {
				err = first.Commit(ctx)
			} else {
				err = first.Rollback(ctx)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := testutil.ReceiveQueryResult(t, ctx, result); err != nil {
				t.Fatal(err)
			}
			if err := second.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			var count int
			if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM workers WHERE user_id=$1 AND worker_id=$2`, user, id).Scan(&count); err != nil || count != 1 {
				t.Fatalf("first report after completion: %d %v", count, err)
			}
		}) {
			return
		}
		testutil.AssertPoolReusable(t, db.Pool)
	}
}

func TestClaimWorkerConfigurationRereadsFirstReportAfterAdmissionLock(t *testing.T) {
	db := workerStorage(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	user, id := testutil.QueryID(1), testutil.QueryID(2)
	first, second := claimTransaction(t, db, ctx), claimTransaction(t, db, ctx)
	writer := pgworker.NewWriter(first)
	admission, err := writer.AdmitWorker(ctx, user, id, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	var got *model.WorkerDesiredConfiguration
	go func() {
		var err error
		got, err = pgworker.NewClaimAdmission(second).ClaimWorkerConfiguration(ctx, user, id)
		result <- err
	}()
	testutil.WaitThreadBackendLock(t, db.Pool, second.Conn().PgConn().PID())
	if _, err := writer.UpsertWorker(ctx, testutil.WorkerSnapshotFixture(user, id, admission.ObservedAt)); err != nil {
		t.Fatal(err)
	}
	expected, err := writer.SetWorkerConfigurationRaw(ctx, user, id, 7, json.RawMessage(`{"future":true}`), true)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, result); err != nil {
		t.Fatal(err)
	}
	if got == nil || got.Revision != "7" || !reflect.DeepEqual(got.Raw, expected.Raw) {
		t.Fatalf("missing-row reread: %+v", got)
	}
	// The reread must retain the newly found Worker row lock as well as the owner lock.
	third := claimTransaction(t, db, ctx)
	result = make(chan error, 1)
	go func() {
		_, err := pgworker.NewWriter(third).SetWorkerConfiguration(ctx, user, id, 8, testutil.WorkerConfiguration())
		result <- err
	}()
	testutil.WaitThreadBackendLock(t, db.Pool, third.Conn().PgConn().PID())
	if err := second.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, result); err != nil {
		t.Fatal(err)
	}
}

func TestClaimWorkerConfigurationExistingRowSkipsOwnerLock(t *testing.T) {
	db := workerStorage(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	user, id := testutil.QueryID(1), testutil.QueryID(2)
	testutil.PutWorkerSnapshot(t, db, testutil.WorkerSnapshotFixture(user, id, time.Now().UTC()))
	owner := claimTransaction(t, db, ctx)
	if _, err := pgworker.NewWriter(owner).AdmitWorker(ctx, user, testutil.QueryID(3), time.Minute); err != nil {
		t.Fatal(err)
	}
	tx := claimTransaction(t, db, ctx)
	if got, err := pgworker.NewClaimAdmission(tx).ClaimWorkerConfiguration(ctx, user, id); err != nil || got != nil {
		t.Fatalf("existing Worker waited for unrelated owner admission: %+v %v", got, err)
	}
	var owns bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory')`).Scan(&owns); err != nil || owns {
		t.Fatalf("existing path acquired owner lock: %v %v", owns, err)
	}
}

func TestClaimWorkerConfigurationCancellationAndDatabaseErrors(t *testing.T) {
	db := workerStorage(t)
	for _, missing := range []bool{false, true} {
		if !t.Run(map[bool]string{false: "row lock", true: "owner lock"}[missing], func(t *testing.T) {
			ctx, finish := context.WithTimeout(t.Context(), 15*time.Second)
			defer finish()
			user, id := uuid.NewString(), uuid.NewString()
			queryPrefix := "SELECT pg_advisory_xact_lock(hashtextextended('worker-admission:"
			if !missing {
				testutil.PutWorkerSnapshot(t, db, testutil.WorkerSnapshotFixture(user, id, time.Now().UTC()))
				queryPrefix = "SELECT configuration_revision,configuration_updated_at,desired_configuration FROM workers"
			}
			first := admissionTransaction(t, db, ctx)
			if _, err := pgworker.NewClaimAdmission(first).ClaimWorkerConfiguration(ctx, user, id); err != nil {
				t.Fatal(err)
			}
			_, cancel, result := startClaimWaiter(t, ctx, db, first, queryPrefix,
				func(ctx context.Context, tx pgx.Tx) error {
					got, err := pgworker.NewClaimAdmission(tx).ClaimWorkerConfiguration(ctx, user, id)
					if got != nil {
						return errors.New("canceled read returned a target")
					}
					return err
				})
			cancel()
			if err := testutil.ReceiveQueryResult(t, ctx, result); !errors.Is(err, context.Canceled) {
				t.Fatalf("cancellation cause lost: %v", err)
			}
		}) {
			return
		}
		testutil.AssertPoolReusable(t, db.Pool)
	}
	tx := admissionTransaction(t, db, t.Context())
	if err := tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got, err := pgworker.NewClaimAdmission(tx).ClaimWorkerConfiguration(t.Context(), testutil.QueryID(1), testutil.QueryID(2)); got != nil || !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed transaction became absent target: %+v %v", got, err)
	}
	tx = admissionTransaction(t, db, t.Context())
	if got, err := pgworker.NewClaimAdmission(tx).ClaimWorkerConfiguration(t.Context(), "invalid-uuid", testutil.QueryID(2)); got != nil || err == nil {
		t.Fatalf("database failure became absent target: %+v %v", got, err)
	} else if failed, state := store.DatabaseErrorFacts(err); !failed || state != "22P02" {
		t.Fatalf("database failure chain lost: %v %s %v", failed, state, err)
	}
}
