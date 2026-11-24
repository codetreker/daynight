//go:build startupshutdown || webhooktest

package postgres

import (
	"context"
	_ "embed"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema/baseline-099.sql
var historicalBaselineSQL string

// ReplayHistoricalSchemaForTest builds a supported checkpoint from an empty
// namespace using the rebase baseline and the registered subsequent migrations.
func ReplayHistoricalSchemaForTest(ctx context.Context, pool *pgxpool.Pool, version int64) error {
	end := 0
	for i, migration := range schemaMigrations {
		if migration.version == version {
			end = i + 1
			break
		}
	}
	if end == 0 && version != 99 {
		return fmt.Errorf("historical migration %d is not registered", version)
	}
	return withMigrationLock(ctx, pool, func(conn *pgxpool.Conn) error {
		var empty bool
		if err := conn.QueryRow(ctx, `SELECT NOT EXISTS (
			SELECT 1 FROM pg_depend
			WHERE refclassid='pg_namespace'::regclass AND refobjid=current_schema()::regnamespace
		)`).Scan(&empty); err != nil {
			return err
		}
		if !empty {
			return fmt.Errorf("historical fixture requires an empty schema")
		}
		if err := bootstrapSchema(ctx, conn, nil, historicalBaselineSQL); err != nil {
			return err
		}
		return replayMigrations(ctx, conn, schemaMigrations[:end])
	})
}
