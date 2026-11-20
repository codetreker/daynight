package assistanttask

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

const inboxColumns = `inbox_id::text,owner_user_id::text,task_id::text,state,token_digest,overlap_token_digest,overlap_until,suppressed_count,version,created_at,rotated_at`

func scanInbox(row pgx.Row) (model.AssistantTaskInbox, error) {
	var v model.AssistantTaskInbox
	err := row.Scan(&v.InboxID, &v.OwnerUserID, &v.TaskID, &v.State, &v.TokenDigest, &v.OverlapTokenDigest, &v.OverlapUntil, &v.SuppressedCount, &v.Version, &v.CreatedAt, &v.RotatedAt)
	v.CreatedAt = v.CreatedAt.UTC()
	v.OverlapUntil, v.RotatedAt = pg.UTCTime(v.OverlapUntil), pg.UTCTime(v.RotatedAt)
	return v, err
}

func (d *DAO) InsertInbox(ctx context.Context, v model.AssistantTaskInbox) (bool, error) {
	return d.changed(ctx, "insert assistant inbox", `INSERT INTO assistant_task_inboxes(inbox_id,owner_user_id,task_id,state,token_digest,overlap_token_digest,overlap_until,suppressed_count,version,created_at,rotated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`, v.InboxID, v.OwnerUserID, v.TaskID, v.State, v.TokenDigest, v.OverlapTokenDigest, v.OverlapUntil, v.SuppressedCount, v.Version, v.CreatedAt, v.RotatedAt)
}

func (d *DAO) CurrentInbox(ctx context.Context, owner, task string) (model.AssistantTaskInbox, error) {
	return one(d.tx.QueryRow(ctx, `SELECT `+inboxColumns+` FROM assistant_task_inboxes WHERE owner_user_id=$1 AND task_id=$2 AND state=$3`, owner, task, model.AssistantTaskInboxEnabled), "read current assistant inbox", scanInbox)
}

func (d *DAO) InboxIdentity(ctx context.Context, inbox string) (model.AssistantTaskInbox, error) {
	var v model.AssistantTaskInbox
	err := d.tx.QueryRow(ctx, `SELECT inbox_id::text,owner_user_id::text,task_id::text,state FROM assistant_task_inboxes WHERE inbox_id=$1`, inbox).Scan(&v.InboxID, &v.OwnerUserID, &v.TaskID, &v.State)
	if err != nil {
		return model.AssistantTaskInbox{}, pg.QueryError("read assistant inbox identity", err)
	}
	return v, nil
}

func (d *DAO) LockInbox(ctx context.Context, owner, task, inbox string) (model.AssistantTaskInbox, error) {
	return one(d.tx.QueryRow(ctx, `SELECT `+inboxColumns+` FROM assistant_task_inboxes WHERE owner_user_id=$1 AND task_id=$2 AND inbox_id=$3 FOR UPDATE`, owner, task, inbox), "lock assistant inbox", scanInbox)
}

func (d *DAO) SaveInbox(ctx context.Context, v model.AssistantTaskInbox, version int64) (bool, error) {
	return d.changed(ctx, "save assistant inbox", `UPDATE assistant_task_inboxes SET state=$4,token_digest=$5,overlap_token_digest=$6,overlap_until=$7,rotated_at=$8,version=$9 WHERE owner_user_id=$1 AND task_id=$2 AND inbox_id=$3 AND version=$10`, v.OwnerUserID, v.TaskID, v.InboxID, v.State, v.TokenDigest, v.OverlapTokenDigest, v.OverlapUntil, v.RotatedAt, v.Version, version)
}

func (d *DAO) AddInboxSuppressed(ctx context.Context, owner, task, inbox string) (bool, error) {
	return d.changed(ctx, "count suppressed assistant inbound", `UPDATE assistant_task_inboxes SET suppressed_count=suppressed_count+1 WHERE owner_user_id=$1 AND task_id=$2 AND inbox_id=$3 AND state=$4`, owner, task, inbox, model.AssistantTaskInboxEnabled)
}

const receiptColumns = `inbox_id::text,idempotency_key,owner_user_id::text,task_id::text,body_sha256,event_id::text,suppressed,target_bot_id::text,subject_task_id::text,received_at,expires_at`

func scanReceipt(row pgx.Row) (model.AssistantTaskInboxReceipt, error) {
	var v model.AssistantTaskInboxReceipt
	err := row.Scan(&v.InboxID, &v.IdempotencyKey, &v.OwnerUserID, &v.TaskID, &v.BodySHA256, &v.EventID, &v.Suppressed, &v.TargetBotID, &v.SubjectTaskID, &v.ReceivedAt, &v.ExpiresAt)
	v.ReceivedAt, v.ExpiresAt = v.ReceivedAt.UTC(), v.ExpiresAt.UTC()
	return v, err
}

func (d *DAO) InboxReceipt(ctx context.Context, owner, inbox, key string) (model.AssistantTaskInboxReceipt, error) {
	return one(d.tx.QueryRow(ctx, `SELECT `+receiptColumns+` FROM assistant_task_inbox_receipts WHERE owner_user_id=$1 AND inbox_id=$2 AND idempotency_key=$3 AND expires_at>clock_timestamp()`, owner, inbox, key), "read assistant inbox receipt", scanReceipt)
}

func (d *DAO) InsertInboxReceipt(ctx context.Context, v model.AssistantTaskInboxReceipt) (bool, error) {
	// An expired receipt still occupies its key until reclamation. Replacing it
	// here lets a reused key start a new request after expiry, while a
	// concurrent insert of an unexpired key waits for the first writer and then
	// changes nothing.
	return d.changed(ctx, "insert assistant inbox receipt", `INSERT INTO assistant_task_inbox_receipts AS r(inbox_id,idempotency_key,owner_user_id,task_id,body_sha256,event_id,suppressed,target_bot_id,subject_task_id,received_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
 ON CONFLICT (inbox_id,idempotency_key) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id,task_id=EXCLUDED.task_id,body_sha256=EXCLUDED.body_sha256,event_id=EXCLUDED.event_id,suppressed=EXCLUDED.suppressed,target_bot_id=EXCLUDED.target_bot_id,subject_task_id=EXCLUDED.subject_task_id,received_at=EXCLUDED.received_at,expires_at=EXCLUDED.expires_at
 WHERE r.owner_user_id=EXCLUDED.owner_user_id AND r.expires_at<=statement_timestamp()`, v.InboxID, v.IdempotencyKey, v.OwnerUserID, v.TaskID, v.BodySHA256, v.EventID, v.Suppressed, v.TargetBotID, v.SubjectTaskID, v.ReceivedAt, v.ExpiresAt)
}

func (d *DAO) PendingInboundEvents(ctx context.Context, owner, task, bot string, limit int) (int, error) {
	var count int
	err := d.tx.QueryRow(ctx, `SELECT count(*) FROM (SELECT 1 FROM assistant_task_events WHERE owner_user_id=$1 AND task_id=$2 AND target_bot_id=$3 AND type='inbound' AND state='pending' LIMIT $4) pending`, owner, task, bot, limit).Scan(&count)
	return count, pg.AuthQueryError("count pending assistant inbound", err)
}

func (d *DAO) ReceivedInbound(ctx context.Context, owner, bot, subject string, since, until time.Time) (bool, error) {
	var found bool
	err := d.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM assistant_task_inbox_receipts WHERE target_bot_id=$2 AND subject_task_id=$3 AND received_at BETWEEN $4 AND $5 AND owner_user_id=$1 AND NOT suppressed)`, owner, bot, subject, since, until).Scan(&found)
	return found, pg.AuthQueryError("read assistant inbound wake", err)
}

// Receipt expiry cutoffs use statement_timestamp() rather than the volatile
// clock_timestamp(): only a stable bound can become an index condition on
// assistant_task_inbox_receipts_expiry(task_id,expires_at), letting a probe skip
// a task's live receipts instead of filtering every one of them.
const (
	reclaimInboxReceiptsSQL = `DELETE FROM assistant_task_inbox_receipts WHERE (inbox_id,idempotency_key) IN (SELECT inbox_id,idempotency_key FROM assistant_task_inbox_receipts WHERE task_id=$2 AND expires_at<=statement_timestamp() AND owner_user_id=$1 ORDER BY expires_at LIMIT $3)`
	inboundReclaimTasksSQL  = `SELECT t.id::text FROM assistant_tasks t WHERE t.owner_user_id=$1 AND t.state<>'deleted' AND (EXISTS(SELECT 1 FROM assistant_task_inbox_receipts r WHERE r.task_id=t.id AND r.expires_at<=statement_timestamp()) OR EXISTS(SELECT 1 FROM assistant_task_events e WHERE e.task_id=t.id AND e.type='inbound' AND e.state IN ('delivered','expired') AND e.settled_at<$2)) ORDER BY t.id LIMIT $3`
)

func (d *DAO) ReclaimInboxReceipts(ctx context.Context, owner, task string, limit int) (int64, error) {
	return d.deleted(ctx, "reclaim assistant inbox receipts", reclaimInboxReceiptsSQL, owner, task, limit)
}

// ReclaimInboundEvents spells the event type and states as literals so every
// plan, including a generic plan for a cached prepared statement, can prove the
// predicate of the partial index assistant_task_events_inbound_settled.
func (d *DAO) ReclaimInboundEvents(ctx context.Context, owner, task string, before time.Time, limit int) (int64, error) {
	return d.deleted(ctx, "reclaim assistant inbound events", `DELETE FROM assistant_task_events WHERE id IN (SELECT id FROM assistant_task_events WHERE task_id=$2 AND type='inbound' AND state IN ('delivered','expired') AND settled_at<$3 AND owner_user_id=$1 ORDER BY settled_at LIMIT $4)`, owner, task, before, limit)
}

// InboundReclaimTasks walks the owner's tasks and probes each through the
// task-leading expiry and settled-inbound indexes, so a pull never scans other
// owners' receipts or events.
func (d *DAO) InboundReclaimTasks(ctx context.Context, owner string, before time.Time, limit int) ([]string, error) {
	return many(ctx, d.tx, "list assistant inbound reclamation tasks", inboundReclaimTasksSQL, scanID, owner, before, limit)
}

func (d *DAO) deleted(ctx context.Context, phase, query string, args ...any) (int64, error) {
	tag, err := d.tx.Exec(ctx, query, args...)
	if err != nil {
		return 0, pg.QueryError(phase, err)
	}
	return tag.RowsAffected(), nil
}

// tombstoneInbox clears the digests of the task's enabled inbox and keeps its
// identity, so the old inbox ID stays gone after task deletion.
func (d *DAO) tombstoneInbox(ctx context.Context, owner, task string) error {
	return d.execute(ctx, "tombstone assistant inbox", `UPDATE assistant_task_inboxes SET state=$3,token_digest=NULL,overlap_token_digest=NULL,overlap_until=NULL,version=version+1 WHERE owner_user_id=$1 AND task_id=$2 AND state=$4`, owner, task, model.AssistantTaskInboxTombstone, model.AssistantTaskInboxEnabled)
}
