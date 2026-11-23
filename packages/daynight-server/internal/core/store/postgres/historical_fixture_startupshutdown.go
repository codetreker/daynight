//go:build startupshutdown || webhooktest

package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ReplaySchema107ForTest prepares an empty test namespace using the registered
// historical migrations, including their original transforms and checksums.
func ReplaySchema107ForTest(ctx context.Context, pool *pgxpool.Pool) error {
	end := 0
	for i, migration := range schemaMigrations {
		if migration.version == 107 {
			end = i + 1
			break
		}
	}
	if end == 0 {
		return fmt.Errorf("historical migration 107 is not registered")
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
		return replayMigrations(ctx, conn, schemaMigrations[:end])
	})
}
