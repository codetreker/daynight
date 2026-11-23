package postgres

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"errors"
	"fmt"

	migration026 "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/schema/migrations/026"
	migration083 "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/schema/migrations/083"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema/migrations/001_projects.sql
var projectsSQL string

//go:embed schema/migrations/002_tasks.sql
var tasksSQL string

//go:embed schema/migrations/003_task_properties.sql
var taskPropertiesSQL string

//go:embed schema/migrations/004_task_attachments.sql
var taskAttachmentsSQL string

//go:embed schema/migrations/005_identity.sql
var identitySQL string

//go:embed schema/migrations/006_project_membership.sql
var projectMembershipSQL string

//go:embed schema/migrations/007_task_proposed.sql
var taskProposedSQL string

//go:embed schema/migrations/008_task_proposed_default.sql
var taskProposedDefaultSQL string

//go:embed schema/migrations/009_task_timing.sql
var taskTimingSQL string

//go:embed schema/migrations/010_project_settings.sql
var projectSettingsSQL string

//go:embed schema/migrations/011_task_agent_permission.sql
var taskAgentPermissionSQL string

//go:embed schema/migrations/012_external_dependencies.sql
var externalDependenciesSQL string

//go:embed schema/migrations/013_task_required_platform.sql
var taskRequiredPlatformSQL string

//go:embed schema/migrations/014_task_status_assignment.sql
var taskStatusAssignmentSQL string

//go:embed schema/migrations/015_task_sync.sql
var taskSyncSQL string

//go:embed schema/migrations/016_task_worker.sql
var taskWorkerSQL string

//go:embed schema/migrations/017_task_soft_delete.sql
var taskSoftDeleteSQL string

//go:embed schema/migrations/018_device_authorization.sql
var deviceAuthorizationSQL string

//go:embed schema/migrations/019_optional_token_expiry.sql
var optionalTokenExpirySQL string

//go:embed schema/migrations/020_worker_agent_control_mode.sql
var workerAgentControlModeSQL string

//go:embed schema/migrations/021_task_sessions.sql
var taskSessionsSQL string

//go:embed schema/migrations/022_session_connection_credential.sql
var sessionConnectionCredentialSQL string

//go:embed schema/migrations/023_session_transaction_ownership.sql
var sessionTransactionOwnershipSQL string

//go:embed schema/migrations/024_test_sessions.sql
var testSessionsSQL string

//go:embed schema/migrations/025_worker_snapshots.sql
var workerSnapshotsSQL string

//go:embed schema/migrations/027_session_archives.sql
var sessionArchivesSQL string

//go:embed schema/migrations/028_task_assignment.sql
var taskAssignmentSQL string

//go:embed schema/migrations/029_task_threads.sql
var taskThreadsSQL string

//go:embed schema/migrations/030_task_steps.sql
var taskStepsSQL string

//go:embed schema/migrations/031_terminal_sessions.sql
var terminalSessionsSQL string

//go:embed schema/migrations/032_personal_project_ownership.sql
var personalProjectOwnershipSQL string

//go:embed schema/migrations/033_bots.sql
var botsSQL string

//go:embed schema/migrations/034_worker_configuration.sql
var workerConfigurationSQL string

//go:embed schema/migrations/035_team_invitations.sql
var teamInvitationsSQL string

//go:embed schema/migrations/036_bot_defaults.sql
var botDefaultsSQL string

//go:embed schema/migrations/037_bot_session_binding.sql
var botSessionBindingSQL string

//go:embed schema/migrations/038_oauth_family.sql
var oauthFamilySQL string

//go:embed schema/migrations/039_oauth_clients.sql
var oauthClientsSQL string

//go:embed schema/migrations/040_oauth_authorizations.sql
var oauthAuthorizationsSQL string

//go:embed schema/migrations/041_private_transfers.sql
var privateTransfersSQL string

//go:embed schema/migrations/042_oauth_cleanup_cursor.sql
var oauthCleanupCursorSQL string

//go:embed schema/migrations/045_bot_native_preferences.sql
var botNativePreferencesSQL string

//go:embed schema/migrations/046_task_cancelled.sql
var taskCancelledSQL string

//go:embed schema/migrations/047_login_scope.sql
var loginScopeSQL string

//go:embed schema/migrations/043_upload_chunks.sql
var uploadChunksSQL string

//go:embed schema/migrations/044_project_soft_delete.sql
var projectSoftDeleteSQL string

//go:embed schema/migrations/048_webhook_management.sql
var webhookManagementSQL string

//go:embed schema/migrations/049_webhook_subscriptions.sql
var webhookSubscriptionsSQL string

//go:embed schema/migrations/050_webhook_capture.sql
var webhookCaptureSQL string

//go:embed schema/migrations/051_webhook_delivery.sql
var webhookDeliverySQL string

//go:embed schema/migrations/052_webhook_redelivery.sql
var webhookRedeliverySQL string

//go:embed schema/migrations/053_webhook_signing_key_expiry.sql
var webhookSigningKeyExpirySQL string

//go:embed schema/migrations/054_worker_platform_preference.sql
var workerPlatformPreferenceSQL string

//go:embed schema/migrations/055_member_terminal_indexes.sql
var memberTerminalIndexesSQL string

//go:embed schema/migrations/056_worker_prompts.sql
var workerPromptsSQL string

//go:embed schema/migrations/057_session_image_resources.sql
var sessionImageResourcesMigration string

//go:embed schema/migrations/058_session_archive_bundles.sql
var sessionArchiveBundlesMigration string

//go:embed schema/migrations/059_session_media_rates.sql
var sessionMediaRatesMigration string

//go:embed schema/migrations/060_task_proposed.sql
var taskProposedStateSQL string

//go:embed schema/migrations/061_task_type_parent.sql
var taskTypeParentSQL string

//go:embed schema/migrations/062_task_resource_rows.sql
var taskResourceRowsSQL string

//go:embed schema/migrations/063_task_assignment_all_index.sql
var taskAssignmentAllIndexSQL string

//go:embed schema/migrations/064_microsoft_identity.sql
var microsoftIdentitySQL string

//go:embed schema/migrations/065_release_worker_ownership.sql
var releaseWorkerOwnershipSQL string

//go:embed schema/migrations/066_credential_last_used.sql
var credentialLastUsedSQL string

//go:embed schema/migrations/067_api_oauth_lifetime.sql
var apiOAuthLifetimeSQL string

//go:embed schema/migrations/068_project_github.sql
var projectGitHubSQL string

//go:embed schema/migrations/071_assistant_tasks.sql
var assistantTasksSQL string

//go:embed schema/migrations/069_project_github_pending_prs.sql
var projectGitHubPendingPRsSQL string

//go:embed schema/migrations/070_task_tags.sql
var taskTagsSQL string

//go:embed schema/migrations/073_project_github_sync.sql
var projectGitHubSyncSQL string

//go:embed schema/migrations/072_personal_in_progress.sql
var personalInProgressSQL string

//go:embed schema/migrations/074_tag_color.sql
var tagColorSQL string

//go:embed schema/migrations/075_preview_sso.sql
var previewSSOSQL string

//go:embed schema/migrations/076_github_apps.sql
var githubAppsSQL string

//go:embed schema/migrations/077_github_app_cutover.sql
var githubAppCutoverSQL string

//go:embed schema/migrations/078_project_pull_requests_author_number.sql
var projectPullRequestsAuthorNumberSQL string

//go:embed schema/migrations/079_worker_sudo_cleanup.sql
var workerSudoCleanupSQL string

//go:embed schema/migrations/080_worker_archive_sessions.sql
var workerArchiveSessionsSQL string

//go:embed schema/migrations/081_worker_alias.sql
var workerAliasSQL string

//go:embed schema/migrations/082_worker_task_tag_filter.sql
var workerTaskTagFilterSQL string

//go:embed schema/migrations/086_usage_records.sql
var usageRecordsSQL string

//go:embed schema/migrations/087_task_blocked.sql
var taskBlockedSQL string

//go:embed schema/migrations/088_github_coverage.sql
var githubCoverageSQL string

//go:embed schema/migrations/089_session_archive_retention.sql
var sessionArchiveRetentionSQL string

//go:embed schema/migrations/090_dependency_types.sql
var dependencyTypesSQL string

//go:embed schema/migrations/091_goal_dependencies.sql
var goalDependenciesSQL string

//go:embed schema/migrations/092_session_archive_cleanup.sql
var sessionArchiveCleanupSQL string

//go:embed schema/migrations/093_github_repository_sources.sql
var githubRepositorySourcesSQL string

//go:embed schema/migrations/094_worker_review_participation.sql
var workerReviewParticipationSQL string

//go:embed schema/migrations/095_project_repository_version.sql
var projectRepositoryVersionSQL string

//go:embed schema/migrations/096_pr_review_assignment.sql
var prReviewAssignmentSQL string

//go:embed schema/migrations/099_assistant_task_inboxes.sql
var assistantTaskInboxesSQL string

//go:embed schema/migrations/100_bot_recovery.sql
var botRecoverySQL string

type githubRepositoryIdentityMigrationError struct {
	projectID uuid.UUID
	cause     error
}

func (e *githubRepositoryIdentityMigrationError) Error() string {
	return fmt.Sprintf("migration 93: missing trustworthy GitHub repository identity for project %s", e.projectID)
}
func (e *githubRepositoryIdentityMigrationError) Unwrap() error { return e.cause }

//go:embed schema/migrations/097_webhook_event_actor.sql
var webhookEventActorSQL string

//go:embed schema/migrations/098_assistant_task_outcomes.sql
var assistantTaskOutcomesSQL string

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

//go:embed schema/migrations/115_browser_session_activity.sql
var browserSessionActivitySQL string

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
	{version: 74, sql: tagColorSQL},
	{version: 75, sql: previewSSOSQL},
	{version: 76, sql: githubAppsSQL},
	{version: 77, sql: githubAppCutoverSQL},
	{version: 78, sql: projectPullRequestsAuthorNumberSQL},
	{version: 79, sql: workerSudoCleanupSQL},
	{version: 80, sql: workerArchiveSessionsSQL},
	{version: 81, sql: workerAliasSQL},
	{version: 82, sql: workerTaskTagFilterSQL},
	{version: 83, sql: migration083.SQL(), transform: migration083.Apply, transformSource: migration083.TransformSource()},
	{version: 86, sql: usageRecordsSQL},
	{version: 87, sql: taskBlockedSQL},
	{version: 88, sql: githubCoverageSQL},
	{version: 89, sql: sessionArchiveRetentionSQL},
	{version: 90, sql: dependencyTypesSQL},
	{version: 91, sql: goalDependenciesSQL},
	{version: 92, sql: sessionArchiveCleanupSQL},
	{version: 93, sql: githubRepositorySourcesSQL},
	{version: 94, sql: workerReviewParticipationSQL},
	{version: 95, sql: projectRepositoryVersionSQL},
	{version: 96, sql: prReviewAssignmentSQL},
	{version: 97, sql: webhookEventActorSQL},
	{version: 98, sql: assistantTaskOutcomesSQL},
	{version: 99, sql: assistantTaskInboxesSQL},
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
	{version: 115, sql: browserSessionActivitySQL},
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
			var pgErr *pgconn.PgError
			if next.version == 93 && errors.As(err, &pgErr) && pgErr.Code == "DN093" {
				if id, parseErr := uuid.Parse(pgErr.Detail); parseErr == nil {
					return &githubRepositoryIdentityMigrationError{projectID: id, cause: err}
				}
			}
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
