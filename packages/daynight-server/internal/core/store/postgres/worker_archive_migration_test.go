package postgres

import (
	"context"
	"testing"
	"time"
)

func TestWorkerArchiveSessionsMigration(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:77]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	stamp := time.Now().UTC()
	user, worker := queryID(1), queryID(2)
	putWorkerSnapshot(t, db, workerSnapshotFixture(user, worker, stamp))
	var before string
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(w)::text FROM workers w WHERE user_id=$1 AND worker_id=$2`, user, worker).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var after string
	var archive bool
	if err := pool.QueryRow(ctx, `SELECT (to_jsonb(w)-'archive_sessions')::text,archive_sessions FROM workers w WHERE user_id=$1 AND worker_id=$2`, user, worker).Scan(&after, &archive); err != nil {
		t.Fatal(err)
	}
	if before != after || !archive {
		t.Fatalf("migration changed row or default: before=%s after=%s archive=%v", before, after, archive)
	}
	putWorkerSnapshot(t, db, workerSnapshotFixture(user, queryID(3), stamp))
	if err := pool.QueryRow(ctx, `SELECT archive_sessions FROM workers WHERE user_id=$1 AND worker_id=$2`, user, queryID(3)).Scan(&archive); err != nil || !archive {
		t.Fatalf("new worker default=%v err=%v", archive, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE workers SET archive_sessions=NULL WHERE user_id=$1`, user); err == nil {
		t.Fatal("NULL accepted")
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
}
