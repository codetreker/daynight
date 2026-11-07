package webhook

import (
	"context"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

var _ store.WebhookRetentionScope = (*DAO)(nil)

func (d *DAO) LockRetentionCandidate(ctx context.Context, phase string, now time.Time) (store.WebhookDelivery, bool, error) {
	var predicate, order string
	switch phase {
	case "purge":
		predicate, order = "purging_at IS NOT NULL", "purging_at,id"
	case "close":
		predicate, order = "purging_at IS NULL AND metadata_expires_at <= $1 AND NOT (state='pending' AND expires_at > $1) AND NOT (state='leased' AND lease_until > $1)", "metadata_expires_at,id"
	case "payload":
		predicate, order = "purging_at IS NULL AND body IS NOT NULL AND payload_expires_at <= $1 AND NOT (state='pending' AND expires_at > $1) AND NOT (state='leased' AND lease_until > $1)", "payload_expires_at,id"
	default:
		return store.WebhookDelivery{}, false, fmt.Errorf("invalid retention phase")
	}
	var id string
	var err error
	if phase == "purge" {
		err = d.tx.QueryRow(ctx, `SELECT id::text FROM webhook_deliveries WHERE `+predicate+` ORDER BY `+order+` LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&id)
	} else {
		err = d.tx.QueryRow(ctx, `SELECT id::text FROM webhook_deliveries WHERE `+predicate+` ORDER BY `+order+` LIMIT 1 FOR UPDATE SKIP LOCKED`, now).Scan(&id)
	}
	if err == pgx.ErrNoRows {
		return store.WebhookDelivery{}, false, nil
	}
	if err != nil {
		return store.WebhookDelivery{}, false, pg.QueryError("select webhook retention candidate", err)
	}
	v, err := d.LockDelivery(ctx, id)
	return v, err == nil, err
}

func (d *DAO) RetentionSeconds(ctx context.Context, version int64) (int, error) {
	var seconds int
	err := d.tx.QueryRow(ctx, `SELECT metadata_retention_seconds FROM webhook_policies WHERE version=$1`, version).Scan(&seconds)
	if err != nil {
		return 0, pg.QueryError("read webhook retention policy", err)
	}
	return seconds, nil
}
func (d *DAO) ExtendRetention(ctx context.Context, id string, activity, expiry time.Time) (int, error) {
	tag, err := d.tx.Exec(ctx, `UPDATE webhook_deliveries SET last_activity_at=GREATEST(last_activity_at,$2),metadata_expires_at=GREATEST(metadata_expires_at,$3) WHERE id=$1 AND purging_at IS NULL`, id, activity, expiry)
	if err != nil {
		return 0, pg.QueryError("extend webhook retention", err)
	}
	return int(tag.RowsAffected()), nil
}
func (d *DAO) CloseRetention(ctx context.Context, id string, now time.Time) (int, error) {
	tag, err := d.tx.Exec(ctx, `UPDATE webhook_deliveries SET purging_at=$2 WHERE id=$1 AND purging_at IS NULL`, id, now)
	if err != nil {
		return 0, pg.QueryError("close webhook retention", err)
	}
	if tag.RowsAffected() != 1 {
		return 0, fmt.Errorf("webhook retention candidate unavailable")
	}
	attempts, err := d.tx.Exec(ctx, `UPDATE webhook_attempts SET retention_closed_at=$2 WHERE delivery_id=$1 AND retention_closed_at IS NULL`, id, now)
	if err != nil {
		return 0, pg.QueryError("close webhook attempt retention", err)
	}
	return 1 + int(attempts.RowsAffected()), nil
}
func (d *DAO) DeleteRetentionChildren(ctx context.Context, id string, limit int) (int, error) {
	if limit < 1 {
		return 0, fmt.Errorf("invalid retention budget")
	}
	matches, err := d.tx.Exec(ctx, `DELETE FROM webhook_delivery_matches WHERE ctid IN (SELECT ctid FROM webhook_delivery_matches WHERE delivery_id=$1 ORDER BY subscription_id,binding_id LIMIT $2)`, id, limit)
	if err != nil {
		return 0, pg.QueryError("delete webhook retained matches", err)
	}
	n := int(matches.RowsAffected())
	if n == limit {
		return n, nil
	}
	attempts, err := d.tx.Exec(ctx, `DELETE FROM webhook_attempts WHERE ctid IN (SELECT ctid FROM webhook_attempts WHERE delivery_id=$1 AND retention_closed_at IS NOT NULL ORDER BY sequence,id LIMIT $2)`, id, limit-n)
	if err != nil {
		return 0, pg.QueryError("delete webhook retained attempts", err)
	}
	return n + int(attempts.RowsAffected()), nil
}
func (d *DAO) DeleteRetainedDelivery(ctx context.Context, id string) (int, error) {
	tag, err := d.tx.Exec(ctx, `DELETE FROM webhook_deliveries d WHERE id=$1 AND purging_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM webhook_delivery_matches m WHERE m.delivery_id=d.id) AND NOT EXISTS (SELECT 1 FROM webhook_attempts a WHERE a.delivery_id=d.id)`, id)
	if err != nil {
		return 0, pg.QueryError("delete webhook retained delivery", err)
	}
	return int(tag.RowsAffected()), nil
}
func (d *DAO) DeleteUnreferencedEvent(ctx context.Context) (string, int, error) {
	var id string
	err := d.tx.QueryRow(ctx, `DELETE FROM webhook_events WHERE id IN (SELECT e.id FROM webhook_events e WHERE NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.event_id=e.id) ORDER BY e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED) RETURNING id::text`).Scan(&id)
	if err == pgx.ErrNoRows {
		return "", 0, nil
	}
	if err != nil {
		return "", 0, pg.QueryError("delete unreferenced webhook event", err)
	}
	return id, 1, nil
}
func (d *DAO) ClearExpiredEvent(ctx context.Context) (string, int, error) {
	var id string
	err := d.tx.QueryRow(ctx, `UPDATE webhook_events SET fact_bytes=NULL,fact_removed_at=clock_timestamp() WHERE id IN (SELECT e.id FROM webhook_events e WHERE e.fact_bytes IS NOT NULL AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.event_id=e.id AND d.body IS NOT NULL) ORDER BY e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED) RETURNING id::text`).Scan(&id)
	if err == pgx.ErrNoRows {
		return "", 0, nil
	}
	if err != nil {
		return "", 0, pg.QueryError("clear expired webhook event", err)
	}
	return id, 1, nil
}
func (d *DAO) RemoveExpiredPayload(ctx context.Context, id string, now time.Time) (int, error) {
	tag, err := d.tx.Exec(ctx, `UPDATE webhook_deliveries SET body=NULL,payload_removed_at=$2,payload_removed_reason='expired' WHERE id=$1 AND purging_at IS NULL AND body IS NOT NULL`, id, now)
	if err != nil {
		return 0, pg.QueryError("remove expired webhook payload", err)
	}
	return int(tag.RowsAffected()), nil
}
