package webhook

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/jackc/pgx/v5"
)

var _ store.WebhookHistoryReader = (*DAO)(nil)

// A late observation extends retained history even before maintenance persists its deadline.
const retainedHistory = `d.purging_at IS NULL AND (d.metadata_expires_at > now() OR (d.state='pending' AND d.expires_at > now()) OR (d.state='leased' AND d.lease_until > now()) OR EXISTS (SELECT 1 FROM webhook_attempts ra WHERE ra.delivery_id=d.id AND GREATEST(ra.finished_at,ra.late_observed_at) > now()-interval '30 days'))`

func (d *DAO) HistoryDeliveries(ctx context.Context, o wm.Owner, endpoint string, after time.Time, id string, limit int) ([]store.WebhookDelivery, error) {
	rows, err := d.tx.Query(ctx, `SELECT `+deliveryColumns+` FROM webhook_deliveries d WHERE owner_kind=$1 AND owner_id=$2 AND endpoint_id=$3 AND `+retainedHistory+` AND ($4::timestamptz IS NULL OR (occurred_at,id)>($4,$5::uuid)) ORDER BY occurred_at,id LIMIT $6`, o.Kind, o.ID, endpoint, nullableTime(after), nullableString(id), limit)
	if err != nil {
		return nil, pg.QueryError("list webhook history", err)
	}
	defer rows.Close()
	out := make([]store.WebhookDelivery, 0)
	for rows.Next() {
		v, e := scanDelivery(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	if err = rows.Err(); err != nil {
		return nil, pg.QueryError("list webhook history", err)
	}
	return out, nil
}
func nullableTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}
func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func (d *DAO) HistoryDelivery(ctx context.Context, o wm.Owner, endpoint, id string) (store.WebhookDelivery, error) {
	return scanDelivery(d.tx.QueryRow(ctx, `SELECT `+deliveryColumns+` FROM webhook_deliveries d WHERE owner_kind=$1 AND owner_id=$2 AND endpoint_id=$3 AND id=$4 AND `+retainedHistory+``, o.Kind, o.ID, endpoint, id))
}
func (d *DAO) HistorySources(ctx context.Context, delivery store.WebhookDelivery, actor string) (store.WebhookHistorySources, error) {
	var s store.WebhookHistorySources
	e := &s.Event
	err := d.tx.QueryRow(ctx, `SELECT id::text,event_type,wire_version,schema_version,source,subject,project_id::text,task_id::text,task_version,task_deleted_at,step_id,message_id::text,occurred_at,recorded_at,origin_request_id,fact_codec_version,fact_bytes,fact_sha256,original_fact_bytes,fact_removed_at FROM webhook_events WHERE id=$1`, delivery.EventID).Scan(&e.ID, &e.EventType, &e.WireVersion, &e.SchemaVersion, &e.Source, &e.Subject, &e.ProjectID, &e.TaskID, &e.TaskVersion, &e.TaskDeletedAt, &e.StepID, &e.MessageID, &e.OccurredAt, &e.RecordedAt, &e.OriginRequestID, &e.FactCodecVersion, &e.FactBytes, &e.FactSHA256, &s.OriginalFactBytes, &s.FactRemovedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return s, store.ErrWebhookHistoryEventMissing
	}
	if err != nil {
		return s, pg.QueryError("read webhook history event", err)
	}
	err = d.tx.QueryRow(ctx, `SELECT title FROM tasks WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`, e.TaskID, e.ProjectID).Scan(&s.TaskTitle)
	if err == nil {
		s.TaskPresent = true
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return s, pg.QueryError("read webhook history task", err)
	}
	err = d.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects p JOIN project_ownership o ON o.project_id=p.id JOIN teams t ON t.id=o.team_id WHERE p.id=$1 AND p.deleted_at IS NULL AND (EXISTS(SELECT 1 FROM team_members m WHERE m.team_id=o.team_id AND m.user_id=$2) OR EXISTS(SELECT 1 FROM project_grants g WHERE g.project_id=p.id AND g.user_id=$2)))`, e.ProjectID, actor).Scan(&s.ProjectReadable)
	if err != nil {
		return s, pg.QueryError("read webhook history permission", err)
	}
	matches, err := d.HistoryMatches(ctx, []string{delivery.ID})
	if err != nil {
		return s, err
	}
	for _, match := range matches {
		s.Matches = append(s.Matches, match.WebhookAdmissionMatch)
	}
	return s, nil
}
func (d *DAO) HistoryAttempts(ctx context.Context, id string) ([]store.WebhookAttempt, error) {
	rows, err := d.tx.Query(ctx, `SELECT `+attemptColumns+` FROM webhook_attempts WHERE delivery_id=$1 ORDER BY generation,sequence,id`, id)
	if err != nil {
		return nil, pg.QueryError("read webhook attempts", err)
	}
	defer rows.Close()
	out := make([]store.WebhookAttempt, 0)
	for rows.Next() {
		a, e := scanAttempt(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, a)
	}
	if err = rows.Err(); err != nil {
		return nil, pg.QueryError("read webhook attempts", err)
	}
	return out, nil
}
func (d *DAO) LatestAttempt(ctx context.Context, endpoint string) (*store.WebhookAttempt, error) {
	a, err := scanAttempt(d.tx.QueryRow(ctx, `SELECT `+attemptColumns+` FROM webhook_attempts WHERE id=(SELECT a.id FROM webhook_attempts a JOIN webhook_deliveries d ON d.id=a.delivery_id WHERE a.endpoint_id=$1 AND d.endpoint_id=$1 AND `+retainedHistory+` ORDER BY a.admitted_at DESC,a.id DESC LIMIT 1)`, endpoint))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// HistoryDisclosure binds a cursor to current readable projects and Task
// tombstones without depending on retained webhook records or subscriptions.
func (d *DAO) HistoryDisclosure(ctx context.Context, _ wm.Owner, _ string, actor string, before time.Time) (string, error) {
	rows, err := d.tx.Query(ctx, `WITH accessible AS (
		SELECT p.id FROM projects p JOIN project_ownership po ON po.project_id=p.id JOIN teams team ON team.id=po.team_id
		WHERE p.deleted_at IS NULL AND p.created_at <= $2 AND
			(EXISTS(SELECT 1 FROM team_members m WHERE m.team_id=po.team_id AND m.user_id=$1)
			 OR EXISTS(SELECT 1 FROM project_grants g WHERE g.project_id=p.id AND g.user_id=$1))
	)
	SELECT 'project', id::text FROM accessible
	UNION ALL
	SELECT 'task', t.id::text FROM accessible JOIN tasks t ON t.project_id=accessible.id
		WHERE t.created_at <= $2 AND t.deleted_at IS NOT NULL
	ORDER BY 1,2`, actor, before)
	if err != nil {
		return "", pg.QueryError("read webhook disclosure", err)
	}
	defer rows.Close()
	h := sha256.New()
	for rows.Next() {
		var kind, id string
		if err = rows.Scan(&kind, &id); err != nil {
			return "", pg.QueryError("read webhook disclosure", err)
		}
		fmt.Fprintf(h, "%s:%s\n", kind, id)
	}
	if err = rows.Err(); err != nil {
		return "", pg.QueryError("read webhook disclosure", err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
