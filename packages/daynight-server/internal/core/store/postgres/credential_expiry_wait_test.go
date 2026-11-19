package postgres

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func expireCredentialDuringRowWait(t *testing.T, ctx context.Context, pool *pgxpool.Pool, holder pgx.Tx, table, credential, queryPrefix string, operation func(context.Context) error) error {
	t.Helper()
	expires := testutil.ArmCredentialExpiry(t, ctx, pool, table, credential, 2)
	workerCtx, cancel := context.WithCancel(ctx)
	result := make(chan error, 1)
	stopped := make(chan struct{})
	defer releaseRowLockAndDrain(t, cancel, holder, stopped)
	go func() {
		defer close(stopped)
		result <- operation(workerCtx)
	}()
	testutil.WaitTransferTeamLock(t, ctx, pool, queryPrefix, holder.Conn().PgConn().PID())
	testutil.WaitForCredentialExpiry(t, ctx, pool, expires)
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return testutil.ReceiveQueryResult(t, ctx, result)
}
