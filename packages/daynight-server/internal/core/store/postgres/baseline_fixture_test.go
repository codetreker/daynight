package postgres

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"fmt"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema/baseline-099.sql
var baselineSchemaSnapshot string

func bootstrapBaseline(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	if err := initializeSchema(t.Context(), pool, nil, baselineSchemaSnapshot); err != nil {
		t.Fatalf("initialize version 99: %v", err)
	}
}

func migrate(ctx context.Context, pool *pgxpool.Pool, migrations []migration) error {
	return withMigrationLock(ctx, pool, func(conn *pgxpool.Conn) error {
		return replayMigrations(ctx, conn, migrations)
	})
}

func migrateTo(t *testing.T, pool *pgxpool.Pool, version int64) {
	t.Helper()
	if err := migrate(t.Context(), pool, migrationsThrough(version)); err != nil {
		t.Fatalf("migrate through version %d: %v", version, err)
	}
}

func migrationsThrough(version int64) []migration {
	if version == 99 {
		return nil
	}
	index := slices.IndexFunc(schemaMigrations, func(entry migration) bool {
		return entry.version == version
	})
	if index < 0 {
		panic(fmt.Sprintf("unknown migration test checkpoint %d", version))
	}
	return schemaMigrations[:index+1]
}

// The digest fixes the ordered version and checksum identity emitted by
// the original version-99 runner at commit 2060f6d2059055f2abcc2086ceebed81752a7982.
const baselineLedgerSHA256 = "c7f8c7a084ec08edd555ee5d11342c1a8d314615b65a749632bd12f86d468e10"

func assertMigrationLedger(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := t.Context()
	var prefix string
	if err := pool.QueryRow(ctx, `SELECT string_agg(version::text || chr(9) || checksum,
		chr(10) ORDER BY version) || chr(10) FROM schema_migrations WHERE version <= 99`).Scan(&prefix); err != nil {
		t.Fatal(err)
	}
	if digest := fmt.Sprintf("%x", sha256.Sum256([]byte(prefix))); digest != baselineLedgerSHA256 {
		t.Fatalf("migration ledger prefix digest = %s, want %s", digest, baselineLedgerSHA256)
	}

	rows, err := pool.Query(ctx, "SELECT version, checksum FROM schema_migrations WHERE version > 99 ORDER BY version")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for _, migration := range schemaMigrations {
		if !rows.Next() {
			t.Fatalf("missing migration ledger row for version %d: %v", migration.version, rows.Err())
		}
		var version int64
		var checksum string
		if err := rows.Scan(&version, &checksum); err != nil {
			t.Fatal(err)
		}
		if version != migration.version || checksum != migration.checksum() {
			t.Fatalf("unexpected migration ledger row: got (%d, %s), want (%d, %s)", version, checksum, migration.version, migration.checksum())
		}
	}
	if rows.Next() {
		t.Fatal("migration ledger contains an extra tail row")
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
}
