package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestReadOnlySnapshotCleansConnectionAfterQueryDeadline(t *testing.T) {
	pool := emptyPool(t)
	bounded, stop := context.WithTimeout(context.Background(), 30*time.Second)
	defer stop()
	observer := cancellationObserver(t, bounded, pool)
	ready, err := pool.Acquire(bounded)
	if err != nil {
		t.Fatal(err)
	}
	ready.Release()
	ctx, cancel := context.WithTimeout(bounded, time.Second)
	defer cancel()
	err = ReadOnlySnapshot(ctx, pool, func(tx pgx.Tx) error { return interruptObservedQuery(t, ctx, nil, observer, tx) })
	observer.Release()
	var failure *store.TransactionError
	if !errors.As(err, &failure) || failure.Phase != "operation" || failure.CommitAttempted || failure.CleanupFailed || failure.Outcome != store.TransactionNotCommitted || !errors.Is(err, context.DeadlineExceeded) || !errors.Is(err, pgconn.ErrConnClosed) {
		t.Fatalf("deadline cleanup lost its outcome or cause: %#v %v", failure, err)
	}
	if failed, state := store.DatabaseErrorFacts(err); failed {
		t.Fatalf("confirmed deadline cleanup became a database failure: %q %v", state, err)
	}
	assertMigrationPoolReusable(t, pool)
}
