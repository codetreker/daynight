package github

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ReadAppWebhookSnapshot reads only the live App credentials needed for HMAC.
func ReadAppWebhookSnapshot(ctx context.Context, pool *pgxpool.Pool, id string) (store.GitHubAppWebhookSnapshot, error) {
	var snapshot store.GitHubAppWebhookSnapshot
	var hasPrivateKey bool
	err := pool.QueryRow(ctx, `SELECT github_app_id,credential_version,webhook_secret,private_key_pem IS NOT NULL AND octet_length(private_key_pem)>0 FROM github_apps WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&snapshot.GitHubAppID, &snapshot.CredentialVersion, &snapshot.Secret, &hasPrivateKey)
	if err != nil {
		return store.GitHubAppWebhookSnapshot{}, pg.QueryError("read App webhook credentials", err)
	}
	if !hasPrivateKey || len(snapshot.Secret) == 0 || snapshot.CredentialVersion <= 0 || snapshot.GitHubAppID <= 0 {
		return store.GitHubAppWebhookSnapshot{}, pg.QueryError("read App webhook credentials", errors.New("live App webhook credentials are invalid"))
	}
	return snapshot, nil
}

type appSignalWriter struct {
	tx                             pgx.Tx
	appID                          string
	githubAppID, credentialVersion int64
}

// NewAppSignalWriter requires the App and its current grants to be locked.
func NewAppSignalWriter(tx pgx.Tx, appID string, githubAppID, credentialVersion int64) store.GitHubAppSignalWriter {
	return &appSignalWriter{tx: tx, appID: appID, githubAppID: githubAppID, credentialVersion: credentialVersion}
}

// The first statement locks candidate connections in a stable order. The
// subsequent write is a separate Read Committed statement, so authorization
// and connection facts are read again after any lock wait.
func (w *appSignalWriter) lockConnections(ctx context.Context, installation int64, repository *int64) ([]string, error) {
	rows, err := w.tx.Query(ctx, `SELECT c.project_id FROM project_github c
 JOIN github_app_team_grants g ON g.id=c.team_grant_id AND g.app_resource_id=$1 AND g.revoked_at IS NULL
 JOIN project_ownership o ON o.project_id=c.project_id AND o.team_id=g.team_id
 JOIN projects p ON p.id=c.project_id AND p.deleted_at IS NULL
 WHERE c.app_resource_id=$1 AND c.app_id=$2 AND c.credential_version=$3
 AND c.enabled AND c.sync_enabled AND c.installation_id=$4 AND ($5::bigint IS NULL OR c.repository_id=$5)
 ORDER BY c.project_id FOR UPDATE OF c`, w.appID, w.githubAppID, w.credentialVersion, installation, repository)
	if err != nil {
		return nil, pg.QueryError("lock App signal connections", err)
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, pg.QueryError("lock App signal connections", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("lock App signal connections", err)
	}
	return ids, nil
}

func (w *appSignalWriter) SignalPullRequest(ctx context.Context, p store.GitHubAppPRSignal) (int64, error) {
	ids, err := w.lockConnections(ctx, p.InstallationID, &p.RepositoryID)
	if err != nil {
		return 0, err
	}
	var n int64
	err = w.tx.QueryRow(ctx, `WITH changed AS (
 UPDATE project_github c SET last_webhook_received_at=GREATEST(c.last_webhook_received_at,$8::timestamptz),revision=c.revision+1,updated_at=clock_timestamp()
 WHERE c.app_resource_id=$1 AND c.app_id=$2 AND c.credential_version=$3 AND c.enabled AND c.sync_enabled AND c.installation_id=$4 AND c.repository_id=$5 AND c.project_id=ANY($11::uuid[])
 AND EXISTS (SELECT 1 FROM github_app_team_grants g JOIN project_ownership o ON o.team_id=g.team_id JOIN projects p ON p.id=o.project_id AND p.deleted_at IS NULL WHERE g.id=c.team_grant_id AND g.app_resource_id=$1 AND g.revoked_at IS NULL AND o.project_id=c.project_id)
 RETURNING c.project_id,c.generation), written AS (
 INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at)
 SELECT project_id,$6,generation,$7,$9,$8,$10 FROM changed
 ON CONFLICT(project_id,number) DO UPDATE SET generation=EXCLUDED.generation,request_id=EXCLUDED.request_id,delivery_id=EXCLUDED.delivery_id,received_at=EXCLUDED.received_at,next_attempt_at=EXCLUDED.next_attempt_at RETURNING 1)
 SELECT count(*) FROM written`, w.appID, w.githubAppID, w.credentialVersion, p.InstallationID, p.RepositoryID, p.Number, p.RequestID, p.ReceivedAt, p.DeliveryID, p.NextAttemptAt, ids).Scan(&n)
	if err != nil {
		return 0, pg.QueryError("record App pull request signal", err)
	}
	return n, nil
}

func (w *appSignalWriter) SignalAccess(ctx context.Context, p store.GitHubAppAccessSignal) (int64, error) {
	ids, err := w.lockConnections(ctx, p.InstallationID, nil)
	if err != nil {
		return 0, err
	}
	tag, err := w.tx.Exec(ctx, `UPDATE project_github c SET access_hint_id=$5,access_delivery_id=$6,next_access_check_at=$7,last_webhook_received_at=GREATEST(c.last_webhook_received_at,$7::timestamptz),claim_token=NULL,claim_kind=NULL,claim_until=NULL,revision=c.revision+1,updated_at=clock_timestamp()
 WHERE c.app_resource_id=$1 AND c.app_id=$2 AND c.credential_version=$3 AND c.enabled AND c.sync_enabled AND c.installation_id=$4 AND c.project_id=ANY($8::uuid[])
 AND EXISTS (SELECT 1 FROM github_app_team_grants g JOIN project_ownership o ON o.team_id=g.team_id JOIN projects p ON p.id=o.project_id AND p.deleted_at IS NULL WHERE g.id=c.team_grant_id AND g.app_resource_id=$1 AND g.revoked_at IS NULL AND o.project_id=c.project_id)`, w.appID, w.githubAppID, w.credentialVersion, p.InstallationID, p.HintID, p.DeliveryID, p.ReceivedAt, ids)
	if err != nil {
		return 0, pg.QueryError("record App access signal", err)
	}
	return tag.RowsAffected(), nil
}
