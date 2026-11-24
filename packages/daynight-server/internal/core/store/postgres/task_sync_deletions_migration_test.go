package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func taskSyncDeletionMigrationFixture(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
	migrateTo(t, pool, 127)
	if _, err := pool.Exec(t.Context(), `INSERT INTO projects(id,name,repo_url) VALUES ($1,'Project','https://example.test/a.git')`, queryID(1)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `INSERT INTO tasks(id,project_id,title,status,updated_at,deleted_at) VALUES($2,$1,'Deleted','todo','2026-01-02','2026-01-02')`, queryID(1), queryID(2)); err != nil {
		t.Fatal(err)
	}
	return pool
}

func TestTaskSyncDeletionMigrationRollbackAndRecovery(t *testing.T) {
	pool := taskSyncDeletionMigrationFixture(t)
	if _, err := pool.Exec(t.Context(), `CREATE FUNCTION reject_task_sync_deletion_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.version=128 THEN RAISE EXCEPTION 'injected sync deletion ledger failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER reject_task_sync_deletion_ledger BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_task_sync_deletion_ledger()`); err != nil {
		t.Fatal(err)
	}
	err := migrate(t.Context(), pool, schemaMigrations)
	var failure *pgconn.PgError
	if !errors.As(err, &failure) || !strings.Contains(failure.Message, "injected sync deletion ledger failure") {
		t.Fatalf("missing failure: %v", err)
	}
	assertTaskSyncDeletionMigrationAbsent(t, pool)
	if _, err := pool.Exec(t.Context(), `DROP TRIGGER reject_task_sync_deletion_ledger ON schema_migrations; DROP FUNCTION reject_task_sync_deletion_ledger()`); err != nil {
		t.Fatal(err)
	}
	if err := migrate(t.Context(), pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var valid bool
	err = pool.QueryRow(t.Context(), `SELECT to_regclass('tasks_project_effective_deleted_id') IS NOT NULL
 AND (SELECT count(*)=1 FROM tasks WHERE id=$1 AND deleted_at='2026-01-02'::timestamptz)
 AND (SELECT checksum=$2 FROM schema_migrations WHERE version=128)`, queryID(2), schemaMigrations[len(schemaMigrations)-1].checksum()).Scan(&valid)
	if err != nil || !valid {
		t.Fatalf("migration facts: %v %v", valid, err)
	}
	if err := migrate(t.Context(), pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
}

func assertTaskSyncDeletionMigrationAbsent(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	var intact bool
	err := pool.QueryRow(t.Context(), `SELECT to_regclass('tasks_project_effective_deleted_id') IS NULL
 AND NOT EXISTS(SELECT FROM schema_migrations WHERE version=128)
 AND (SELECT count(*)=1 FROM tasks WHERE id=$1 AND deleted_at='2026-01-02'::timestamptz)`, queryID(2)).Scan(&intact)
	if err != nil || !intact {
		t.Fatalf("migration failed to roll back: %v %v", intact, err)
	}
}

func TestTaskSyncDeletionMigrationLockCancellation(t *testing.T) {
	pool := taskSyncDeletionMigrationFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err := blocker.Exec(ctx, `LOCK TABLE tasks IN ROW EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	instance, application := migrationInstance(t, pool)
	migrationCtx, stop := context.WithCancel(ctx)
	defer stop()
	done := make(chan error, 1)
	go func() { done <- migrate(migrationCtx, instance, schemaMigrations) }()
	waitForMigration(t, func() bool {
		var waiting bool
		return pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM pg_locks l JOIN pg_stat_activity a USING(pid)
 WHERE l.relation='tasks'::regclass AND l.mode='ShareLock' AND NOT l.granted AND a.application_name=$1)`, application).Scan(&waiting) == nil && waiting
	})
	stop()
	if err := <-done; err == nil || !(errors.Is(err, context.Canceled) || strings.Contains(err.Error(), "context canceled")) {
		t.Fatalf("lock cancellation: %v", err)
	}
	assertTaskSyncDeletionMigrationAbsent(t, pool)
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	assertMigrationPoolReusable(t, instance)
}
