package postgres

import (
	"context"
	"os"
	"sync"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5/pgxpool"
)

var schemaManagement struct {
	once sync.Once
	pool *pgxpool.Pool
	err  error
}

func TestMain(m *testing.M) {
	code := m.Run()
	if schemaManagement.pool != nil {
		schemaManagement.pool.Close()
	}
	os.Exit(code)
}

func scopedDatabaseURL(t *testing.T) string {
	t.Helper()
	raw := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if raw == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required for PostgreSQL tests")
	}
	schemaManagement.once.Do(func() {
		schemaManagement.pool, schemaManagement.err = pgxpool.New(context.Background(), raw)
	})
	if schemaManagement.err != nil {
		t.Fatal(schemaManagement.err)
	}
	return testutil.ScopedDatabaseURLWithPool(t, schemaManagement.pool)
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
