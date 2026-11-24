package postgres

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMigrationsRejectInvalidHistory(t *testing.T) {
	database := isolatedStore(t)
	ledger := func(t *testing.T) string {
		t.Helper()
		var records string
		if err := database.Pool.QueryRow(t.Context(), "SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m").Scan(&records); err != nil {
			t.Fatal(err)
		}
		return records
	}
	before := ledger(t)
	for _, test := range []struct{ name, sql, want string }{
		{"checksum", `UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = 1`, "checksum mismatch"},
		{"gap", `DELETE FROM schema_migrations WHERE version = 1`, "not an ordered prefix"},
		{"unknown", fmt.Sprintf(`INSERT INTO schema_migrations (version, checksum) VALUES (%d, repeat('0', 64))`, schemaMigrations[len(schemaMigrations)-1].version+1), "not an ordered prefix"},
	} {
		if !t.Run(test.name, func(t *testing.T) {
			if before != ledger(t) {
				t.Fatal("previous fault changed the shared migration ledger")
			}
			if _, err := database.Pool.Exec(t.Context(), test.sql); err != nil {
				t.Fatal(err)
			}
			err := migrate(t.Context(), database.Pool, schemaMigrations)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("expected %q, got %v", test.want, err)
			}
			assertMigrationPoolReusable(t, database.Pool)
			if _, err := database.Pool.Exec(t.Context(), "DELETE FROM schema_migrations"); err != nil {
				t.Fatal(err)
			}
			if _, err := database.Pool.Exec(t.Context(), "INSERT INTO schema_migrations SELECT * FROM jsonb_populate_recordset(NULL::schema_migrations,$1::jsonb)", before); err != nil {
				t.Fatal(err)
			}
			if before != ledger(t) {
				t.Fatal("migration ledger was not restored exactly")
			}
		}) {
			return
		}
	}
}

func TestMigrationChecksumsIncludeRawSQLBytes(t *testing.T) {
	database := isolatedStore(t)
	changed := append([]migration(nil), schemaMigrations...)
	changed[0].sql += "\n"
	if err := migrate(context.Background(), database.Pool, changed); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("whitespace-only SQL change was accepted: %v", err)
	}
}

func TestMigrationsRollbackCurrentRetainPrior(t *testing.T) {
	for _, test := range []struct {
		name string
		next migration
		code string
	}{
		{"sql failure", migration{version: 2, sql: "CREATE TABLE second_marker (id int); SELECT 1 / 0"}, "22012"},
		{"version insert failure", migration{version: 1, sql: "CREATE TABLE second_marker (id int)"}, "23505"},
		{"commit failure", migration{version: 2, sql: "CREATE TABLE second_marker (id int UNIQUE DEFERRABLE INITIALLY DEFERRED); INSERT INTO second_marker VALUES (1), (1)"}, "23505"},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := emptyPool(t)
			first := migration{version: 1, sql: "CREATE TABLE first_marker (id int)"}
			err := migrate(context.Background(), pool, []migration{first, test.next})
			var failure *pgconn.PgError
			if !errors.As(err, &failure) || failure.Code != test.code {
				t.Fatalf("expected PostgreSQL %s, got %v", test.code, err)
			}
			var versions int
			var firstTable, secondTable *string
			if err := pool.QueryRow(context.Background(), "SELECT count(*), to_regclass('first_marker')::text, to_regclass('second_marker')::text FROM schema_migrations").Scan(&versions, &firstTable, &secondTable); err != nil || versions != 1 || firstTable == nil || secondTable != nil {
				t.Fatalf("partial migration: versions=%d first=%v second=%v error=%v", versions, firstTable, secondTable, err)
			}
			assertMigrationPoolReusable(t, pool)
		})
	}
}

func TestMigrationsSessionLockSpansCommits(t *testing.T) {
	pool := emptyPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	blocker, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Release()
	const barrier int64 = 78131
	if _, err := blocker.Exec(ctx, "SELECT pg_advisory_lock($1)", barrier); err != nil {
		t.Fatal(err)
	}
	held := true
	defer func() {
		if held {
			_, _ = blocker.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", barrier)
		}
	}()
	migrations := []migration{
		{version: 1, sql: "CREATE TABLE first_marker (id int)"},
		{version: 2, sql: "SELECT pg_advisory_xact_lock(78131); CREATE TABLE second_marker (id int)"},
	}
	firstPool, firstApplication := migrationInstance(t, pool)
	secondPool, secondApplication := migrationInstance(t, pool)
	first, second := make(chan error, 1), make(chan error, 1)
	go func() { first <- migrate(ctx, firstPool, migrations) }()
	waitForMigration(t, func() bool {
		var blocked bool
		return pool.QueryRow(ctx, `SELECT EXISTS (
			SELECT FROM pg_locks locks JOIN pg_stat_activity activity USING (pid)
			WHERE locks.locktype = 'advisory' AND locks.objid = 78131 AND NOT locks.granted
			AND activity.application_name = $1
		)`, firstApplication).Scan(&blocked) == nil && blocked
	})
	var applied int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&applied); err != nil || applied != 1 {
		t.Fatalf("first migration did not commit: %d, %v", applied, err)
	}
	go func() { second <- migrate(ctx, secondPool, migrations) }()
	waitForMigration(t, func() bool {
		var blocked bool
		return pool.QueryRow(ctx, `SELECT EXISTS (
			SELECT FROM pg_locks locks JOIN pg_stat_activity activity USING (pid)
			WHERE locks.locktype = 'advisory' AND locks.classid = $1::oid AND locks.objid = $2::oid AND NOT locks.granted
			AND activity.application_name = $3
		)`, migrationLock>>32, migrationLock&0xffffffff, secondApplication).Scan(&blocked) == nil && blocked
	})
	if _, err := blocker.Exec(ctx, "SELECT pg_advisory_unlock($1)", barrier); err != nil {
		t.Fatal(err)
	}
	held = false
	for _, result := range []chan error{first, second} {
		select {
		case err := <-result:
			if err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	blocker.Release()
	assertMigrationPoolReusable(t, pool)
	assertMigrationPoolReusable(t, firstPool)
	assertMigrationPoolReusable(t, secondPool)
}

func TestMigrationsCanceledLockWaitReleasesResources(t *testing.T) {
	pool := emptyPool(t)
	blocker, err := pool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Release()
	if _, err := blocker.Exec(context.Background(), "SELECT pg_advisory_lock($1)", migrationLock); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err = migrate(ctx, pool, schemaMigrations)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline, got %v", err)
	}
	if _, err := blocker.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", migrationLock); err != nil {
		t.Fatal(err)
	}
	blocker.Release()
	if err := migrate(context.Background(), pool, schemaMigrations); err != nil {
		t.Fatalf("migration after cancellation: %v", err)
	}
	assertMigrationPoolReusable(t, pool)
}

func TestMigrationConnectionClosedWhenUnlockFails(t *testing.T) {
	pool := emptyPool(t)
	conn, err := pool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	physical := conn.Conn()
	if _, err := conn.Exec(context.Background(), "SELECT pg_advisory_lock($1)", migrationLock); err != nil {
		t.Fatal(err)
	}
	rows, err := conn.Query(context.Background(), "SELECT generate_series(1, 10)")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if err := releaseMigrationConnection(conn); err == nil || !physical.IsClosed() {
		t.Fatalf("failed unlock must close physical connection: %v", err)
	}
	assertMigrationPoolReusable(t, pool)
}

func TestMigrationsCancellationAndMetadataFailures(t *testing.T) {
	t.Run("acquire", func(t *testing.T) {
		pool := emptyPool(t)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if err := migrate(ctx, pool, schemaMigrations); !errors.Is(err, context.Canceled) {
			t.Fatalf("expected canceled acquisition: %v", err)
		}
	})
	t.Run("bootstrap", func(t *testing.T) {
		pool := emptyPool(t)
		if _, err := pool.Exec(context.Background(), "SET default_transaction_read_only = on"); err != nil {
			t.Fatal(err)
		}
		if err := migrate(context.Background(), pool, schemaMigrations); err == nil {
			t.Fatal("expected read-only metadata creation failure")
		}
	})
	for _, test := range []struct{ name, ddl string }{
		{"query", "CREATE TABLE schema_migrations (version bigint)"},
		{"scan", "CREATE TABLE schema_migrations (version text, checksum text); INSERT INTO schema_migrations VALUES ('not-an-integer', repeat('0',64))"},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := emptyPool(t)
			if _, err := pool.Exec(context.Background(), test.ddl); err != nil {
				t.Fatal(err)
			}
			if err := migrate(context.Background(), pool, schemaMigrations); err == nil {
				t.Fatal("expected invalid metadata failure")
			}
			assertMigrationPoolReusable(t, pool)
		})
	}
	t.Run("begin", func(t *testing.T) {
		pool := emptyPool(t)
		config := pool.Config()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		config.ConnConfig.Tracer = &migrationCancelTracer{cancel: cancel}
		traced, err := pgxpool.NewWithConfig(context.Background(), config)
		if err != nil {
			t.Fatal(err)
		}
		defer traced.Close()
		if err := migrate(ctx, traced, schemaMigrations); !errors.Is(err, context.Canceled) {
			t.Fatalf("expected canceled migration begin: %v", err)
		}
		assertMigrationPoolReusable(t, traced)
	})
}

type migrationCancelTracer struct {
	cancel  context.CancelFunc
	matched atomic.Bool
}

func (tracer *migrationCancelTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.HasPrefix(data.SQL, "SELECT version, checksum") {
		tracer.matched.Store(true)
	}
	return ctx
}

func (tracer *migrationCancelTracer) TraceQueryEnd(_ context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if tracer.matched.Swap(false) {
		tracer.cancel()
	}
}

func waitForMigration(t *testing.T, ready func() bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for !ready() {
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("timed out waiting for migration barrier")
		}
	}
}

func assertMigrationPoolReusable(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	waitForMigration(t, func() bool { return pool.Stat().AcquiredConns() == 0 })
	conn, err := pool.Acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	application := pool.Config().ConnConfig.RuntimeParams["application_name"]
	waitForMigration(t, func() bool {
		var unlocked bool
		return conn.QueryRow(context.Background(), `SELECT NOT EXISTS (
			SELECT FROM pg_locks locks JOIN pg_stat_activity activity USING (pid)
			WHERE locks.locktype = 'advisory' AND locks.classid = $1::oid AND locks.objid = $2::oid AND locks.granted
			AND activity.application_name = $3
		)`, migrationLock>>32, migrationLock&0xffffffff, application).Scan(&unlocked) == nil && unlocked
	})
}

func migrationInstance(t *testing.T, pool *pgxpool.Pool) (*pgxpool.Pool, string) {
	t.Helper()
	config := pool.Config()
	application := "migration_" + strings.ToLower(rand.Text())
	config.ConnConfig.RuntimeParams["application_name"] = application
	config.MaxConns = 1
	instance, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(instance.Close)
	return instance, application
}

func TestHistoricalUpgradePreservesMaterialsAndCreatesOAuthTables(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:13]); err != nil {
		t.Fatal(err)
	}
	s := &Store{Pool: pool}
	mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,'legacy-user',now(),now())`, queryID(2))
	mustQueryExec(t, s, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Legacy project','https://example.test/repo')`, queryID(1))
	mustQueryExec(t, s, `INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'admin')`, queryID(1), queryID(2))
	mustQueryExec(t, s, `INSERT INTO tasks(id,project_id,title,description,status,version,allow_agents,required_platform,properties)
		VALUES($1,$3,'Legacy task','## Original Markdown','proposed',9007199254740993,true,'linux',
		'{"pullRequests":[{"url":"https://example.test/pr","title":"Original"}]}'),
		($2,$3,'Dependency','Preserved','done',7,false,NULL,'{"pullRequests":[]}')`, queryID(10), queryID(11), queryID(1))
	mustQueryExec(t, s, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,false)`, queryID(1), queryID(10), queryID(11))
	mustQueryExec(t, s, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'nested/plan.md','text/markdown',123)`, queryID(1), queryID(10))

	facts := statusMigrationRelatedFacts(t, s)
	before := statusMigrationRows(t, s)
	if err := migrate(ctx, pool, schemaMigrations[:14]); err != nil {
		t.Fatal(err)
	}
	afterStatus := statusMigrationRows(t, s)
	if len(afterStatus) != 2 || afterStatus[0].Status != "todo" || afterStatus[0].Version != before[0].Version+1 || afterStatus[0].Materials != before[0].Materials || !reflect.DeepEqual(afterStatus[1], before[1]) {
		t.Fatalf("status migration changed legacy task materials: before=%+v after=%+v", before, afterStatus)
	}
	var statusLedger string
	if err := pool.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY version),'[]'::jsonb)::text FROM schema_migrations t WHERE version<=14`).Scan(&statusLedger); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	// Later migrations add project columns, so compare only the old ledger and
	// resource tables that are unchanged by the intervening schema changes.
	currentFacts := statusMigrationRelatedFacts(t, s)
	for _, key := range []string{"ledger", "dependencies", "attachments"} {
		if currentFacts[key] != facts[key] {
			t.Fatalf("upgrade changed %s: before=%s after=%s", key, facts[key], currentFacts[key])
		}
	}
	var typedEdges int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM task_dependencies WHERE dependency_type='task' AND goal_edge_id IS NULL`).Scan(&typedEdges); err != nil || typedEdges != 1 {
		t.Fatalf("upgrade did not preserve the legacy task edge type: count=%d err=%v", typedEdges, err)
	}
	var currentLedger string
	var versions []int64
	if err := pool.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY version),'[]'::jsonb)::text FROM schema_migrations t WHERE version<=14`).Scan(&currentLedger); err != nil || currentLedger != statusLedger {
		t.Fatalf("upgrade changed applied ledger: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT array_agg(version ORDER BY version) FROM schema_migrations`).Scan(&versions); err != nil {
		t.Fatal(err)
	}
	wantVersions := make([]int64, len(schemaMigrations))
	for i, m := range schemaMigrations {
		wantVersions[i] = m.version
	}
	if !reflect.DeepEqual(versions, wantVersions) {
		t.Fatalf("upgrade ledger: got %v want %v", versions, wantVersions)
	}
	if len(versions) < 39 || versions[37] != 38 || versions[38] != 39 {
		t.Fatalf("OAuth migrations missing from ledger: %v", versions)
	}
	task := snapshotTask(t, s, queryID(1), queryID(10))
	prs, err := taskproperty.PullRequests(task.Properties)
	if err != nil || len(prs) != 1 || prs[0].URL != "https://example.test/pr" || prs[0].Title != "Original" || task.Title != "Legacy task" || task.Description != "## Original Markdown" || task.Status != "todo" || task.Version != 9007199254740994 || !task.UpdatedAt.Equal(afterStatus[0].UpdatedAt) || !task.AllowAgents || task.RequiredPlatform == nil || *task.RequiredPlatform != "linux" || !reflect.DeepEqual(task.DependsOn, []string{queryID(11)}) {
		t.Fatalf("upgrade changed task or migrated properties: task=%+v prs=%+v err=%v", task, prs, err)
	}
	var grants, access, refresh, clients int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_grants), (SELECT count(*) FROM oauth_access_tokens), (SELECT count(*) FROM oauth_refresh_tokens), (SELECT count(*) FROM oauth_clients)`).Scan(&grants, &access, &refresh, &clients); err != nil || grants != 0 || access != 0 || refresh != 0 || clients != 0 {
		t.Fatalf("new OAuth tables: grants=%d access=%d refresh=%d clients=%d err=%v", grants, access, refresh, clients, err)
	}
	var fullLedger string
	if err := pool.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY version),'[]'::jsonb)::text FROM schema_migrations t`).Scan(&fullLedger); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var repeatedLedger string
	if err := pool.QueryRow(ctx, `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY version),'[]'::jsonb)::text FROM schema_migrations t`).Scan(&repeatedLedger); err != nil || repeatedLedger != fullLedger {
		t.Fatalf("repeat changed applied ledger: %v", err)
	}
	if repeated := snapshotTask(t, s, queryID(1), queryID(10)); !reflect.DeepEqual(repeated, task) || !reflect.DeepEqual(statusMigrationRelatedFacts(t, s), currentFacts) {
		t.Fatal("repeat changed task or related materials")
	}
}
