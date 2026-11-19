package postgres

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestArchiveCleanupMigrationRetainsPendingDeletion(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 92 })
	if index < 1 {
		t.Fatal("missing cleanup migration")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	id := queryID(901)
	at := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	if _, err := pool.Exec(ctx, `INSERT INTO session_archive_retention(session_id,expired_at,reason,version) VALUES($1,$2,'expired',7)`, id, at); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var expired time.Time
	var cleaned *time.Time
	var version int64
	if err := pool.QueryRow(ctx, `SELECT expired_at,cleaned_at,version FROM session_archive_retention WHERE session_id=$1`, id).Scan(&expired, &cleaned, &version); err != nil || !expired.Equal(at) || cleaned != nil || version != 7 {
		t.Fatalf("migration changed pending cleanup: %v %v %d %v", expired, cleaned, version, err)
	}
	_, err := pool.Exec(ctx, `INSERT INTO session_archive_retention(session_id,cleaned_at) VALUES($1,$2)`, queryID(902), at)
	var constraint *pgconn.PgError
	if !errors.As(err, &constraint) || constraint.Code != "23514" {
		t.Fatalf("cleanup without expiration accepted: %v", err)
	}
}
