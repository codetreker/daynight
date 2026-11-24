package postgres

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

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
		{"sql failure", migration{version: 101, sql: "CREATE TABLE second_marker (id int); SELECT 1 / 0"}, "22012"},
		{"version insert failure", migration{version: 100, sql: "CREATE TABLE second_marker (id int)"}, "23505"},
		{"commit failure", migration{version: 101, sql: "CREATE TABLE second_marker (id int UNIQUE DEFERRABLE INITIALLY DEFERRED); INSERT INTO second_marker VALUES (1), (1)"}, "23505"},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := emptyPool(t)
			bootstrapBaseline(t, pool)
			baselineHistory := readMigrationHistory(t, pool, 99)
			first := migration{version: 100, sql: "CREATE TABLE first_marker (id int)"}
			err := migrate(context.Background(), pool, []migration{first, test.next})
			var failure *pgconn.PgError
			if !errors.As(err, &failure) || failure.Code != test.code {
				t.Fatalf("expected PostgreSQL %s, got %v", test.code, err)
			}
			var versions int
			var firstTable, secondTable *string
			if err := pool.QueryRow(context.Background(), "SELECT count(*), to_regclass('first_marker')::text, to_regclass('second_marker')::text FROM schema_migrations WHERE version >= 100").Scan(&versions, &firstTable, &secondTable); err != nil || versions != 1 || firstTable == nil || secondTable != nil {
				t.Fatalf("partial migration: versions=%d first=%v second=%v error=%v", versions, firstTable, secondTable, err)
			}
			priorMigration := readMigrationHistory(t, pool, 100)
			if err := migrate(t.Context(), pool, []migration{first, {version: 101, sql: "CREATE TABLE second_marker (id int)"}}); err != nil {
				t.Fatalf("resume migration: %v", err)
			}
			if got := readMigrationHistory(t, pool, 100); got != priorMigration {
				t.Fatal("resumption changed the committed migration")
			}
			if got := readMigrationHistory(t, pool, 99); got != baselineHistory {
				t.Fatal("tail failure or resumption changed the baseline ledger")
			}
			if err := pool.QueryRow(t.Context(), "SELECT to_regclass('second_marker')::text").Scan(&secondTable); err != nil || secondTable == nil {
				t.Fatalf("resumed migration did not create its table: %v %v", secondTable, err)
			}
			assertMigrationPoolReusable(t, pool)
		})
	}
}

func TestMigrationsSessionLockSpansCommits(t *testing.T) {
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
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
		{version: 100, sql: "CREATE TABLE first_marker (id int)"},
		{version: 101, sql: "SELECT pg_advisory_xact_lock(78131); CREATE TABLE second_marker (id int)"},
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
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM schema_migrations WHERE version >= 100").Scan(&applied); err != nil || applied != 1 {
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
	bootstrapBaseline(t, pool)
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
		if err := initializeSchema(t.Context(), pool, schemaMigrations, currentSchemaSnapshot); err == nil {
			t.Fatal("expected read-only snapshot creation failure")
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
		bootstrapBaseline(t, pool)
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

func TestBaselineUpgradePreservesExistingTaskMaterials(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
	s := &Store{Pool: pool}
	mustQueryExec(t, s, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Legacy project','https://example.test/repo')`, queryID(1))
	mustQueryExec(t, s, `INSERT INTO tasks(id,project_id,title,description,status,version,allow_agents,required_platform)
		VALUES($1,$3,'Legacy task','## Original Markdown','todo',9007199254740993,true,'linux'),
		($2,$3,'Dependency','Preserved','done',7,false,NULL)`, queryID(10), queryID(11), queryID(1))
	mustQueryExec(t, s, `INSERT INTO task_properties(task_id,name,value)
		VALUES($1,'pullRequests','[{"url":"https://example.test/pr","title":"Original"}]')`, queryID(10))
	mustQueryExec(t, s, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`, queryID(1), queryID(10), queryID(11))
	mustQueryExec(t, s, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes)
		VALUES($1,$2,'nested/plan.md','text/markdown',123)`, queryID(1), queryID(10))

	readMaterials := func() string {
		t.Helper()
		var result string
		err := pool.QueryRow(ctx, `SELECT jsonb_build_array(
			(SELECT jsonb_agg(to_jsonb(t)-'ancestor_deleted_at' ORDER BY id) FROM tasks t),
			(SELECT jsonb_agg(to_jsonb(p) ORDER BY task_id, name) FROM task_properties p),
			(SELECT jsonb_agg(to_jsonb(d) ORDER BY task_id) FROM task_dependencies d),
			(SELECT jsonb_agg(to_jsonb(a) ORDER BY task_id, path) FROM task_attachments a)
		)::text`).Scan(&result)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	materials := readMaterials()
	legacyHistory := readMigrationHistory(t, pool, 99)
	if err := initializeSchema(ctx, pool, schemaMigrations, currentSchemaSnapshot); err != nil {
		t.Fatal(err)
	}
	latest := schemaMigrations[len(schemaMigrations)-1].version
	assertMigrationLedger(t, pool)
	fullHistory := readMigrationHistory(t, pool, latest)
	if err := initializeSchema(ctx, pool, schemaMigrations, currentSchemaSnapshot); err != nil {
		t.Fatal(err)
	}
	if got := readMigrationHistory(t, pool, latest); got != fullHistory {
		t.Fatal("restart changed applied ledger")
	}
	if got := readMigrationHistory(t, pool, 99); got != legacyHistory {
		t.Fatal("upgrade changed applied legacy ledger")
	}
	if got := readMaterials(); got != materials {
		t.Fatalf("upgrade changed task materials: before=%s after=%s", materials, got)
	}
}

func readMigrationHistory(t *testing.T, pool *pgxpool.Pool, through int64) string {
	t.Helper()
	var history string
	if err := pool.QueryRow(t.Context(), `SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY version),'[]'::jsonb)::text
		FROM schema_migrations m WHERE version <= $1`, through).Scan(&history); err != nil {
		t.Fatal(err)
	}
	return history
}
