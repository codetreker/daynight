package postgres

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMigrationsEmptyRepeatAndConstraints(t *testing.T) {
	pool := emptyPool(t)
	ctx := context.Background()
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	if err := migrate(ctx, database.Pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var count, foreignKeys int
	if err := database.Pool.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&count); err != nil || count != len(schemaMigrations) {
		t.Fatalf("versions: %d, %v", count, err)
	}
	if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND contype = 'f'
	 AND conrelid NOT IN ('bots'::regclass,'bot_worker_preferences'::regclass,'bot_configuration_preferences'::regclass,'bot_model_preferences'::regclass,'bot_effort_preferences'::regclass,'private_upload_chunks'::regclass)
	 AND NOT (conrelid='task_sessions'::regclass AND conname='session_bot_owner')`).Scan(&foreignKeys); err != nil || foreignKeys != 0 {
		t.Fatalf("legacy tables gained foreign keys: %d, %v", foreignKeys, err)
	}
	wantedKeys := map[string]map[string]bool{
		"bots": {
			"FOREIGN KEY (owner_user_id) REFERENCES users(id)":                              true,
			"FOREIGN KEY (owner_user_id, worker_id) REFERENCES workers(user_id, worker_id)": true,
		},
		"bot_worker_preferences": {
			"FOREIGN KEY (user_id) REFERENCES users(id)":                              true,
			"FOREIGN KEY (user_id, worker_id) REFERENCES workers(user_id, worker_id)": true,
		},
		"bot_configuration_preferences": {
			"FOREIGN KEY (user_id, worker_id) REFERENCES workers(user_id, worker_id)": true,
		},
		"bot_model_preferences":  {"FOREIGN KEY (user_id, worker_id) REFERENCES workers(user_id, worker_id)": true},
		"bot_effort_preferences": {"FOREIGN KEY (user_id, worker_id) REFERENCES workers(user_id, worker_id)": true},
		"task_sessions": {
			"FOREIGN KEY (bot_id, owner_user_id) REFERENCES bots(id, owner_user_id)": true,
		},
		"private_upload_chunks": {
			"FOREIGN KEY (transfer_id) REFERENCES private_transfers(id) ON DELETE CASCADE": true,
		},
	}
	rows, err := database.Pool.Query(ctx, `SELECT conrelid::regclass::text,pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid IN ('bots'::regclass,'bot_worker_preferences'::regclass,'bot_configuration_preferences'::regclass,'bot_model_preferences'::regclass,'bot_effort_preferences'::regclass,'task_sessions'::regclass,'private_upload_chunks'::regclass) AND contype='f'`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var table, definition string
		if err := rows.Scan(&table, &definition); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		if !wantedKeys[table][definition] {
			rows.Close()
			t.Fatalf("unexpected foreign key on %s: %s", table, definition)
		}
		delete(wantedKeys[table], definition)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	for table, constraints := range wantedKeys {
		if len(constraints) != 0 {
			t.Fatalf("missing foreign key constraints on %s: %v", table, constraints)
		}
	}
	for _, sql := range []string{
		`INSERT INTO projects (id, name, repo_url) VALUES ('00000000-0000-0000-0000-000000000001', '  ', 'https://example.com/repo')`,
		`INSERT INTO projects (id, name, repo_url) VALUES ('00000000-0000-0000-0000-000000000001', 'project', '  ')`,
		`INSERT INTO tasks (id, project_id, title) VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', ' ')`,
		`INSERT INTO tasks (id, project_id, title, status) VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'task', 'unknown')`,
		`INSERT INTO tasks (id, project_id, title, version) VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'task', 0)`,
		`INSERT INTO task_dependencies VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002')`,
	} {
		_, err := database.Pool.Exec(ctx, sql)
		var failure *pgconn.PgError
		if !errors.As(err, &failure) || failure.Code != "23514" {
			t.Fatalf("expected check rejection, got %v", err)
		}
	}
	if _, err := database.Pool.Exec(ctx, `INSERT INTO projects (id, name, repo_url) VALUES ('00000000-0000-0000-0000-000000000001', 'project', 'https://example.com/repo')`); err != nil {
		t.Fatal(err)
	}
	var created, updated time.Time
	if err := database.Pool.QueryRow(ctx, "SELECT created_at, updated_at FROM projects").Scan(&created, &updated); err != nil || !created.Equal(updated) || created.IsZero() {
		t.Fatalf("database times: %v, %v, %v", created, updated, err)
	}
	assertMigrationPoolReusable(t, database.Pool)
}

func TestMigration126DropsWorkerLifecycleAndPreservesSessionOperations(t *testing.T) {
	pool := emptyPool(t)
	ctx := t.Context()
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 126 })
	if index < 2 || schemaMigrations[index-2].version != 124 || schemaMigrations[index-1].version != 125 {
		t.Fatal("expected worker lifecycle removal after migrations 124 and 125")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index-1]); err != nil {
		t.Fatal(err)
	}

	user, worker, session, operation := queryID(1), queryID(2), queryID(3), queryID(4)
	if _, err := pool.Exec(ctx, `WITH worker AS (
		INSERT INTO workers (user_id, worker_id, created_at, last_seen_at, telemetry, task_snapshot)
		VALUES ($1, $2, now(), now(), '{}', '{}')
		RETURNING user_id, worker_id
	)
	INSERT INTO worker_lifecycle (user_id, worker_id, protocol_version, intent_version, desired, admission, instance_epoch, updated_at)
	SELECT user_id, worker_id, 1, 3, 'enabled', 'open', 1, now() FROM worker`, user, worker); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO session_operations
		(session_id, operation_id, operation_seq, body_hash, command, actor_user_id, credential_id, credential_kind, receipt, worker_id, worker_intent_version)
		VALUES ($1, $2, 1, decode(repeat('ab', 32), 'hex'), '{}', $3, $3, 'pat', '{"state":"accepted"}', $4, 3)`,
		session, operation, user, worker); err != nil {
		t.Fatal(err)
	}

	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}

	const preserved = `SELECT
		(SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m WHERE version IN (110, 125)),
		(SELECT to_jsonb(w)::text FROM workers w WHERE user_id = $1 AND worker_id = $2),
		(SELECT (to_jsonb(o) - 'worker_id' - 'worker_intent_version')::text
		 FROM session_operations o WHERE session_id = $3 AND operation_id = $4)`
	var oldMigration, oldWorker, oldOperation string
	if err := pool.QueryRow(ctx, preserved, user, worker, session, operation).Scan(&oldMigration, &oldWorker, &oldOperation); err != nil {
		t.Fatal(err)
	}
	if err := initializeSchema(ctx, pool, schemaMigrations, currentSchemaSnapshot); err != nil {
		t.Fatal(err)
	}

	var tablesGone, columnsGone bool
	if err := pool.QueryRow(ctx, `SELECT
		to_regclass('worker_lifecycle') IS NULL
		AND to_regclass('worker_lifecycle_operations') IS NULL
		AND to_regclass('worker_lifecycle_observations') IS NULL,
		NOT EXISTS (SELECT FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name = 'session_operations'
			AND column_name IN ('worker_id', 'worker_intent_version'))`).Scan(&tablesGone, &columnsGone); err != nil {
		t.Fatal(err)
	}
	if !tablesGone || !columnsGone {
		t.Fatalf("worker lifecycle schema remains: tables removed=%t, columns removed=%t", tablesGone, columnsGone)
	}
	var newMigration, newWorker, newOperation string
	if err := pool.QueryRow(ctx, preserved, user, worker, session, operation).Scan(&newMigration, &newWorker, &newOperation); err != nil {
		t.Fatal(err)
	}
	if newMigration != oldMigration || newWorker != oldWorker || newOperation != oldOperation {
		t.Fatalf("upgrade changed retained rows: migrations 110 and 125=%t, worker=%t, session operation=%t",
			newMigration != oldMigration, newWorker != oldWorker, newOperation != oldOperation)
	}
	var checksum string
	if err := pool.QueryRow(ctx, "SELECT checksum FROM schema_migrations WHERE version = 126").Scan(&checksum); err != nil {
		t.Fatal(err)
	}
	if checksum != schemaMigrations[index].checksum() {
		t.Fatalf("migration 126 checksum: got %s, want %s", checksum, schemaMigrations[index].checksum())
	}
}

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
