package reviewassignment_test

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/reviewassignment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

func TestReviewWorkerOnlineBoundariesWithDatabaseClock(t *testing.T) {
	ctx := t.Context()
	db, err := postgres.Open(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	owner := testutil.QueryID(1)
	id := testutil.QueryID(2)
	testutil.MustExec(t, db.Pool, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot,review_enabled) VALUES($1,$2,now(),now(),'{}','{}',true)`, owner, id)

	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	dao := reviewassignment.NewWriter(tx, testutil.QueryID(3))
	observed, err := dao.ObservedAt(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// PostgreSQL timestamps have microsecond precision. Freeze the actual DB
	// observation and persist exact offsets from that same clock in the tx.
	cases := []struct {
		name   string
		offset time.Duration
		want   bool
	}{
		{"current", 0, true},
		{"before cutoff", -120*time.Second + time.Microsecond, true},
		{"cutoff", -120 * time.Second, false},
		{"future", time.Microsecond, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			expected := observed.Add(tc.offset)
			if _, err := tx.Exec(ctx, `UPDATE workers SET last_seen_at=$3 WHERE user_id=$1 AND worker_id=$2`, owner, id, expected); err != nil {
				t.Fatal(err)
			}
			stored, err := dao.LockWorker(ctx, owner, id)
			if err != nil {
				t.Fatal(err)
			}
			if !stored.LastSeenAt.Equal(expected) {
				t.Fatalf("stored %s differs from exact database clock offset %s", stored.LastSeenAt, expected)
			}
			if got := worker.ActiveAt(stored.LastSeenAt, observed); got != tc.want {
				t.Fatalf("ActiveAt(%s, %s) = %t, want %t", stored.LastSeenAt, observed, got, tc.want)
			}
		})
	}
}
