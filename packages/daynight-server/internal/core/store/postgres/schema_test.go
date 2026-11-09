package postgres

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSchemaBootstrapSkipsHistoryAndPreservesCurrentState(t *testing.T) {
	pool := emptyPool(t)
	config := pool.Config()
	tracer := &schemaInitializationTracer{}
	config.ConnConfig.Tracer = tracer
	traced, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(traced.Close)
	migrations := slices.Clone(schemaMigrations)
	for index := range migrations {
		if migrations[index].transform != nil {
			migrations[index].transform = func(context.Context, pgx.Tx) error {
				return errors.New("historical transform executed during bootstrap")
			}
		}
	}
	ctx := context.Background()
	if err := initializeSchema(ctx, traced, migrations, currentSchemaSnapshot); err != nil {
		t.Fatal(err)
	}
	tracer.mutex.Lock()
	for _, query := range tracer.queries {
		for _, migration := range schemaMigrations {
			if query == migration.sql {
				tracer.mutex.Unlock()
				t.Fatalf("bootstrap executed historical migration %d", migration.version)
			}
		}
	}
	tracer.mutex.Unlock()
	rows, err := pool.Query(ctx, "SELECT version,checksum FROM schema_migrations ORDER BY version")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	index := 0
	for rows.Next() {
		var version int64
		var saved string
		if err := rows.Scan(&version, &saved); err != nil {
			t.Fatal(err)
		}
		if index >= len(schemaMigrations) || version != schemaMigrations[index].version || saved != schemaMigrations[index].checksum() {
			t.Fatalf("bootstrap ledger entry %d: version=%d checksum=%q", index, version, saved)
		}
		index++
	}
	rows.Close()
	if err := rows.Err(); err != nil || index != len(schemaMigrations) {
		t.Fatalf("bootstrap ledger count=%d error=%v", index, err)
	}
	var seedRows int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM private_transfer_ledger WHERE singleton)
		+ (SELECT count(*) FROM oauth_credential_cleanup_cursor WHERE singleton AND next_kind=0)
		+ (SELECT count(*) FROM oauth_authorization_cleanup_cursor WHERE singleton AND next_kind=0)`).Scan(&seedRows); err != nil || seedRows != 3 {
		t.Fatalf("bootstrap system records=%d error=%v", seedRows, err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES('00000000-0000-4000-8000-000000000001','Retained','https://example.com/retained')`); err != nil {
		t.Fatal(err)
	}
	var before, after string
	const historySQL = `SELECT jsonb_agg(jsonb_build_array(version,checksum,applied_at) ORDER BY version)::text FROM schema_migrations`
	if err := pool.QueryRow(ctx, historySQL).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := initializeSchema(ctx, pool, schemaMigrations, currentSchemaSnapshot); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, historySQL).Scan(&after); err != nil || before != after {
		t.Fatalf("repeat initialization rewrote history: %v", err)
	}
	var title string
	if err := pool.QueryRow(ctx, "SELECT name FROM projects").Scan(&title); err != nil || title != "Retained" {
		t.Fatalf("repeat initialization changed existing data: %q %v", title, err)
	}
	assertMigrationPoolReusable(t, traced)
	assertMigrationPoolReusable(t, pool)
}

func TestSchemaBootstrapRejectsInvalidSnapshotBeforeDatabaseChanges(t *testing.T) {
	latest := schemaMigrations[len(schemaMigrations)-1].version
	for _, line := range []string{"", "-- Missing snapshot metadata", "-- Schema snapshot version: invalid", fmt.Sprintf("-- Schema snapshot version: %d", latest-1)} {
		t.Run(line, func(t *testing.T) {
			pool := emptyPool(t)
			_, body, _ := strings.Cut(currentSchemaSnapshot, "\n")
			err := initializeSchema(context.Background(), pool, schemaMigrations, line+"\n"+body)
			if err == nil || !strings.Contains(err.Error(), fmt.Sprintf("latest migration %d", latest)) {
				t.Fatalf("invalid snapshot metadata accepted: %v", err)
			}
			assertSchemaHasNoObjects(t, pool)
		})
	}
}

func TestSchemaBootstrapRollsBackEveryInitializationStage(t *testing.T) {
	for _, test := range []struct{ name, mutation, code string }{
		{"snapshot", "SELECT 1 / 0", "22012"},
		{"seed", "INSERT INTO private_transfer_ledger(singleton) VALUES(true)", "23505"},
		{"ledger", "ALTER TABLE schema_migrations ADD CONSTRAINT reject_history CHECK(version<>1)", "23514"},
		{"commit", "CREATE TABLE bootstrap_commit_failure(id integer UNIQUE DEFERRABLE INITIALLY DEFERRED); INSERT INTO bootstrap_commit_failure VALUES(1),(1)", "23505"},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := emptyPool(t)
			err := initializeSchema(context.Background(), pool, schemaMigrations, currentSchemaSnapshot+"\n"+test.mutation)
			var failure *pgconn.PgError
			if !errors.As(err, &failure) || failure.Code != test.code {
				t.Fatalf("expected PostgreSQL %s at %s, got %v", test.code, test.name, err)
			}
			assertSchemaHasNoObjects(t, pool)
			assertMigrationPoolReusable(t, pool)
			if err := initializeSchema(context.Background(), pool, schemaMigrations, currentSchemaSnapshot); err != nil {
				t.Fatalf("initialization did not recover: %v", err)
			}
		})
	}
}

func TestSchemaInitializationReplaysHistoryForEveryExistingObjectKind(t *testing.T) {
	for _, test := range []struct{ name, sql string }{
		{"table", "CREATE TABLE tasks(private_migration_marker boolean)"},
		{"sequence", "CREATE SEQUENCE retained_sequence"},
		{"view", "CREATE VIEW retained_view AS SELECT 1 AS value"},
		{"type", "CREATE TYPE retained_type AS ENUM('present')"},
		{"function", "CREATE FUNCTION retained_function() RETURNS integer LANGUAGE sql AS 'SELECT 1'"},
		{"operator", "CREATE OPERATOR === (FUNCTION=pg_catalog.int4eq,LEFTARG=integer,RIGHTARG=integer)"},
		{"collation", `CREATE COLLATION retained_collation FROM "C"`},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := emptyPool(t)
			if _, err := pool.Exec(context.Background(), test.sql); err != nil {
				t.Fatal(err)
			}
			sentinel := errors.New("existing schema selected historical replay")
			migrations := slices.Clone(schemaMigrations)
			migrations[0].transform = func(context.Context, pgx.Tx) error { return sentinel }
			if err := initializeSchema(context.Background(), pool, migrations, currentSchemaSnapshot); !errors.Is(err, sentinel) {
				t.Fatalf("existing %s bypassed historical replay: %v", test.name, err)
			}
			var projects *string
			if err := pool.QueryRow(context.Background(), "SELECT to_regclass('projects')::text").Scan(&projects); err != nil || projects != nil {
				t.Fatalf("failed historical migration retained new objects: %v %v", projects, err)
			}
			assertMigrationPoolReusable(t, pool)
		})
	}
}

func TestSchemaBootstrapIgnoresObjectsInOtherSchemas(t *testing.T) {
	other := emptyPool(t)
	if _, err := other.Exec(context.Background(), "CREATE TABLE unrelated_schema_object(id integer)"); err != nil {
		t.Fatal(err)
	}
	pool := emptyPool(t)
	migrations := slices.Clone(schemaMigrations)
	migrations[0].transform = func(context.Context, pgx.Tx) error { return errors.New("unrelated schema forced history replay") }
	if err := initializeSchema(context.Background(), pool, migrations, currentSchemaSnapshot); err != nil {
		t.Fatal(err)
	}
}

func TestSchemaInitializationChecksEmptinessAfterAcquiringLock(t *testing.T) {
	pool := emptyPool(t)
	instance, application := migrationInstance(t, pool)
	blocker := holdSchemaInitializationLock(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sentinel := errors.New("schema changed while initialization waited")
	migrations := slices.Clone(schemaMigrations)
	migrations[0].transform = func(context.Context, pgx.Tx) error { return sentinel }
	done := make(chan error, 1)
	go func() { done <- initializeSchema(ctx, instance, migrations, currentSchemaSnapshot) }()
	waitForSchemaInitializationLock(t, blocker, application)
	if _, err := blocker.Exec(ctx, "CREATE TABLE retained_marker(id integer)"); err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.Exec(ctx, "SELECT pg_advisory_unlock($1)", migrationLock); err != nil {
		t.Fatal(err)
	}
	if err := awaitSchemaInitialization(t, done); !errors.Is(err, sentinel) {
		t.Fatalf("initializer did not observe the schema created while waiting: %v", err)
	}
	assertMigrationPoolReusable(t, instance)
}

func TestSchemaBootstrapCanceledLockWaitReleasesResources(t *testing.T) {
	pool := emptyPool(t)
	instance, application := migrationInstance(t, pool)
	blocker := holdSchemaInitializationLock(t, pool)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- initializeSchema(ctx, instance, schemaMigrations, currentSchemaSnapshot) }()
	waitForSchemaInitializationLock(t, blocker, application)
	cancel()
	if err := awaitSchemaInitialization(t, done); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected canceled initialization lock wait: %v", err)
	}
	if _, err := blocker.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", migrationLock); err != nil {
		t.Fatal(err)
	}
	assertSchemaHasNoObjects(t, pool)
	assertMigrationPoolReusable(t, instance)
	if err := initializeSchema(context.Background(), instance, schemaMigrations, currentSchemaSnapshot); err != nil {
		t.Fatalf("initialization after canceled lock wait: %v", err)
	}
}

func TestSchemaInitializationCancellationBeforeSnapshot(t *testing.T) {
	for _, phase := range []string{"acquire", "inspect", "begin"} {
		t.Run(phase, func(t *testing.T) {
			pool := emptyPool(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			config := pool.Config()
			config.ConnConfig.Tracer = &schemaInitializationTracer{cancel: cancel, cancelPhase: phase}
			traced, err := pgxpool.NewWithConfig(context.Background(), config)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(traced.Close)
			if phase == "acquire" {
				cancel()
			}
			if err := initializeSchema(ctx, traced, schemaMigrations, currentSchemaSnapshot); !errors.Is(err, context.Canceled) {
				t.Fatalf("expected canceled %s: %v", phase, err)
			}
			assertSchemaHasNoObjects(t, pool)
			assertMigrationPoolReusable(t, traced)
		})
	}
}

func assertSchemaHasNoObjects(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	var count int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM pg_depend
		WHERE refclassid='pg_namespace'::regclass AND refobjid=current_schema()::regnamespace`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("schema contains %d objects after failed initialization: %v", count, err)
	}
}

func holdSchemaInitializationLock(t *testing.T, pool *pgxpool.Pool) *pgx.Conn {
	t.Helper()
	conn, err := pgx.Connect(context.Background(), pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
		defer cancel()
		if _, err := conn.Exec(ctx, "SELECT pg_advisory_unlock($1)", migrationLock); err != nil {
			t.Error(err)
		}
		if err := conn.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	if _, err := conn.Exec(context.Background(), "SELECT pg_advisory_lock($1)", migrationLock); err != nil {
		t.Fatal(err)
	}
	return conn
}

func waitForSchemaInitializationLock(t *testing.T, conn *pgx.Conn, application string) {
	t.Helper()
	waitForMigration(t, func() bool {
		var waiting bool
		err := conn.QueryRow(context.Background(), `SELECT EXISTS (
			SELECT 1 FROM pg_locks locks JOIN pg_stat_activity activity USING(pid)
			WHERE locks.locktype='advisory' AND locks.classid=$1::oid AND locks.objid=$2::oid
			AND NOT locks.granted AND activity.application_name=$3
		)`, migrationLock>>32, migrationLock&0xffffffff, application).Scan(&waiting)
		return err == nil && waiting
	})
}

func awaitSchemaInitialization(t *testing.T, done <-chan error) error {
	t.Helper()
	var result error
	select {
	case result = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("schema initialization did not finish")
	}
	return result
}

type schemaInitializationTracer struct {
	mutex       sync.Mutex
	queries     []string
	cancel      context.CancelFunc
	cancelPhase string
	matched     atomic.Bool
}

func (tracer *schemaInitializationTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	tracer.mutex.Lock()
	tracer.queries = append(tracer.queries, data.SQL)
	tracer.mutex.Unlock()
	if tracer.cancel != nil && strings.Contains(data.SQL, "SELECT 1 FROM pg_depend") {
		if tracer.cancelPhase == "inspect" {
			tracer.cancel()
		} else if tracer.cancelPhase == "begin" {
			tracer.matched.Store(true)
		}
	}
	return ctx
}

func (tracer *schemaInitializationTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {
	if tracer.matched.Swap(false) {
		tracer.cancel()
	}
}
