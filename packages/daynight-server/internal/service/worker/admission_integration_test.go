package worker

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// seedAdmission copies an ordinary successful snapshot so the test exercises the
// real inventory and configuration formats while creating legacy over-limit data.
func seedAdmission(t *testing.T, db *postgres.Store, workers *Workers, principal model.Principal, active int) (string, string) {
	t.Helper()
	ctx := context.Background()
	if _, err := db.Pool.Exec(ctx, `DELETE FROM workers WHERE user_id=$1`, principal.UserID); err != nil {
		t.Fatal(err)
	}
	first, inactive := uuid.NewString(), uuid.NewString()
	initial := admissionReport()
	initial.Configuration.Observation = nil
	if _, err := workers.Report(ctx, principal, first, initial); err != nil {
		t.Fatal(err)
	}
	_, err := db.Pool.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot)
		SELECT user_id,gen_random_uuid(),created_at,last_seen_at,telemetry,task_snapshot FROM workers CROSS JOIN generate_series(1,$3::int)
		WHERE user_id=$1 AND worker_id=$2`, principal.UserID, first, active-1)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot)
		SELECT user_id,$3,created_at,statement_timestamp()-interval '121 seconds',telemetry,task_snapshot FROM workers WHERE user_id=$1 AND worker_id=$2`, principal.UserID, first, inactive)
	if err != nil {
		t.Fatal(err)
	}
	return first, inactive
}

func admissionState(t *testing.T, db *postgres.Store, userID string) string {
	t.Helper()
	var state string
	if err := db.Pool.QueryRow(context.Background(), `SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY worker_id),'[]'::jsonb)::text FROM workers w WHERE user_id=$1`, userID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func admissionReport() model.WorkerReport {
	report := serviceWorkerReport()
	report.Telemetry.Machine.Name = "Admission report"
	report.Telemetry.SampledAt = time.Now().Add(24 * time.Hour)
	report.TaskInventory = &model.WorkerTaskInventory{ObservedAt: time.Now(), Claims: []model.WorkerTaskReference{}}
	value := cloudWorkerConfiguration("")
	report.Configuration = &model.WorkerConfigurationExchange{Bootstrap: &value, Observation: &model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{}}}
	return report
}

func TestWorkerAdmissionCountsAndRollback(t *testing.T) {
	_, db, _, principal := testsupport.ProjectService(t)
	workers := NewWorkers(db)
	for _, count := range []int{99, 100, 101} {
		for _, kind := range []string{"active", "new", "inactive"} {
			t.Run(fmt.Sprintf("%d/%s", count, kind), func(t *testing.T) {
				active, inactive := seedAdmission(t, db, workers, principal, count)
				id := uuid.NewString()
				if kind == "active" {
					id = active
				} else if kind == "inactive" {
					id = inactive
				}
				before := admissionState(t, db, principal.UserID)
				result, err := workers.Report(context.Background(), principal, id, admissionReport())
				allowed := count < 100 || count == 100 && kind == "active"
				if allowed {
					if err != nil || result.LastReportedAt.IsZero() || result.Configuration == nil || result.Configuration.Desired == nil {
						t.Fatalf("report: %+v, %v", result, err)
					}
				} else {
					requireFault(t, err, "active_worker_limit_exceeded")
					if after := admissionState(t, db, principal.UserID); after != before {
						t.Fatal("refused report changed worker rows")
					}
				}
			})
		}
	}
	other := testsupport.ServicePrincipal(t, db)
	if _, err := workers.Report(context.Background(), other, uuid.NewString(), admissionReport()); err != nil {
		t.Fatalf("another owner's slot was consumed: %v", err)
	}
}

func TestWorkerAdmissionConcurrentStores(t *testing.T) {
	_, db, databaseURL, principal := testsupport.ProjectService(t)
	second, err := postgres.Open(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	workers := NewWorkers(db)
	_, inactive := seedAdmission(t, db, workers, principal, 99)
	ids := []string{uuid.NewString(), inactive}
	services := []*Workers{workers, NewWorkers(second)}
	upperPrincipal := principal
	upperPrincipal.UserID = strings.ToUpper(principal.UserID)
	principals := []model.Principal{principal, upperPrincipal}
	row := func(id string) string {
		var state string
		if err := db.Pool.QueryRow(context.Background(), `SELECT COALESCE((SELECT to_jsonb(w)::text FROM workers w WHERE user_id=$1 AND worker_id=$2),'missing')`, principal.UserID, id).Scan(&state); err != nil {
			t.Fatal(err)
		}
		return state
	}
	beforeRows := []string{row(ids[0]), row(ids[1])}
	start := make(chan struct{})
	type outcome struct {
		index int
		err   error
	}
	results := make(chan outcome, 2)
	for i := range ids {
		go func(i int) {
			<-start
			_, err := services[i].Report(context.Background(), principals[i], ids[i], admissionReport())
			results <- outcome{index: i, err: err}
		}(i)
	}
	close(start)
	wins := 0
	for range 2 {
		result := <-results
		if result.err == nil {
			wins++
		} else {
			requireFault(t, result.err, "active_worker_limit_exceeded")
			if after := row(ids[result.index]); after != beforeRows[result.index] {
				t.Fatal("losing concurrent report changed its row")
			}
		}
	}
	if wins != 1 {
		t.Fatalf("expected one winner, got %d", wins)
	}
	var count int
	if err := db.Pool.QueryRow(context.Background(), `SELECT count(*) FROM workers WHERE user_id=$1 AND last_seen_at>statement_timestamp()-interval '120 seconds' AND last_seen_at<=statement_timestamp()`, principal.UserID).Scan(&count); err != nil || count != 100 {
		t.Fatalf("active count=%d, %v", count, err)
	}
	before := admissionState(t, db, principal.UserID)
	_, err = workers.Report(context.Background(), principal, uuid.NewString(), admissionReport())
	requireFault(t, err, "active_worker_limit_exceeded")
	if after := admissionState(t, db, principal.UserID); after != before {
		t.Fatal("101st report changed worker rows")
	}
}

func TestWorkerAdmissionFutureTimestampAndConfigurationFailure(t *testing.T) {
	_, db, _, principal := testsupport.ProjectService(t)
	workers := NewWorkers(db)
	ctx := context.Background()
	active, _ := seedAdmission(t, db, workers, principal, 99)
	if _, err := db.Pool.Exec(ctx, `UPDATE workers SET last_seen_at=statement_timestamp()+interval '1 hour' WHERE user_id=$1 AND worker_id=$2`, principal.UserID, active); err != nil {
		t.Fatal(err)
	}
	result, err := workers.Report(ctx, principal, active, admissionReport())
	if err != nil || result.LastReportedAt.After(result.ObservedAt) || result.ObservedAt.Sub(result.LastReportedAt) > time.Second*10 {
		t.Fatalf("future timestamp was not replaced: %+v %v", result, err)
	}
	before := admissionState(t, db, principal.UserID)
	id := uuid.NewString()
	report := admissionReport()
	missing := cloudWorkerConfiguration(uuid.NewString())
	report.Configuration.Bootstrap = &missing
	_, err = workers.Report(ctx, principal, id, report)
	requireFault(t, err, "not_found")
	if after := admissionState(t, db, principal.UserID); after != before {
		t.Fatal("configuration failure committed snapshot")
	}
	if _, err := workers.Report(ctx, principal, id, admissionReport()); err != nil {
		t.Fatalf("report after rollback: %v", err)
	}
}

func waitAdmissionLock(t *testing.T, db *postgres.Store, blockerPID uint32, result <-chan error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		var waiting bool
		if err := db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=current_schema() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)))`, blockerPID).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		select {
		case err := <-result:
			t.Fatalf("report completed before lock wait: %v", err)
		case <-ctx.Done():
			t.Fatal("report did not wait for admission lock")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func lockAdmission(t *testing.T, db *postgres.Store, userID string) pgx.Tx {
	t.Helper()
	tx, err := db.Pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(context.Background(), `SELECT pg_advisory_xact_lock(hashtextextended('worker-admission:' || $1::uuid::text, 0))`, userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	return tx
}

func TestWorkerAdmissionWaitRechecksClockAndCancellation(t *testing.T) {
	_, db, _, principal := testsupport.ProjectService(t)
	workers := NewWorkers(db)
	ctx := context.Background()
	active, _ := seedAdmission(t, db, workers, principal, 100)
	holder := lockAdmission(t, db, principal.UserID)
	out := make(chan error, 1)
	var result WorkerReportResult
	upperPrincipal := principal
	upperPrincipal.UserID = strings.ToUpper(principal.UserID)
	go func() {
		var err error
		result, err = workers.Report(ctx, upperPrincipal, uuid.NewString(), admissionReport())
		out <- err
	}()
	waitAdmissionLock(t, db, holder.Conn().PgConn().PID(), out)
	other := testsupport.ServicePrincipal(t, db)
	if _, err := workers.Report(ctx, other, uuid.NewString(), admissionReport()); err != nil {
		t.Fatalf("different owner blocked: %v", err)
	}
	var fixtureAt time.Time
	if err := db.Pool.QueryRow(ctx, `UPDATE workers SET last_seen_at=statement_timestamp()-interval '121 seconds' WHERE user_id=$1 AND worker_id=$2 RETURNING statement_timestamp()`, principal.UserID, active).Scan(&fixtureAt); err != nil {
		t.Fatal(err)
	}
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-out; err != nil || !result.LastReportedAt.After(fixtureAt) {
		t.Fatalf("report did not resample after waiting: %+v %v", result, err)
	}

	holder = lockAdmission(t, db, principal.UserID)
	before := admissionState(t, db, principal.UserID)
	canceled, cancel := context.WithCancel(ctx)
	out = make(chan error, 1)
	go func() { _, err := workers.Report(canceled, principal, active, admissionReport()); out <- err }()
	waitAdmissionLock(t, db, holder.Conn().PgConn().PID(), out)
	cancel()
	if err := <-out; !errors.Is(err, context.Canceled) {
		t.Fatalf("lost lock-wait cancellation: %v", err)
	}
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if after := admissionState(t, db, principal.UserID); after != before {
		t.Fatal("canceled report changed rows")
	}
	if _, err := workers.Report(ctx, principal, active, admissionReport()); err == nil {
		t.Fatal("inactive report unexpectedly accepted at full capacity")
	} else {
		requireFault(t, err, "active_worker_limit_exceeded")
	}
	if _, err := workers.Report(ctx, principal, resultID(t, db, principal.UserID), admissionReport()); err != nil {
		t.Fatalf("lock remained held after cancellation: %v", err)
	}
}

func resultID(t *testing.T, db *postgres.Store, userID string) string {
	t.Helper()
	var id string
	if err := db.Pool.QueryRow(context.Background(), `SELECT worker_id::text FROM workers WHERE user_id=$1 AND last_seen_at>statement_timestamp()-interval '120 seconds' AND last_seen_at<=statement_timestamp() LIMIT 1`, userID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestWorkerAdmissionOverLimitNaturallyExpires(t *testing.T) {
	_, db, databaseURL, principal := testsupport.ProjectService(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var schema string
	if err := db.Pool.QueryRow(ctx, `SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `CREATE TABLE worker_test_clock (observed_at timestamptz NOT NULL);
		INSERT INTO worker_test_clock VALUES (statement_timestamp());
		CREATE FUNCTION statement_timestamp() RETURNS timestamptz LANGUAGE sql STABLE AS 'SELECT observed_at FROM worker_test_clock'`); err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	params := parsed.Query()
	// Listing pg_catalog explicitly after the fixture schema makes the local
	// statement_timestamp function control every statement in this store.
	params.Set("search_path", schema+",pg_catalog")
	parsed.RawQuery = params.Encode()
	clocked, err := postgres.Open(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer clocked.Close()
	workers := NewWorkers(clocked)
	active, _ := seedAdmission(t, clocked, workers, principal, 101)
	if _, err := clocked.Pool.Exec(ctx, `UPDATE workers SET last_seen_at=statement_timestamp()-interval '119 seconds' WHERE user_id=$1 AND (worker_id=$2 OR worker_id IN (SELECT worker_id FROM workers WHERE user_id=$1 AND worker_id<>$2 ORDER BY last_seen_at DESC LIMIT 1))`, principal.UserID, active); err != nil {
		t.Fatal(err)
	}
	before := admissionState(t, clocked, principal.UserID)
	_, err = workers.Report(ctx, principal, active, admissionReport())
	requireFault(t, err, "active_worker_limit_exceeded")
	if after := admissionState(t, clocked, principal.UserID); after != before {
		t.Fatal("over-limit renewal changed rows")
	}
	if _, err := clocked.Pool.Exec(ctx, `UPDATE worker_test_clock SET observed_at=observed_at+interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if after := admissionState(t, clocked, principal.UserID); after != before {
		t.Fatal("clock advancement changed worker rows")
	}
	var count int
	if err := clocked.Pool.QueryRow(ctx, `SELECT count(*) FROM workers WHERE user_id=$1 AND last_seen_at>statement_timestamp()-interval '120 seconds' AND last_seen_at<=statement_timestamp()`, principal.UserID).Scan(&count); err != nil || count != 99 {
		t.Fatalf("boundary active count=%d, %v", count, err)
	}
	if _, err := workers.Report(ctx, principal, active, admissionReport()); err != nil {
		t.Fatalf("report after natural expiry: %v", err)
	}
}

func TestWorkerAdmissionDatabaseFailureReleasesLock(t *testing.T) {
	_, db, _, principal := testsupport.ProjectService(t)
	workers := NewWorkers(db)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	active, _ := seedAdmission(t, db, workers, principal, 99)
	before := admissionState(t, db, principal.UserID)
	if _, err := db.Pool.Exec(ctx, `ALTER TABLE workers RENAME COLUMN last_seen_at TO unavailable_last_seen_at`); err != nil {
		t.Fatal(err)
	}
	_, reportErr := workers.Report(ctx, principal, active, admissionReport())
	if _, err := db.Pool.Exec(ctx, `ALTER TABLE workers RENAME COLUMN unavailable_last_seen_at TO last_seen_at`); err != nil {
		t.Fatal(err)
	}
	if reportErr == nil {
		t.Fatal("database failure was hidden")
	}
	if after := admissionState(t, db, principal.UserID); after != before {
		t.Fatal("database failure changed worker rows")
	}
	if _, err := workers.Report(ctx, principal, active, admissionReport()); err != nil {
		t.Fatalf("report after database failure: %v", err)
	}
}
