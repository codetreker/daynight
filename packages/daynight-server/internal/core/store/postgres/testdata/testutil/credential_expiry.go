package testutil

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ArmCredentialExpiry prepares the other actors' connections before setting a test deadline.
func ArmCredentialExpiry(t *testing.T, ctx context.Context, pool *pgxpool.Pool, table, id string, connections int) time.Time {
	t.Helper()
	var conn *pgxpool.Conn
	for range connections {
		acquired, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer acquired.Release()
		conn = acquired
	}
	var expires time.Time
	if err := conn.QueryRow(ctx, `UPDATE `+pgx.Identifier{table}.Sanitize()+` SET expires_at=clock_timestamp()+interval '750 milliseconds' WHERE id=$1 RETURNING expires_at`, id).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	return expires
}

// WaitForCredentialExpiry verifies that the observed lock wait crosses natural expiry.
func WaitForCredentialExpiry(t *testing.T, ctx context.Context, pool *pgxpool.Pool, expires time.Time) {
	t.Helper()
	var expired bool
	const observedExpiry = `SELECT clock_timestamp()>=$1::timestamptz`
	if err := pool.QueryRow(ctx, observedExpiry, expires).Scan(&expired); err != nil {
		t.Fatal(err)
	}
	if expired {
		t.Fatal("credential expired before the lock observations completed")
	}
	if _, err := pool.Exec(ctx, `SELECT pg_sleep_until($1::timestamptz)`, expires); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, observedExpiry, expires).Scan(&expired); err != nil || !expired {
		t.Fatalf("credential still valid at the release barrier: expired=%t error=%v", expired, err)
	}
}
