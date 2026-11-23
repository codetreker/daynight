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
	return replayHistoricalSchemaForTest(ctx, pool, 107)
}

// ReplaySchema119ForTest prepares the last schema before inherited Task deletion.
func ReplaySchema119ForTest(ctx context.Context, pool *pgxpool.Pool) error {
	return replayHistoricalSchemaForTest(ctx, pool, 119)
}

func replayHistoricalSchemaForTest(ctx context.Context, pool *pgxpool.Pool, version int64) error {
	end := 0
	for i, migration := range schemaMigrations {
		if migration.version == version {
			end = i + 1
			break
		}
	}
	if end == 0 {
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
		return replayMigrations(ctx, conn, schemaMigrations[:end])
	})
}
