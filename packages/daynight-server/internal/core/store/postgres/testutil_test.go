package postgres

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5/pgxpool"
)

func scopedDatabaseURL(t *testing.T) string {
	t.Helper()
	return testutil.ScopedDatabaseURL(t)
}

func isolatedStore(t *testing.T) *Store {
	t.Helper()
	database, err := Open(context.Background(), scopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	return database
}

func emptyPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), scopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}
