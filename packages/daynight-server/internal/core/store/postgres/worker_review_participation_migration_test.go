package postgres

import (
	"slices"
	"testing"
	"time"
)

func TestWorkerReviewParticipationMigrationPreservesWorkerFacts(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 94 })
	if index < 0 {
		t.Fatal("Worker review participation migration missing")
	}
	old, current := schemaMigrations[:index], schemaMigrations[:index+1]
	if err := migrate(ctx, pool, old); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	user, worker := queryID(1), queryID(2)
	putWorkerSnapshot(t, db, workerSnapshotFixture(user, worker, time.Now().UTC().Add(-96*time.Hour)))
	var before string
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(w)::text FROM workers w WHERE user_id=$1 AND worker_id=$2`, user, worker).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, current); err != nil {
		t.Fatal(err)
	}
	var after string
	var enabled bool
	var version int64
	if err := pool.QueryRow(ctx, `SELECT (to_jsonb(w)-'review_enabled'-'review_version')::text,review_enabled,review_version FROM workers w WHERE user_id=$1 AND worker_id=$2`, user, worker).Scan(&after, &enabled, &version); err != nil || before != after || enabled || version != 1 {
		t.Fatalf("migration equal=%v enabled=%v version=%d err=%v", before == after, enabled, version, err)
	}
	if err := migrate(ctx, pool, current); err != nil {
		t.Fatal(err)
	}
}
