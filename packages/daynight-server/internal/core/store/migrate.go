package store

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/001_projects.sql
var projectsSQL string

//go:embed migrations/002_tasks.sql
var tasksSQL string

//go:embed migrations/003_task_properties.sql
var taskPropertiesSQL string

//go:embed migrations/004_task_attachments.sql
var taskAttachmentsSQL string

//go:embed migrations/005_identity.sql
var identitySQL string

//go:embed migrations/006_project_membership.sql
var projectMembershipSQL string

//go:embed migrations/007_task_proposed.sql
var taskProposedSQL string

//go:embed migrations/008_task_proposed_default.sql
var taskProposedDefaultSQL string

//go:embed migrations/009_task_timing.sql
var taskTimingSQL string

//go:embed migrations/010_project_settings.sql
var projectSettingsSQL string

//go:embed migrations/011_task_agent_permission.sql
var taskAgentPermissionSQL string

//go:embed migrations/012_external_dependencies.sql
var externalDependenciesSQL string

//go:embed migrations/013_task_required_platform.sql
var taskRequiredPlatformSQL string

//go:embed migrations/014_task_status_assignment.sql
var taskStatusAssignmentSQL string

//go:embed migrations/015_task_sync.sql
var taskSyncSQL string

//go:embed migrations/016_task_worker.sql
var taskWorkerSQL string

//go:embed migrations/017_device_authorization.sql
var deviceAuthorizationSQL string

//go:embed migrations/018_optional_token_expiry.sql
var optionalTokenExpirySQL string

type migration struct {
	version int64
	sql     string
}

var schemaMigrations = []migration{
	{version: 1, sql: projectsSQL},
	{version: 2, sql: tasksSQL},
	{version: 3, sql: taskPropertiesSQL},
	{version: 4, sql: taskAttachmentsSQL},
	{version: 5, sql: identitySQL},
	{version: 6, sql: projectMembershipSQL},
	{version: 7, sql: taskProposedSQL},
	{version: 8, sql: taskProposedDefaultSQL},
	{version: 9, sql: taskTimingSQL},
	{version: 10, sql: projectSettingsSQL},
	{version: 11, sql: taskAgentPermissionSQL},
	{version: 12, sql: externalDependenciesSQL},
	{version: 13, sql: taskRequiredPlatformSQL},
	{version: 14, sql: taskStatusAssignmentSQL},
	{version: 15, sql: taskSyncSQL},
	{version: 16, sql: taskWorkerSQL},
	{version: 17, sql: deviceAuthorizationSQL},
	{version: 18, sql: optionalTokenExpirySQL},
}

const migrationLock int64 = 0x4441594e49474854

func migrate(ctx context.Context, pool *pgxpool.Pool, migrations []migration) (err error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, releaseMigrationConnection(conn)) }()
	if _, err = conn.Exec(ctx, "SELECT pg_advisory_lock($1)", migrationLock); err != nil {
		return err
	}
	if _, err = conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version bigint PRIMARY KEY,
		checksum text NOT NULL CHECK (length(checksum) = 64),
		applied_at timestamptz NOT NULL DEFAULT statement_timestamp()
	)`); err != nil {
		return err
	}
	applied, err := appliedMigrations(ctx, conn, migrations)
	if err != nil {
		return err
	}
	for _, next := range migrations[applied:] {
		tx, beginErr := conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
		if beginErr != nil {
			return beginErr
		}
		if err = transact(ctx, tx, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, next.sql); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", next.version, checksum(next.sql))
			return err
		}); err != nil {
			return err
		}
	}
	return nil
}

func appliedMigrations(ctx context.Context, conn *pgxpool.Conn, migrations []migration) (int, error) {
	rows, err := conn.Query(ctx, "SELECT version, checksum FROM schema_migrations ORDER BY version")
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	applied := 0
	for rows.Next() {
		var version int64
		var savedChecksum string
		if err := rows.Scan(&version, &savedChecksum); err != nil {
			return 0, err
		}
		if applied >= len(migrations) || version != migrations[applied].version {
			return 0, fmt.Errorf("migration version %d is not an ordered prefix", version)
		}
		if savedChecksum != checksum(migrations[applied].sql) {
			return 0, fmt.Errorf("migration version %d checksum mismatch", version)
		}
		applied++
	}
	return applied, rows.Err()
}

func checksum(sql string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(sql))) }

func releaseMigrationConnection(conn *pgxpool.Conn) (err error) {
	defer conn.Release()
	ctx, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
	defer cancel()
	var unlocked bool
	if err = conn.QueryRow(ctx, "SELECT pg_advisory_unlock($1)", migrationLock).Scan(&unlocked); err == nil {
		return nil
	}
	// A failed unlock leaves ownership uncertain; ending the physical session prevents a pooled lock leak.
	closeCtx, closeCancel := context.WithTimeout(context.Background(), cleanupTimeout)
	defer closeCancel()
	return errors.Join(err, conn.Conn().Close(closeCtx))
}
