package testutil

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// HideRelation commits a reversible table rename and verifies its original OID.
func HideRelation(t *testing.T, ctx context.Context, pool *pgxpool.Pool, relation string) func(context.Context) {
	t.Helper()
	hidden := "missing_" + relation
	relationOIDs := func(ctx context.Context) (uint32, uint32) {
		var original, renamed uint32
		if err := pool.QueryRow(ctx, `SELECT COALESCE(to_regclass($1)::oid,0::oid),COALESCE(to_regclass($2)::oid,0::oid)`, relation, hidden).Scan(&original, &renamed); err != nil {
			t.Fatal(err)
		}
		return original, renamed
	}
	original, renamed := relationOIDs(ctx)
	if original == 0 || renamed != 0 {
		t.Fatalf("unexpected catalog before hiding %s: original=%d renamed=%d", relation, original, renamed)
	}
	sourceName, hiddenName := pgx.Identifier{relation}.Sanitize(), pgx.Identifier{hidden}.Sanitize()
	if _, err := pool.Exec(ctx, "ALTER TABLE "+sourceName+" RENAME TO "+hiddenName); err != nil {
		t.Fatal(err)
	}
	if source, target := relationOIDs(ctx); source != 0 || target != original {
		t.Fatalf("unexpected catalog after hiding %s: original=%d renamed=%d, want (0,%d)", relation, source, target, original)
	}
	pool.Reset()
	return func(ctx context.Context) {
		if _, err := pool.Exec(ctx, "ALTER TABLE "+hiddenName+" RENAME TO "+sourceName); err != nil {
			t.Fatal(err)
		}
		if source, target := relationOIDs(ctx); source != original || target != 0 {
			t.Fatalf("unexpected catalog after restoring %s: original=%d renamed=%d, want (%d,0)", relation, source, target, original)
		}
		pool.Reset()
	}
}
