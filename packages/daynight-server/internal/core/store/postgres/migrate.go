package postgres

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"errors"
	"fmt"

	migration026 "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal/migration026"
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

//go:embed migrations/017_task_soft_delete.sql
var taskSoftDeleteSQL string

//go:embed migrations/018_device_authorization.sql
var deviceAuthorizationSQL string

//go:embed migrations/019_optional_token_expiry.sql
var optionalTokenExpirySQL string

//go:embed migrations/020_worker_agent_control_mode.sql
var workerAgentControlModeSQL string

//go:embed migrations/021_task_sessions.sql
var taskSessionsSQL string

//go:embed migrations/022_session_connection_credential.sql
var sessionConnectionCredentialSQL string

//go:embed migrations/023_session_transaction_ownership.sql
var sessionTransactionOwnershipSQL string

//go:embed migrations/024_test_sessions.sql
var testSessionsSQL string

//go:embed migrations/025_worker_snapshots.sql
var workerSnapshotsSQL string

//go:embed migrations/027_session_archives.sql
var sessionArchivesSQL string

//go:embed migrations/028_task_assignment.sql
var taskAssignmentSQL string

//go:embed migrations/029_task_threads.sql
var taskThreadsSQL string

//go:embed migrations/030_task_steps.sql
var taskStepsSQL string

//go:embed migrations/031_terminal_sessions.sql
var terminalSessionsSQL string

//go:embed migrations/032_personal_project_ownership.sql
var personalProjectOwnershipSQL string

//go:embed migrations/033_bots.sql
var botsSQL string

//go:embed migrations/034_worker_configuration.sql
var workerConfigurationSQL string

//go:embed migrations/035_team_invitations.sql
var teamInvitationsSQL string

//go:embed migrations/036_bot_defaults.sql
var botDefaultsSQL string

//go:embed migrations/037_bot_session_binding.sql
var botSessionBindingSQL string

//go:embed migrations/038_oauth_family.sql
var oauthFamilySQL string

//go:embed migrations/039_oauth_clients.sql
var oauthClientsSQL string

//go:embed migrations/040_oauth_authorizations.sql
var oauthAuthorizationsSQL string

//go:embed migrations/041_private_transfers.sql
var privateTransfersSQL string

//go:embed migrations/042_oauth_cleanup_cursor.sql
var oauthCleanupCursorSQL string

//go:embed migrations/045_bot_native_preferences.sql
var botNativePreferencesSQL string

//go:embed migrations/046_task_cancelled.sql
var taskCancelledSQL string

//go:embed migrations/047_login_scope.sql
var loginScopeSQL string

//go:embed migrations/043_upload_chunks.sql
var uploadChunksSQL string

//go:embed migrations/044_project_soft_delete.sql
var projectSoftDeleteSQL string

//go:embed migrations/048_webhook_management.sql
var webhookManagementSQL string

//go:embed migrations/049_webhook_subscriptions.sql
var webhookSubscriptionsSQL string

//go:embed migrations/050_webhook_capture.sql
var webhookCaptureSQL string

//go:embed migrations/051_webhook_delivery.sql
var webhookDeliverySQL string

//go:embed migrations/052_webhook_redelivery.sql
var webhookRedeliverySQL string

//go:embed migrations/053_webhook_signing_key_expiry.sql
var webhookSigningKeyExpirySQL string

//go:embed migrations/054_worker_platform_preference.sql
var workerPlatformPreferenceSQL string

//go:embed migrations/055_member_terminal_indexes.sql
var memberTerminalIndexesSQL string

//go:embed migrations/056_worker_prompts.sql
var workerPromptsSQL string

//go:embed migrations/057_session_image_resources.sql
var sessionImageResourcesMigration string

//go:embed migrations/058_session_archive_bundles.sql
var sessionArchiveBundlesMigration string

//go:embed migrations/059_session_media_rates.sql
var sessionMediaRatesMigration string

//go:embed migrations/060_task_proposed.sql
var taskProposedStateSQL string

//go:embed migrations/061_task_type_parent.sql
var taskTypeParentSQL string

//go:embed migrations/062_task_resource_rows.sql
var taskResourceRowsSQL string

//go:embed migrations/063_task_assignment_all_index.sql
var taskAssignmentAllIndexSQL string

//go:embed migrations/064_microsoft_identity.sql
var microsoftIdentitySQL string

//go:embed migrations/065_release_worker_ownership.sql
var releaseWorkerOwnershipSQL string

//go:embed migrations/066_credential_last_used.sql
var credentialLastUsedSQL string

//go:embed migrations/067_api_oauth_lifetime.sql
var apiOAuthLifetimeSQL string

//go:embed migrations/068_project_github.sql
var projectGitHubSQL string

//go:embed migrations/071_assistant_tasks.sql
var assistantTasksSQL string

//go:embed migrations/069_project_github_pending_prs.sql
var projectGitHubPendingPRsSQL string

//go:embed migrations/070_task_tags.sql
var taskTagsSQL string

//go:embed migrations/073_project_github_sync.sql
var projectGitHubSyncSQL string

//go:embed migrations/072_personal_in_progress.sql
var personalInProgressSQL string

type migration struct {
	version         int64
	sql             string
	transform       func(context.Context, pgx.Tx) error
	transformSource string
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
	{version: 17, sql: taskSoftDeleteSQL},
	{version: 18, sql: deviceAuthorizationSQL},
	{version: 19, sql: optionalTokenExpirySQL},
	{version: 20, sql: workerAgentControlModeSQL},
	{version: 21, sql: taskSessionsSQL},
	{version: 22, sql: sessionConnectionCredentialSQL},
	{version: 23, sql: sessionTransactionOwnershipSQL},
	{version: 24, sql: testSessionsSQL},
	{version: 25, sql: workerSnapshotsSQL},
	{version: 26, sql: migration026.SQL(), transform: migration026.Apply, transformSource: migration026.TransformSource()},
	{version: 27, sql: sessionArchivesSQL},
	{version: 28, sql: taskAssignmentSQL},
	{version: 29, sql: taskThreadsSQL},
	{version: 30, sql: taskStepsSQL},
	{version: 31, sql: terminalSessionsSQL},
	{version: 32, sql: personalProjectOwnershipSQL},
	{version: 33, sql: botsSQL},
	{version: 34, sql: workerConfigurationSQL},
	{version: 35, sql: teamInvitationsSQL},
	{version: 36, sql: botDefaultsSQL},
	{version: 37, sql: botSessionBindingSQL},
	{version: 38, sql: oauthFamilySQL},
	{version: 39, sql: oauthClientsSQL},
	{version: 40, sql: oauthAuthorizationsSQL},
	{version: 41, sql: privateTransfersSQL},
	{version: 42, sql: oauthCleanupCursorSQL},
	{version: 43, sql: uploadChunksSQL},
	{version: 44, sql: projectSoftDeleteSQL},
	{version: 45, sql: botNativePreferencesSQL},
	{version: 46, sql: taskCancelledSQL},
	{version: 47, sql: loginScopeSQL},
	{version: 48, sql: webhookManagementSQL},
	{version: 49, sql: webhookSubscriptionsSQL},
	{version: 50, sql: webhookCaptureSQL},
	{version: 51, sql: webhookDeliverySQL},
	{version: 52, sql: webhookRedeliverySQL},
	{version: 53, sql: webhookSigningKeyExpirySQL},
	{version: 54, sql: workerPlatformPreferenceSQL},
	{version: 55, sql: memberTerminalIndexesSQL},
	{version: 56, sql: workerPromptsSQL},
	{version: 57, sql: sessionImageResourcesMigration},
	{version: 58, sql: sessionArchiveBundlesMigration},
	{version: 59, sql: sessionMediaRatesMigration},
	{version: 60, sql: taskProposedStateSQL},
	{version: 61, sql: taskTypeParentSQL},
	{version: 62, sql: taskResourceRowsSQL},
	{version: 63, sql: taskAssignmentAllIndexSQL},
	{version: 64, sql: microsoftIdentitySQL},
	{version: 65, sql: releaseWorkerOwnershipSQL},
	{version: 66, sql: credentialLastUsedSQL},
	{version: 67, sql: apiOAuthLifetimeSQL},
	{version: 68, sql: projectGitHubSQL},
	{version: 69, sql: projectGitHubPendingPRsSQL},
	{version: 70, sql: taskTagsSQL},
	{version: 71, sql: assistantTasksSQL},
	{version: 72, sql: personalInProgressSQL},
	{version: 73, sql: projectGitHubSyncSQL},
}

const migrationLock int64 = 0x4441594e49474854

func migrate(ctx context.Context, pool *pgxpool.Pool, migrations []migration) error {
	return withMigrationLock(ctx, pool, func(conn *pgxpool.Conn) error {
		return replayMigrations(ctx, conn, migrations)
	})
}

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
	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
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
		if err := transact(ctx, tx, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, next.sql); err != nil {
				return err
			}
			if next.transform != nil {
				if err := next.transform(ctx, tx); err != nil {
					return err
				}
			}
			_, err := tx.Exec(ctx, "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", next.version, next.checksum())
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
		if savedChecksum != migrations[applied].checksum() {
			return 0, fmt.Errorf("migration version %d checksum mismatch", version)
		}
		applied++
	}
	return applied, rows.Err()
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
