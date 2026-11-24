package postgres

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"errors"
	"fmt"

	migration115 "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/schema/migrations/115"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema/migrations/100_bot_recovery.sql
var botRecoverySQL string

//go:embed schema/migrations/101_assistant_task_item_lifecycle.sql
var assistantTaskItemLifecycleSQL string

//go:embed schema/migrations/102_assistant_task_retrospectives.sql
var assistantTaskRetrospectivesSQL string

//go:embed schema/migrations/103_assistant_task_metrics.sql
var assistantTaskMetricsSQL string

//go:embed schema/migrations/104_assistant_task_appendix_validations.sql
var assistantTaskAppendixValidationsSQL string

//go:embed schema/migrations/105_credential_descriptions.sql
var credentialDescriptionsSQL string

//go:embed schema/migrations/106_repository_default_branch.sql
var repositoryDefaultBranchSQL string

//go:embed schema/migrations/107_review_poll_indexes.sql
var reviewPollIndexesSQL string

//go:embed schema/migrations/108_pat_business_scopes.sql
var patBusinessScopesSQL string

//go:embed schema/migrations/109_oauth_business_scopes.sql
var oauthBusinessScopesSQL string

//go:embed schema/migrations/110_worker_lifecycle.sql
var workerLifecycleSQL string

//go:embed schema/migrations/111_credential_scope_activation.sql
var credentialScopeActivationSQL string

//go:embed schema/migrations/112_worker_windows_process_cleanup.sql
var workerWindowsProcessCleanupSQL string

//go:embed schema/migrations/113_webhook_endpoint_client_key.sql
var webhookEndpointClientKeySQL string

//go:embed schema/migrations/114_session_history_policy.sql
var sessionHistoryPolicySQL string

//go:embed schema/migrations/116_archive_upload_version.sql
var archiveUploadVersionSQL string

//go:embed schema/migrations/117_session_online_mode.sql
var sessionOnlineModeSQL string

//go:embed schema/migrations/118_browser_session_activity.sql
var browserSessionActivitySQL string

//go:embed schema/migrations/119_retire_step_webhook_bindings.sql
var retireStepWebhookBindingsSQL string

//go:embed schema/migrations/120_browser_session_management.sql
var browserSessionManagementSQL string

//go:embed schema/migrations/121_worker_platform_task_mode.sql
var workerPlatformTaskModeSQL string

//go:embed schema/migrations/122_archive_single_staging.sql
var archiveSingleStagingSQL string

//go:embed schema/migrations/123_task_ancestor_visibility.sql
var taskAncestorVisibilitySQL string

//go:embed schema/migrations/124_drop_task_steps.sql
var dropTaskStepsSQL string

//go:embed schema/migrations/125_worker_instance_identity.sql
var workerInstanceIdentitySQL string

//go:embed schema/migrations/126_drop_worker_lifecycle.sql
var dropWorkerLifecycleSQL string

type migration struct {
	version         int64
	sql             string
	transform       func(context.Context, pgx.Tx) error
	transformSource string
}

var schemaMigrations = []migration{

	{version: 100, sql: botRecoverySQL},
	{version: 101, sql: assistantTaskItemLifecycleSQL},
	{version: 102, sql: assistantTaskRetrospectivesSQL},
	{version: 103, sql: assistantTaskMetricsSQL},
	{version: 104, sql: assistantTaskAppendixValidationsSQL},
	{version: 105, sql: credentialDescriptionsSQL},
	{version: 106, sql: repositoryDefaultBranchSQL},
	{version: 107, sql: reviewPollIndexesSQL},
	{version: 108, sql: patBusinessScopesSQL},
	{version: 109, sql: oauthBusinessScopesSQL},
	{version: 110, sql: workerLifecycleSQL},
	{version: 111, sql: credentialScopeActivationSQL},
	{version: 112, sql: workerWindowsProcessCleanupSQL},
	{version: 113, sql: webhookEndpointClientKeySQL},
	{version: 114, sql: sessionHistoryPolicySQL},
	{version: 115, sql: migration115.SQL(), transform: migration115.Apply, transformSource: migration115.TransformSource()},
	{version: 116, sql: archiveUploadVersionSQL},
	{version: 117, sql: sessionOnlineModeSQL},
	{version: 118, sql: browserSessionActivitySQL},
	{version: 119, sql: retireStepWebhookBindingsSQL},
	{version: 120, sql: browserSessionManagementSQL},
	{version: 121, sql: workerPlatformTaskModeSQL},
	{version: 122, sql: archiveSingleStagingSQL},
	{version: 123, sql: taskAncestorVisibilitySQL},
	{version: 124, sql: dropTaskStepsSQL},
	{version: 125, sql: workerInstanceIdentitySQL},
	{version: 126, sql: dropWorkerLifecycleSQL},
}

const migrationLock int64 = 0x4441594e49474854

func withMigrationLock(ctx context.Context, pool *pgxpool.Pool, operation func(*pgxpool.Conn) error) (err error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, releaseMigrationConnection(conn)) }()
	if _, err = conn.Exec(ctx, "SELECT pg_advisory_lock($1)", migrationLock); err != nil {
		return err
	}
	return operation(conn)
}

func replayMigrations(ctx context.Context, conn *pgxpool.Conn, migrations []migration) error {
	ledger, err := readMigrationLedger(ctx, conn, migrations)
	if err != nil {
		return err
	}
	for _, next := range migrations[ledger.applied:] {
		tx, beginErr := conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
		if beginErr != nil {
			return beginErr
		}
		if err := transact(ctx, tx, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, next.sql); err != nil {
				return err
			}
			if next.transform != nil {
				if err := next.transform(ctx, tx); err != nil {
					return err
				}
			}
			_, err := tx.Exec(ctx, "INSERT INTO "+ledger.relation+" (version, checksum) VALUES ($1, $2)", next.version, next.checksum())
			return err
		}); err != nil {
			return err
		}
	}
	return nil
}

func (m migration) checksum() string {
	if m.transform == nil {
		return checksum(m.sql)
	}
	return checksum(m.sql + "\x00" + m.transformSource)
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
