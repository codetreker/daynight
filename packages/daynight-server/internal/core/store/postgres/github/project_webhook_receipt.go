package github

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type projectWebhookReceipt struct {
	tx         pgx.Tx
	id         string
	locked     bool
	generation int64
}

func NewProjectWebhookReceipt(tx pgx.Tx, id string) store.GitHubProjectWebhookReceiptDAO {
	return &projectWebhookReceipt{tx: tx, id: id}
}

// The Project is already locked by WriteProject. Re-read authorization in a
// separate statement after the connection lock so completed revocations win.
func (d *projectWebhookReceipt) LockReceipt(ctx context.Context) (store.GitHubProjectWebhookReceiptFacts, error) {
	var f store.GitHubProjectWebhookReceiptFacts
	var v store.GitHubProjectWebhook
	var secretPresent, secretValid bool
	err := d.tx.QueryRow(ctx, `SELECT hook_version,hook_repository_id,hook_enabled,hook_last_received_at,
      CASE WHEN enabled THEN repository_id ELSE NULL END, hook_secret IS NOT NULL,
      CASE WHEN hook_secret IS NULL THEN false ELSE octet_length(hook_secret) BETWEEN 1 AND 4096 END
      FROM project_github WHERE project_id=$1 FOR UPDATE`, d.id).Scan(&v.Version, &v.RepositoryID, &v.Enabled, &v.LastReceivedAt, &v.CurrentRepositoryID, &secretPresent, &secretValid)
	if errors.Is(err, pgx.ErrNoRows) {
		return f, nil
	}
	if err != nil {
		return f, pg.QueryError("lock project webhook receipt", err)
	}
	f.Exists = true
	if err := validWebhook(v, secretPresent, secretValid); err != nil {
		return f, err
	}
	f.Version, f.RepositoryID, f.CurrentRepositoryID, f.Enabled = v.Version, v.RepositoryID, v.CurrentRepositoryID, v.Enabled
	err = d.tx.QueryRow(ctx, `SELECT c.sync_enabled,c.generation,c.access_state='available',
      EXISTS(SELECT 1 FROM project_ownership o
      JOIN github_apps a ON a.id=c.app_resource_id AND a.deleted_at IS NULL AND a.credential_version=c.credential_version AND a.github_app_id=c.app_id
      JOIN github_app_team_grants g ON g.id=c.team_grant_id AND g.app_resource_id=a.id AND g.team_id=o.team_id AND g.revoked_at IS NULL
      WHERE o.project_id=c.project_id AND c.enabled AND c.installation_id IS NOT NULL AND c.repository_id IS NOT NULL)
      FROM project_github c WHERE c.project_id=$1`, d.id).Scan(&f.SyncEnabled, &f.Generation, &f.AccessAvailable, &f.BindingValid)
	if err != nil {
		return f, pg.QueryError("read project webhook receipt binding", err)
	}
	d.locked, d.generation = true, f.Generation
	return f, nil
}

// RecordReceipt runs after LockReceipt and uses one database time for every
// field in this transaction; a later SQL failure rolls back the receipt too.
func (d *projectWebhookReceipt) RecordReceipt(ctx context.Context, w store.GitHubProjectWebhookReceiptWrite) error {
	if !d.locked {
		return fmt.Errorf("project webhook receipt requires connection lock")
	}
	var now time.Time
	if err := d.tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		return pg.QueryError("read project webhook receipt time", err)
	}
	var err error
	if w.Enqueue {
		_, err = d.tx.Exec(ctx, `UPDATE project_github SET hook_last_received_at=GREATEST(hook_last_received_at,$2::timestamptz),
          last_webhook_received_at=GREATEST(last_webhook_received_at,$2::timestamptz),revision=revision+1,updated_at=$2 WHERE project_id=$1`, d.id, now)
	} else {
		_, err = d.tx.Exec(ctx, `UPDATE project_github SET hook_last_received_at=GREATEST(hook_last_received_at,$2::timestamptz) WHERE project_id=$1`, d.id, now)
	}
	if err != nil {
		return pg.QueryError("record project webhook receipt", err)
	}
	if !w.Enqueue {
		return nil
	}
	_, err = d.tx.Exec(ctx, `INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at)
      VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(project_id,number) DO UPDATE SET
      generation=EXCLUDED.generation,request_id=EXCLUDED.request_id,delivery_id=EXCLUDED.delivery_id,
      received_at=EXCLUDED.received_at,next_attempt_at=EXCLUDED.next_attempt_at`, d.id, w.Number, d.generation, w.RequestID, w.DeliveryID, now)
	if err != nil {
		return pg.QueryError("record project webhook hint", err)
	}
	return nil
}
