package postgres

import (
	"context"
	"testing"
	"time"
)

func TestWorkerAliasMigrationPreservesReports(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:80]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	user, worker := queryID(1), queryID(2)
	putWorkerSnapshot(t, db, workerSnapshotFixture(user, worker, time.Now().UTC().Add(-96*time.Hour)))
	var before string
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(w)::text FROM workers w WHERE user_id=$1 AND worker_id=$2`, user, worker).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:81]); err != nil {
		t.Fatal(err)
	}
	var after string
	var value *string
	var version int64
	if err := pool.QueryRow(ctx, `SELECT (to_jsonb(w)-'alias_value'-'alias_version')::text,alias_value,alias_version FROM workers w WHERE user_id=$1 AND worker_id=$2`, user, worker).Scan(&after, &value, &version); err != nil || after != before || value != nil || version != 1 {
		t.Fatalf("migration changed existing report: equal=%v value=%v version=%d err=%v", before == after, value, version, err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:81]); err != nil {
		t.Fatal(err)
	}
}
