package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

func TestTaskSearchDeadlineReleasesObservedSQLQuery(t *testing.T) {
	pool := emptyPool(t)
	bounded, stop := context.WithTimeout(t.Context(), 10*time.Second)
	defer stop()
	observer := cancellationObserver(t, bounded, pool)
	ctx, cancel := context.WithTimeout(bounded, 500*time.Millisecond)
	defer cancel()
	var readerPID uint32
	err := ReadOnlySnapshot(ctx, pool, func(tx pgx.Tx) error {
		readerPID = tx.Conn().PgConn().PID()
		return interruptObservedQuery(t, ctx, nil, observer, tx)
	})
	var failure *store.TransactionError
	if !errors.Is(err, context.DeadlineExceeded) || !errors.As(err, &failure) ||
		failure.Phase != "operation" || failure.CommitAttempted || failure.CleanupFailed || failure.Outcome != store.TransactionNotCommitted {
		t.Fatalf("search snapshot deadline lost its cause or completion: %#v %v", failure, err)
	}
	if database, state := store.DatabaseErrorFacts(err); database {
		t.Fatalf("confirmed deadline cleanup became a database failure: state=%q err=%v", state, err)
	}
	var active bool
	if err := observer.QueryRow(bounded, `SELECT coalesce((SELECT state='active'
 OR xact_start IS NOT NULL FROM pg_stat_activity WHERE pid=$1),false)`, readerPID).Scan(&active); err != nil || active {
		t.Fatalf("deadline returned with a live query or transaction: active=%t err=%v", active, err)
	}
	observer.Release()
	if acquired := pool.Stat().AcquiredConns(); acquired != 0 {
		t.Fatalf("deadline retained %d acquired pool connections", acquired)
	}
	assertMigrationPoolReusable(t, pool)
}
