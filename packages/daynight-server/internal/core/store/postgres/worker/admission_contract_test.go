package worker_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const admissionWindow = 120 * time.Second

func admissionTransaction(t *testing.T, database *postgres.Store, ctx context.Context) pgx.Tx {
	t.Helper()
	tx, err := database.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tx.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("rollback admission transaction: %v", err)
		}
	})
	return tx
}

func admissionRows(t *testing.T, database *postgres.Store, ctx context.Context, count int) (string, string, string) {
	t.Helper()
	owner, active, inactive := uuid.NewString(), uuid.NewString(), uuid.NewString()
	tx := admissionTransaction(t, database, ctx)
	writer := worker.NewWriter(tx)
	admission, err := writer.AdmitWorker(ctx, owner, active, admissionWindow)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.UpsertWorker(ctx, snapshot(owner, active, admission.ObservedAt)); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot)
 SELECT user_id,gen_random_uuid(),created_at,last_seen_at,telemetry,task_snapshot
 FROM workers CROSS JOIN generate_series(1,$3::int) WHERE user_id=$1 AND worker_id=$2`, owner, active, count-1); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot)
 SELECT user_id,$3,created_at,statement_timestamp()-interval '121 seconds',telemetry,task_snapshot
 FROM workers WHERE user_id=$1 AND worker_id=$2`, owner, active, inactive); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return owner, active, inactive
}

func admissionStoredRows(t *testing.T, database *postgres.Store, ctx context.Context, owner string) string {
	t.Helper()
	var rows string
	if err := database.Pool.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY worker_id),'[]'::jsonb)::text FROM workers w WHERE user_id=$1`, owner).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	return rows
}

func TestWorkerAdmissionDAOCountsTargetsAndOwners(t *testing.T) {
	database := workerStorage(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	for _, count := range []int{99, 100, 101} {
		owner, active, inactive := admissionRows(t, database, ctx, count)
		before := admissionStoredRows(t, database, ctx, owner)
		for _, target := range []struct{ name, id string }{{"active", active}, {"new", uuid.NewString()}, {"inactive", inactive}} {
			t.Run(fmt.Sprintf("%d/%s", count, target.name), func(t *testing.T) {
				tx := admissionTransaction(t, database, ctx)
				got, err := worker.NewWriter(tx).AdmitWorker(ctx, owner, target.id, admissionWindow)
				if err != nil || got.ActiveCount != count || got.ObservedAt.IsZero() || got.ObservedAt.Location() != time.UTC {
					t.Fatalf("admission: %+v %v", got, err)
				}
				switch target.name {
				case "new":
					if got.LastSeenAt != nil {
						t.Fatalf("new target has a stored timestamp: %v", got.LastSeenAt)
					}
				case "active":
					if got.LastSeenAt == nil || got.LastSeenAt.After(got.ObservedAt) || !got.LastSeenAt.After(got.ObservedAt.Add(-admissionWindow)) {
						t.Fatalf("active target timestamp: %+v", got)
					}
				case "inactive":
					if got.LastSeenAt == nil || got.LastSeenAt.After(got.ObservedAt.Add(-admissionWindow)) {
						t.Fatalf("inactive target timestamp: %+v", got)
					}
				}
				if err := tx.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
			})
		}
		tx := admissionTransaction(t, database, ctx)
		got, err := worker.NewWriter(tx).AdmitWorker(ctx, uuid.NewString(), active, admissionWindow)
		if err != nil || got.ActiveCount != 0 || got.LastSeenAt != nil {
			t.Fatalf("another owner's admission: %+v %v", got, err)
		}
		if err := tx.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
		if after := admissionStoredRows(t, database, ctx, owner); after != before {
			t.Fatal("admission reads changed stored Worker rows")
		}
	}
}

func TestWorkerAdmissionDAOCanonicalOwnerSerializesAndReadsCommittedCount(t *testing.T) {
	database := workerStorage(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	owner, _, inactive := admissionRows(t, database, ctx, 99)
	var before string
	if err := database.Pool.QueryRow(ctx, `SELECT to_jsonb(w)::text FROM workers w WHERE user_id=$1 AND worker_id=$2`, owner, inactive).Scan(&before); err != nil {
		t.Fatal(err)
	}
	first := admissionTransaction(t, database, ctx)
	firstWriter := worker.NewWriter(first)
	id := uuid.NewString()
	admission, err := firstWriter.AdmitWorker(ctx, owner, id, admissionWindow)
	if err != nil || admission.ActiveCount != 99 || admission.LastSeenAt != nil {
		t.Fatalf("first admission: %+v %v", admission, err)
	}
	written, err := firstWriter.UpsertWorker(ctx, snapshot(owner, id, admission.ObservedAt))
	if err != nil {
		t.Fatal(err)
	}
	second := admissionTransaction(t, database, ctx)
	firstPID, secondPID := first.Conn().PgConn().PID(), second.Conn().PgConn().PID()
	type result struct {
		admission store.WorkerAdmission
		err       error
	}
	out, done := make(chan result, 1), make(chan struct{})
	go func() {
		value, err := worker.NewWriter(second).AdmitWorker(ctx, strings.ToUpper(owner), inactive, admissionWindow)
		out <- result{value, err}
		close(done)
	}()
	received := false
	t.Cleanup(func() {
		cancel()
		if !received {
			select {
			case <-out:
			case <-time.After(5 * time.Second):
				t.Error("admission reader did not exit after cancellation")
			}
		}
	})
	for {
		var blocked bool
		if err := database.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND $2=ANY(pg_blocking_pids(pid)))`, secondPID, firstPID).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case <-done:
			t.Fatal("second admission returned before the owner's transaction completed")
		case <-ctx.Done():
			t.Fatal("second admission did not wait for the owner lock")
		case <-time.After(5 * time.Millisecond):
		}
	}
	foreign := admissionTransaction(t, database, ctx)
	other, err := worker.NewWriter(foreign).AdmitWorker(ctx, uuid.NewString(), uuid.NewString(), admissionWindow)
	if err != nil || other.ActiveCount != 0 || other.LastSeenAt != nil {
		t.Fatalf("different owner was blocked or shared counts: %+v %v", other, err)
	}
	if err := foreign.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got := <-out
	received = true
	if got.err != nil || got.admission.ActiveCount != 100 || got.admission.LastSeenAt == nil || !got.admission.ObservedAt.After(admission.ObservedAt) {
		t.Fatalf("waiting admission did not read the committed count: %+v %v", got.admission, got.err)
	}
	if err := second.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var after string
	if err := database.Pool.QueryRow(ctx, `SELECT to_jsonb(w)::text FROM workers w WHERE user_id=$1 AND worker_id=$2`, owner, inactive).Scan(&after); err != nil || after != before {
		t.Fatalf("unwritten contender changed its row: %s %v", after, err)
	}
	persisted := testutil.ReadWorkerSnapshot(t, database, owner, id, got.admission.ObservedAt)
	if !reflect.DeepEqual(persisted, written) {
		t.Fatalf("committed Worker changed on readback: got=%+v want=%+v", persisted, written)
	}
}

func TestWorkerAdmissionDAOClockExpiryDoesNotRewriteRows(t *testing.T) {
	database := workerStorage(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	var schema string
	if err := database.Pool.QueryRow(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `CREATE TABLE worker_test_clock (observed_at timestamptz NOT NULL);
 INSERT INTO worker_test_clock VALUES (statement_timestamp());
 CREATE FUNCTION statement_timestamp() RETURNS timestamptz LANGUAGE sql STABLE AS 'SELECT observed_at FROM worker_test_clock'`); err != nil {
		t.Fatal(err)
	}
	config := database.Pool.Config().Copy()
	// Explicit pg_catalog order lets this fixture control the database clock.
	config.ConnConfig.RuntimeParams["search_path"] = schema + ",pg_catalog"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	clocked := &postgres.Store{Pool: pool}
	owner, active, _ := admissionRows(t, clocked, ctx, 101)
	if _, err := pool.Exec(ctx, `UPDATE workers SET last_seen_at=statement_timestamp()-interval '119 seconds'
 WHERE user_id=$1 AND (worker_id=$2 OR worker_id IN
 (SELECT worker_id FROM workers WHERE user_id=$1 AND worker_id<>$2 ORDER BY last_seen_at DESC LIMIT 1))`, owner, active); err != nil {
		t.Fatal(err)
	}
	before := admissionStoredRows(t, clocked, ctx, owner)
	read := func(want int) store.WorkerAdmission {
		t.Helper()
		tx := admissionTransaction(t, clocked, ctx)
		got, err := worker.NewWriter(tx).AdmitWorker(ctx, owner, active, admissionWindow)
		if err != nil || got.ActiveCount != want || got.LastSeenAt == nil {
			t.Fatalf("count at controlled clock: %+v %v", got, err)
		}
		if err := tx.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
		return got
	}
	initial := read(101)
	if _, err := pool.Exec(ctx, `UPDATE worker_test_clock SET observed_at=observed_at+interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if after := admissionStoredRows(t, clocked, ctx, owner); after != before {
		t.Fatal("clock advancement changed stored Worker rows")
	}
	expired := read(99)
	if !expired.ObservedAt.Equal(initial.ObservedAt.Add(time.Second)) || !expired.LastSeenAt.Equal(*initial.LastSeenAt) {
		t.Fatalf("expiry changed the target instead of observation time: before=%+v after=%+v", initial, expired)
	}
	if after := admissionStoredRows(t, clocked, ctx, owner); after != before {
		t.Fatal("expiry admission changed stored Worker rows")
	}
}
