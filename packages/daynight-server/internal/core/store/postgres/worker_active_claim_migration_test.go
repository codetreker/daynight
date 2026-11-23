package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	migration115 "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/schema/migrations/115"
	taskdao "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const workerActiveClaimIndex = "task_properties_worker_active_claim_idx"

const workerActiveClaimMigrationPosition = 112

func workerActiveClaimMigrations(t *testing.T) []migration {
	t.Helper()
	if len(schemaMigrations) <= workerActiveClaimMigrationPosition || schemaMigrations[workerActiveClaimMigrationPosition].version != 115 {
		t.Fatal("migration 115 must follow 114 with historical 84/85 gaps")
	}
	return schemaMigrations[:workerActiveClaimMigrationPosition+1]
}

func workerIndexFixture(t *testing.T) string {
	t.Helper()
	worker := &model.WorkerClaim{ClaimID: queryID(101), State: model.WorkerActive, UserID: "ABCDEF01-ABCD-ABCD-ABCD-ABCDEF012345", WorkerID: queryID(103),
		Machine: model.WorkerMachine{ID: queryID(104), Name: "Historical machine"}, Platform: model.PlatformWindows, Agent: model.AgentCodex,
		AgentControlMode: model.AgentControlModeHerdr, WorktreeID: queryID(105), Phase: model.WorkerExecuting,
		Herdr: &model.WorkerHerdr{Session: "s", WorkspaceID: "w", PaneID: "p"}, ClaimedAt: time.Date(2020, 1, 2, 0, 0, 0, 0, time.UTC)}
	raw, err := taskproperty.EncodeWorker(worker)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func workerIndexOldPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := emptyPool(t)
	if err := migrate(t.Context(), pool, workerActiveClaimMigrations(t)[:workerActiveClaimMigrationPosition]); err != nil {
		t.Fatal(err)
	}
	return pool
}

func workerIndexState(t *testing.T, pool *pgxpool.Pool) (ledger bool, definition *string, valid *bool) {
	t.Helper()
	if err := pool.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=115),
 (SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indexrelid=to_regclass($1)),
 (SELECT indisvalid AND indisready FROM pg_index WHERE indexrelid=to_regclass($1))`, workerActiveClaimIndex).Scan(&ledger, &definition, &valid); err != nil {
		t.Fatal(err)
	}
	return
}

func TestWorkerActiveClaimMigrationPreservesFactsAndReopens(t *testing.T) {
	pool := workerIndexOldPool(t)
	database := &Store{Pool: pool}
	project := queryProject(t, database, 10)
	for i := range 130 {
		raw := workerIndexFixture(t)
		if i%2 == 1 {
			raw = strings.Replace(raw, `"state":"active"`, `"state":"completed"`, 1)
		}
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,status,version) VALUES($1,$2,'Historical','in_progress',37)`, queryID(1000+i), project.ID)
		mustQueryExec(t, database, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2),($1,'pullRequests','[{"url":"\u0000","title":"\ud800"}]')`, queryID(1000+i), raw)
	}
	facts := func() string {
		var value string
		if err := pool.QueryRow(t.Context(), `SELECT jsonb_build_object('tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t),'properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY task_id,name) FROM task_properties p),'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p))::text`).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := facts()
	if err := migrate(t.Context(), pool, workerActiveClaimMigrations(t)); err != nil {
		t.Fatal(err)
	}
	if after := facts(); before != after {
		t.Fatal("index migration changed task, property or Sync fence facts")
	}
	ledger, definition, valid := workerIndexState(t, pool)
	if !ledger || definition == nil || valid == nil || !*valid || !strings.Contains(*definition, `COLLATE "C"`) || !strings.Contains(*definition, "active") {
		t.Fatalf("index not committed: %v %v %v", ledger, definition, valid)
	}
	var checksum string
	if err := pool.QueryRow(t.Context(), `SELECT checksum FROM schema_migrations WHERE version=115`).Scan(&checksum); err != nil || checksum != schemaMigrations[workerActiveClaimMigrationPosition].checksum() {
		t.Fatalf("checksum=%s err=%v", checksum, err)
	}
	reader := func(db *Store) []string {
		t.Helper()
		tx, err := db.Pool.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(t.Context())
		var ids []string
		page, err := taskdao.NewReader(tx).Tasks(t.Context(), project.ID, store.TaskQuery{Page: store.Page{Limit: 100}, Worker: &store.WorkerQuery{UserID: "ABCDEF01-ABCD-ABCD-ABCD-ABCDEF012345", WorkerID: queryID(103)}})
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range page.Items {
			ids = append(ids, item.ID)
		}
		if page.HasMore {
			t.Fatal("unexpected original inventory continuation")
		}
		mismatch, err := taskdao.NewReader(tx).Tasks(t.Context(), project.ID, store.TaskQuery{Page: store.Page{Limit: 100}, Worker: &store.WorkerQuery{UserID: "abcdef01-abcd-abcd-abcd-abcdef012345", WorkerID: queryID(103)}})
		if err != nil || len(mismatch.Items) != 0 {
			t.Fatalf("original inventory lost exact UUID comparison: %d %v", len(mismatch.Items), err)
		}
		return ids
	}
	want := reader(database)
	if len(want) != 65 {
		t.Fatalf("active claims=%d", len(want))
	}
	if err := migrate(t.Context(), pool, workerActiveClaimMigrations(t)); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(t.Context(), pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if got := reader(reopened); !reflect.DeepEqual(got, want) {
		t.Fatal("same-ledger startup changed claims")
	}
	if err := migrate(t.Context(), pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
}

func TestWorkerActiveClaimMigrationRejectsInvalidRowsAtomically(t *testing.T) {
	for _, test := range []struct{ name, raw, reason string }{
		{"shape", `{}`, "worker shape"}, {"invalid JSON", `{`, "worker shape"},
		{"duplicate", strings.Replace(workerIndexFixture(t), `"state":"active"`, `"state":"active","state":"completed"`, 1), "worker shape"},
		{"PostgreSQL conversion", strings.Replace(workerIndexFixture(t), "Historical machine", `\ud800`, 1), "PostgreSQL worker extraction"},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := workerIndexOldPool(t)
			id := queryID(1000)
			if _, err := pool.Exec(t.Context(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, id, test.raw); err != nil {
				t.Fatal(err)
			}
			err := migrate(t.Context(), pool, workerActiveClaimMigrations(t))
			var transaction *store.TransactionError
			var propertyError *migration115.WorkerPropertyError
			if err == nil || !errors.As(err, &transaction) || !errors.As(err, &propertyError) || propertyError.TaskID != id || !workerMigrationErrorContains(transaction.Cause, id) || !workerMigrationErrorContains(transaction.Cause, test.reason) {
				t.Fatalf("failure lacks Task identity/reason: %v", err)
			}
			if propertyError.Unwrap() == nil {
				t.Fatal("migration discarded worker failure cause")
			}
			if test.name == "PostgreSQL conversion" {
				var postgresError *pgconn.PgError
				if !errors.As(err, &postgresError) {
					t.Fatal("PostgreSQL conversion cause was lost")
				}
			}
			ledger, definition, valid := workerIndexState(t, pool)
			if ledger || definition != nil || valid != nil {
				t.Fatal("failed migration left index or ledger")
			}
			var raw string
			if err := pool.QueryRow(t.Context(), `SELECT value FROM task_properties WHERE task_id=$1 AND name='worker'`, id).Scan(&raw); err != nil || raw != test.raw {
				t.Fatalf("raw property changed: %v", err)
			}
			assertMigrationPoolReusable(t, pool)
		})
	}
}

func workerMigrationErrorContains(err error, text string) bool {
	if err == nil {
		return false
	}
	if strings.Contains(err.Error(), text) {
		return true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for _, cause := range joined.Unwrap() {
			if workerMigrationErrorContains(cause, text) {
				return true
			}
		}
		return false
	}
	return workerMigrationErrorContains(errors.Unwrap(err), text)
}

func TestWorkerActiveClaimMigrationShareLockAndCancellation(t *testing.T) {
	pool := workerIndexOldPool(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err := blocker.Exec(ctx, `LOCK TABLE task_properties IN ROW EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	instance, application := migrationInstance(t, pool)
	migrationCtx, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- migrate(migrationCtx, instance, workerActiveClaimMigrations(t)) }()
	waitForMigration(t, func() bool {
		var waiting bool
		return pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE l.relation='task_properties'::regclass AND l.mode='ShareLock' AND NOT l.granted AND a.application_name=$1)`, application).Scan(&waiting) == nil && waiting
	})
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM task_properties`).Scan(&count); err != nil {
		t.Fatal("SHARE wait blocked reader", err)
	}
	stop()
	if err := <-done; err == nil || !(errors.Is(err, context.Canceled) || strings.Contains(err.Error(), "context canceled")) {
		t.Fatalf("cancellation=%v", err)
	}
	ledger, definition, _ := workerIndexState(t, pool)
	if ledger || definition != nil {
		t.Fatal("cancelled migration committed")
	}
	if err := blocker.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, workerActiveClaimMigrations(t)); err != nil {
		t.Fatal(err)
	}
	assertMigrationPoolReusable(t, instance)
}

func TestWorkerActiveClaimMigrationShareLockAllowsReadsAndWaitsWrites(t *testing.T) {
	pool := workerIndexOldPool(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	next := schemaMigrations[workerActiveClaimMigrationPosition]
	if _, err := tx.Exec(ctx, next.sql); err != nil {
		t.Fatal(err)
	}
	if err := next.transform(ctx, tx); err != nil {
		t.Fatal(err)
	}
	writer, application := migrationInstance(t, pool)
	done := make(chan error, 1)
	go func() {
		_, err := writer.Exec(ctx, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests','[]')`, queryID(2000))
		done <- err
	}()
	waitForMigration(t, func() bool {
		var waiting bool
		return pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE l.relation='task_properties'::regclass AND l.mode='RowExclusiveLock' AND NOT l.granted AND a.application_name=$1)`, application).Scan(&waiting) == nil && waiting
	})
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM task_properties`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("reader failed during SHARE lock: %d %v", count, err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	ledger, definition, _ := workerIndexState(t, pool)
	if ledger || definition != nil {
		t.Fatal("rollback retained index or ledger")
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM task_properties WHERE task_id=$1`, queryID(2000)).Scan(&count); err != nil || count != 1 {
		t.Fatalf("waiting write did not commit: %d %v", count, err)
	}
}

func TestWorkerActiveClaimIndexMaintainsMembership(t *testing.T) {
	pool := workerIndexOldPool(t)
	raw := workerIndexFixture(t)
	if _, err := pool.Exec(t.Context(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, queryID(1000), raw); err != nil {
		t.Fatal(err)
	}
	if err := migrate(t.Context(), pool, workerActiveClaimMigrations(t)); err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &fields); err != nil {
		t.Fatal(err)
	}
	fields["state"] = json.RawMessage(`"completed"`)
	completed, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE task_properties SET value=$2 WHERE task_id=$1 AND name='worker'`, queryID(1000), string(completed)); err != nil {
		t.Fatal(err)
	}
	var count int
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `SET LOCAL enable_seqscan=off`); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(t.Context(), `SELECT count(*) FROM task_properties WHERE name='worker' AND ((CASE WHEN name='worker' THEN value::jsonb END)->>'state') COLLATE "C"='active'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("completed index member retained: %d %v", count, err)
	}
	var plan string
	if err := tx.QueryRow(t.Context(), `EXPLAIN (ANALYZE,FORMAT JSON) SELECT task_id FROM task_properties WHERE name='worker' AND ((CASE WHEN name='worker' THEN value::jsonb END)->>'state') COLLATE "C"='active'`).Scan(&plan); err != nil || !strings.Contains(plan, workerActiveClaimIndex) {
		t.Fatalf("index membership not exercised: %s %v", plan, err)
	}
}
