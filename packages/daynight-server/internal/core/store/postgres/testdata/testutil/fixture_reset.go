package testutil

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
)

// FixtureTableReset restricts truncation to the mutable tables of one fixture schema.
type FixtureTableReset struct {
	schema  string
	mutable []string
	query   string
}

func NewFixtureTableReset(schema string, mutable []string) FixtureTableReset {
	probes := make([]string, len(mutable))
	for i, name := range mutable {
		probes[i] = "(SELECT tableoid FROM ONLY " + pgx.Identifier{schema, name}.Sanitize() + " LIMIT 1)"
	}
	// PostgreSQL requires referencing tables in a TRUNCATE even when they are empty.
	query := `WITH RECURSIVE populated(oid) AS (` + strings.Join(probes, " UNION ALL ") + `),
		affected(oid) AS (
			SELECT oid FROM populated
			UNION
			SELECT constraint_row.conrelid FROM pg_constraint constraint_row
			JOIN affected ON affected.oid=constraint_row.confrelid
			WHERE constraint_row.contype='f'
		)
		SELECT coalesce(array_agg(c.relname::text ORDER BY c.relname), ARRAY[]::text[]),
			coalesce(bool_and(c.relnamespace=$1::regnamespace), true)
		FROM affected JOIN pg_class c USING (oid)`
	return FixtureTableReset{schema: schema, mutable: slices.Clone(mutable), query: query}
}

// Truncate clears populated fixture tables and their inbound foreign-key closure.
// The caller owns transaction completion and any sequence or seed restoration.
func (reset FixtureTableReset) Truncate(ctx context.Context, tx pgx.Tx) error {
	var tables []string
	var local bool
	if err := tx.QueryRow(ctx, reset.query, reset.schema).Scan(&tables, &local); err != nil {
		return fmt.Errorf("discover fixture tables to truncate: %w", err)
	}
	if !local {
		return fmt.Errorf("fixture reset crossed schema %q: %v", reset.schema, tables)
	}
	for i, name := range tables {
		if !slices.Contains(reset.mutable, name) {
			return fmt.Errorf("fixture reset reached non-mutable table %q", name)
		}
		tables[i] = "ONLY " + pgx.Identifier{reset.schema, name}.Sanitize()
	}
	if len(tables) == 0 {
		return nil
	}
	if _, err := tx.Exec(ctx, "TRUNCATE "+strings.Join(tables, ",")+" RESTART IDENTITY"); err != nil {
		return fmt.Errorf("truncate fixture tables: %w", err)
	}
	return nil
}
