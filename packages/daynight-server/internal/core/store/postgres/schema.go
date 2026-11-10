package postgres

import (
	"context"
	_ "embed"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema/current.sql
var currentSchemaSnapshot string

func initializeSchema(ctx context.Context, pool *pgxpool.Pool, migrations []migration, snapshot string) error {
	if err := validateSchemaSnapshot(snapshot, migrations); err != nil {
		return err
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
			return replayMigrations(ctx, conn, migrations)
		}
		return bootstrapSchema(ctx, conn, migrations, snapshot)
	})
}

func validateSchemaSnapshot(snapshot string, migrations []migration) error {
	line, _, _ := strings.Cut(snapshot, "\n")
	value, ok := strings.CutPrefix(line, "-- Schema snapshot version: ")
	version, err := strconv.ParseInt(value, 10, 64)
	latest := migrations[len(migrations)-1].version
	if !ok || err != nil || version != latest {
		return fmt.Errorf("schema snapshot version %q does not match latest migration %d; regenerate schema/current.sql", line, latest)
	}
	return nil
}

func bootstrapSchema(ctx context.Context, conn *pgxpool.Conn, migrations []migration, snapshot string) error {
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return err
	}
	return transact(ctx, tx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, snapshot); err != nil {
			return err
		}
		versions := make([]int64, len(migrations))
		checksums := make([]string, len(migrations))
		for index, migration := range migrations {
			versions[index], checksums[index] = migration.version, migration.checksum()
		}
		_, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version,checksum)
			SELECT * FROM unnest($1::bigint[],$2::text[])`, versions, checksums)
		return err
	})
}
