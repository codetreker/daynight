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
	"github.com/jackc/pgx/v5"
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
	for _, commit := range []bool{false, true} {
		t.Run(map[bool]string{false: "rollback", true: "commit"}[commit], func(t *testing.T) {
			db := workerStorage(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			user, id := testutil.QueryID(1), testutil.QueryID(2)
			testutil.PutWorkerSnapshot(t, db, testutil.WorkerSnapshotFixture(user, id, time.Now().UTC()))
			first := claimTransaction(t, db, ctx)
			if got := claimTarget(t, first, user, id); got != nil {
				t.Fatal(got)
			}
			second := claimTransaction(t, db, ctx)
			result := make(chan error, 1)
			go func() {
				_, err := pgworker.NewWriter(second).SetWorkerConfiguration(ctx, user, id, 1, testutil.WorkerConfiguration())
				result <- err
			}()
			testutil.WaitThreadBackendLock(t, db.Pool, second.Conn().PgConn().PID())
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
			fresh := claimTransaction(t, db, ctx)
			if got := claimTarget(t, fresh, user, id); got == nil || got.Revision != "1" {
				t.Fatalf("released row lock: %+v", got)
			}
		})
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
	for _, commit := range []bool{false, true} {
		t.Run(map[bool]string{false: "rollback", true: "commit"}[commit], func(t *testing.T) {
			db := workerStorage(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			user, id := testutil.QueryID(1), testutil.QueryID(2)
			first, second := claimTransaction(t, db, ctx), claimTransaction(t, db, ctx)
			if got := claimTarget(t, first, user, id); got != nil {
				t.Fatal(got)
			}
			result := make(chan error, 1)
			go func() {
				writer := pgworker.NewWriter(second)
				admission, err := writer.AdmitWorker(ctx, user, id, time.Minute)
				if err == nil {
					_, err = writer.UpsertWorker(ctx, testutil.WorkerSnapshotFixture(user, id, admission.ObservedAt))
				}
				result <- err
			}()
			testutil.WaitThreadBackendLock(t, db.Pool, second.Conn().PgConn().PID())
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
		})
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
	for _, missing := range []bool{false, true} {
		t.Run(map[bool]string{false: "row lock", true: "owner lock"}[missing], func(t *testing.T) {
			db := workerStorage(t)
			ctx, finish := context.WithTimeout(t.Context(), 15*time.Second)
			defer finish()
			user, id := testutil.QueryID(1), testutil.QueryID(2)
			if !missing {
				testutil.PutWorkerSnapshot(t, db, testutil.WorkerSnapshotFixture(user, id, time.Now().UTC()))
			}
			first, second := claimTransaction(t, db, ctx), claimTransaction(t, db, ctx)
			if _, err := pgworker.NewClaimAdmission(first).ClaimWorkerConfiguration(ctx, user, id); err != nil {
				t.Fatal(err)
			}
			waiting, cancel := context.WithCancel(ctx)
			defer cancel()
			result := make(chan error, 1)
			go func() {
				got, err := pgworker.NewClaimAdmission(second).ClaimWorkerConfiguration(waiting, user, id)
				if got != nil {
					result <- errors.New("canceled read returned a target")
					return
				}
				result <- err
			}()
			testutil.WaitThreadBackendLock(t, db.Pool, second.Conn().PgConn().PID())
			cancel()
			if err := testutil.ReceiveQueryResult(t, ctx, result); !errors.Is(err, context.Canceled) {
				t.Fatalf("cancellation cause lost: %v", err)
			}
		})
	}
	db := workerStorage(t)
	tx := claimTransaction(t, db, t.Context())
	if err := tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got, err := pgworker.NewClaimAdmission(tx).ClaimWorkerConfiguration(t.Context(), testutil.QueryID(1), testutil.QueryID(2)); got != nil || !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed transaction became absent target: %+v %v", got, err)
	}
	tx = claimTransaction(t, db, t.Context())
	if got, err := pgworker.NewClaimAdmission(tx).ClaimWorkerConfiguration(t.Context(), "invalid-uuid", testutil.QueryID(2)); got != nil || err == nil {
		t.Fatalf("database failure became absent target: %+v %v", got, err)
	} else if failed, state := store.DatabaseErrorFacts(err); !failed || state != "22P02" {
		t.Fatalf("database failure chain lost: %v %s %v", failed, state, err)
	}
}
