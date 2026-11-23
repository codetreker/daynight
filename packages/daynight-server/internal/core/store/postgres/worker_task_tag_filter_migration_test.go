package postgres

import (
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestWorkerTaskTagFilterMigration(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:81]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	stamp := time.Date(2020, 1, 2, 0, 0, 0, 0, time.UTC)
	user := queryID(1)
	for _, id := range []string{queryID(2), queryID(3), queryID(4)} {
		putWorkerSnapshot(t, db, workerSnapshotFixture(user, id, stamp))
	}
	mustQueryExec(t, db, `UPDATE workers SET configuration_revision=9,configuration_updated_at=$3,desired_configuration=$4 WHERE user_id=$1 AND worker_id=$2`, user, queryID(2), stamp, `{"future":{"nested":7}}`)
	// The maximum revision proves this member is never rewritten: any later
	// migration that updated it would overflow. It therefore carries every
	// field a subsequent migration backfills, so each one skips it.
	mustQueryExec(t, db, `UPDATE workers SET configuration_revision=9223372036854775807,configuration_updated_at=$3,desired_configuration=$4 WHERE user_id=$1 AND worker_id=$2`, user, queryID(3), stamp, `{"taskTagFilter":{"future":true},"enableWindowsProcessCleanup":true}`)
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var desiredMatches, unchanged, uninitialized bool
	var revision int64
	var updated time.Time
	if err := pool.QueryRow(ctx, `SELECT desired_configuration = '{"future":{"nested":7},"taskTagFilter":{"names":[],"match":"any"},"enableWindowsProcessCleanup":false}'::jsonb,configuration_revision,configuration_updated_at FROM workers WHERE user_id=$1 AND worker_id=$2`, user, queryID(2)).Scan(&desiredMatches, &revision, &updated); err != nil || !desiredMatches || revision != 11 || !updated.After(stamp) {
		t.Fatalf("migrated value=%v revision=%d updated=%v err=%v", desiredMatches, revision, updated, err)
	}
	if err := pool.QueryRow(ctx, `SELECT desired_configuration = '{"taskTagFilter":{"future":true},"enableWindowsProcessCleanup":true}'::jsonb AND configuration_revision=9223372036854775807 AND configuration_updated_at=$3 FROM workers WHERE user_id=$1 AND worker_id=$2`, user, queryID(3), stamp).Scan(&unchanged); err != nil || !unchanged {
		t.Fatalf("existing member changed: %v %v", unchanged, err)
	}
	if err := pool.QueryRow(ctx, `SELECT desired_configuration IS NULL AND configuration_revision IS NULL AND configuration_updated_at IS NULL FROM workers WHERE user_id=$1 AND worker_id=$2`, user, queryID(4)).Scan(&uninitialized); err != nil || !uninitialized {
		t.Fatalf("uninitialized target changed: %v %v", uninitialized, err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT configuration_revision FROM workers WHERE user_id=$1 AND worker_id=$2`, user, queryID(2)).Scan(&revision); err != nil || revision != 11 {
		t.Fatalf("replay changed revision: %d %v", revision, err)
	}
}

func TestWorkerTaskTagFilterMigrationOverflowRollsBack(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:81]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	user := queryID(1)
	for _, id := range []string{queryID(2), queryID(3)} {
		putWorkerSnapshot(t, db, workerSnapshotFixture(user, id, time.Now().UTC()))
	}
	mustQueryExec(t, db, `UPDATE workers SET configuration_revision=9,configuration_updated_at=now(),desired_configuration='{"future":1}' WHERE user_id=$1`, user)
	mustQueryExec(t, db, `UPDATE workers SET configuration_revision=9223372036854775807 WHERE user_id=$1 AND worker_id=$2`, user, queryID(3))
	var before, after string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	err := migrate(ctx, pool, schemaMigrations)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "22003" {
		t.Fatalf("expected revision overflow, got %v", err)
	}
	var ledger int
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(w) ORDER BY worker_id)::text FROM workers w`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version=82`).Scan(&ledger); err != nil || ledger != 0 || before != after {
		t.Fatalf("overflow changed rows or ledger: ledger=%d err=%v", ledger, err)
	}
}
