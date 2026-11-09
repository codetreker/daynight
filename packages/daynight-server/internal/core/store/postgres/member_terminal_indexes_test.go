package postgres

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type indexCatalogEntry struct {
	table, method string
	unique        bool
	valid, ready  bool
	keyCount      int16
	columns       []string
	predicate     *string
}

func memberTerminalIndex(t *testing.T, pool *pgxpool.Pool, name string) (indexCatalogEntry, error) {
	t.Helper()
	var entry indexCatalogEntry
	err := pool.QueryRow(context.Background(), `SELECT tbl.relname, am.amname, idx.indisunique,
		idx.indisvalid, idx.indisready, idx.indnkeyatts,
		ARRAY(SELECT pg_get_indexdef(idx.indexrelid, n, true)
		      FROM generate_series(1, idx.indnatts) AS n ORDER BY n),
		pg_get_expr(idx.indpred, idx.indrelid)
		FROM pg_index idx
		JOIN pg_class index_rel ON index_rel.oid=idx.indexrelid
		JOIN pg_class tbl ON tbl.oid=idx.indrelid
		JOIN pg_am am ON am.oid=index_rel.relam
		WHERE index_rel.relnamespace=current_schema()::regnamespace
		  AND tbl.relnamespace=current_schema()::regnamespace AND index_rel.relname=$1`, name).
		Scan(&entry.table, &entry.method, &entry.unique, &entry.valid, &entry.ready,
			&entry.keyCount, &entry.columns, &entry.predicate)
	return entry, err
}

func assertMemberTerminalIndexes(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	predicate := "((receipt ->> 'state'::text) = ANY (ARRAY['queued'::text, 'dispatching'::text]))"
	for _, want := range []struct {
		name, table string
		columns     []string
		predicate   *string
	}{
		{"team_members_team_created", "team_members", []string{"team_id", "created_at"}, nil},
		{"session_operations_terminal_pending", "session_operations", []string{"session_id", "operation_seq"}, &predicate},
	} {
		got, err := memberTerminalIndex(t, pool, want.name)
		if err != nil {
			t.Fatalf("read index %s: %v", want.name, err)
		}
		if got.table != want.table || got.method != "btree" || got.unique || !got.valid || !got.ready ||
			got.keyCount != int16(len(want.columns)) || !slices.Equal(got.columns, want.columns) ||
			(got.predicate == nil) != (want.predicate == nil) ||
			(got.predicate != nil && *got.predicate != *want.predicate) {
			t.Errorf("index %s: got %+v, want table=%s btree nonunique keys=%v predicate=%v", want.name, got, want.table, want.columns, want.predicate)
		}
	}
}

func TestMemberTerminalIndexesSnapshotAndUpgrade(t *testing.T) {
	ctx := context.Background()
	snapshot := emptyPool(t)
	if err := initializeSchema(ctx, snapshot, schemaMigrations, currentSchemaSnapshot); err != nil {
		t.Fatal(err)
	}
	assertMemberTerminalIndexes(t, snapshot)

	upgrade := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 55 })
	if index < 1 || schemaMigrations[index-1].version != 54 {
		t.Fatal("migration 055 must follow 054")
	}
	if err := migrate(ctx, upgrade, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	var upgradeSchema, snapshotSchema string
	if err := upgrade.QueryRow(ctx, "SELECT current_schema()").Scan(&upgradeSchema); err != nil {
		t.Fatal(err)
	}
	if err := snapshot.QueryRow(ctx, "SELECT current_schema()").Scan(&snapshotSchema); err != nil {
		t.Fatal(err)
	}
	config := upgrade.Config()
	config.ConnConfig.RuntimeParams["search_path"] = pgx.Identifier{upgradeSchema}.Sanitize() + "," + pgx.Identifier{snapshotSchema}.Sanitize()
	withFallback, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(withFallback.Close)
	// Identically named indexes in a fallback schema must not satisfy this fixture.
	for _, name := range []string{"team_members_team_created", "session_operations_terminal_pending"} {
		var found bool
		if err := withFallback.QueryRow(ctx, "SELECT to_regclass($1) IS NOT NULL", name).Scan(&found); err != nil || !found {
			t.Fatalf("fallback index %s not visible: %t, %v", name, found, err)
		}
		if _, err := memberTerminalIndex(t, withFallback, name); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("index %s before upgrade: expected no rows, got %v", name, err)
		}
	}
	if err := initializeSchema(ctx, withFallback, schemaMigrations, currentSchemaSnapshot); err != nil {
		t.Fatal(err)
	}
	assertMemberTerminalIndexes(t, withFallback)
}
