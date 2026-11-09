package testutil

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func WaitForQueryLock(t *testing.T, pool *pgxpool.Pool, prefix string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
			WHERE datname = current_database() AND application_name = current_schema()
			AND wait_event_type = 'Lock' AND query LIKE $1)`, prefix+"%").Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("query never reached a database lock wait")
		case <-ticker.C:
		}
	}
}

func WaitTransferTeamLock(t *testing.T, ctx context.Context, pool *pgxpool.Pool, prefix string, blockerPID uint32) {
	t.Helper()
	for {
		var waiting bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
 WHERE application_name=current_schema() AND wait_event_type='Lock' AND query LIKE $1 AND $2=ANY(pg_blocking_pids(pid)))`, prefix+"%", blockerPID).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		if err := WaitThreadClock(ctx); err != nil {
			t.Fatalf("operation did not wait for the other Team transaction: %v", err)
		}
	}
}

func WaitThreadBackendLock(t *testing.T, pool *pgxpool.Pool, pid uint32) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		var waiting bool
		if err := pool.QueryRow(ctx, `SELECT coalesce((SELECT wait_event_type='Lock' FROM pg_stat_activity WHERE pid=$1),false)`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		if err := WaitThreadClock(ctx); err != nil {
			t.Fatalf("backend %d did not wait for lock: %v", pid, err)
		}
	}
}

func ReceiveQueryResult(t *testing.T, ctx context.Context, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		t.Fatal(ctx.Err())
		return ctx.Err()
	}
}
