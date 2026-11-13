package assistanttask

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

const eventColumns = `id::text,owner_user_id::text,task_id::text,target_bot_id::text,type,state,request_fingerprint,payload,attention,created_at,delivered_at,seen_at,ack_operation_id::text,ack_fingerprint`

func scanEvent(row pgx.Row) (model.AssistantTaskEvent, error) {
	var v model.AssistantTaskEvent
	err := row.Scan(&v.ID, &v.OwnerUserID, &v.TaskID, &v.TargetBotID, &v.Type, &v.State, &v.RequestFingerprint, &v.Payload, &v.Attention, &v.CreatedAt, &v.DeliveredAt, &v.SeenAt, &v.AckOperationID, &v.AckFingerprint)
	v.CreatedAt = v.CreatedAt.UTC()
	v.DeliveredAt, v.SeenAt = pg.UTCTime(v.DeliveredAt), pg.UTCTime(v.SeenAt)
	return v, err
}
func (d *DAO) Event(ctx context.Context, owner, task, id string) (model.AssistantTaskEvent, error) {
	return one(d.tx.QueryRow(ctx, `SELECT `+eventColumns+` FROM assistant_task_events WHERE owner_user_id=$1 AND task_id=$2 AND id=$3`, owner, task, id), "read assistant event", scanEvent)
}
func (d *DAO) Events(ctx context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskEvent, error) {
	after, id, limit := page(q)
	return many(ctx, d.tx, "list assistant events", `SELECT `+eventColumns+` FROM assistant_task_events WHERE owner_user_id=$1 AND ($2::uuid IS NULL OR task_id=$2) AND ($3='' OR state=$3) AND ($4::uuid IS NULL OR target_bot_id=$4) AND ($5::timestamptz IS NULL OR (created_at,id)>($5,$6::uuid)) ORDER BY created_at,id LIMIT $7`, scanEvent, q.OwnerUserID, nullableID(q.TaskID), q.State, nullableID(q.TargetBotID), after, id, limit)
}
func eventValues(v model.AssistantTaskEvent) []any {
	return []any{v.ID, v.OwnerUserID, v.TaskID, v.TargetBotID, v.Type, v.State, v.RequestFingerprint, v.Payload, v.Attention, v.CreatedAt, v.DeliveredAt, v.SeenAt, v.AckOperationID, v.AckFingerprint}
}
func (d *DAO) InsertEvent(ctx context.Context, v model.AssistantTaskEvent) (bool, error) {
	return d.changed(ctx, "insert assistant event", `INSERT INTO assistant_task_events(id,owner_user_id,task_id,target_bot_id,type,state,request_fingerprint,payload,attention,created_at,delivered_at,seen_at,ack_operation_id,ack_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`, eventValues(v)...)
}
func (d *DAO) SaveEvent(ctx context.Context, v model.AssistantTaskEvent, state string) (bool, error) {
	// SeenAt is advanced only by MarkAttentionSeen, which can commit independently
	// of a task-scoped acknowledgement using an earlier event snapshot.
	return d.changed(ctx, "save assistant event", `UPDATE assistant_task_events SET target_bot_id=$4,type=$5,state=$6,request_fingerprint=$7,payload=$8,attention=$9,created_at=$10,delivered_at=$11,ack_operation_id=$12,ack_fingerprint=$13 WHERE id=$1 AND owner_user_id=$2 AND task_id=$3 AND state=$14`, v.ID, v.OwnerUserID, v.TaskID, v.TargetBotID, v.Type, v.State, v.RequestFingerprint, v.Payload, v.Attention, v.CreatedAt, v.DeliveredAt, v.AckOperationID, v.AckFingerprint, state)
}
func (d *DAO) MarkAttentionSeen(ctx context.Context, owner, target string, at time.Time, exceptTypes []string) error {
	if exceptTypes == nil {
		exceptTypes = []string{}
	}
	return d.execute(ctx, "mark assistant attention seen", `UPDATE assistant_task_events SET seen_at=$3 WHERE owner_user_id=$1 AND target_bot_id=$2 AND attention AND seen_at IS NULL AND NOT(type=ANY($4::text[]))`, owner, target, at, exceptTypes)
}

const inquiryColumns = `id::text,owner_user_id::text,task_id::text,from_bot_id::text,to_bot_id::text,question,answer,state,request_fingerprint,item_id::text,created_at,deadline,answered_at,answer_bot_id::text`

func scanInquiry(row pgx.Row) (model.AssistantTaskInquiry, error) {
	var v model.AssistantTaskInquiry
	err := row.Scan(&v.ID, &v.OwnerUserID, &v.TaskID, &v.FromBotID, &v.ToBotID, &v.Question, &v.Answer, &v.State, &v.RequestFingerprint, &v.ItemID, &v.CreatedAt, &v.Deadline, &v.AnsweredAt, &v.AnswerBotID)
	v.CreatedAt, v.Deadline = v.CreatedAt.UTC(), v.Deadline.UTC()
	v.AnsweredAt = pg.UTCTime(v.AnsweredAt)
	return v, err
}
func (d *DAO) Inquiry(ctx context.Context, owner, task, id string) (model.AssistantTaskInquiry, error) {
	return one(d.tx.QueryRow(ctx, `SELECT `+inquiryColumns+` FROM assistant_task_inquiries WHERE owner_user_id=$1 AND task_id=$2 AND id=$3`, owner, task, id), "read assistant inquiry", scanInquiry)
}
func (d *DAO) Inquiries(ctx context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskInquiry, error) {
	after, id, limit := page(q)
	return many(ctx, d.tx, "list assistant inquiries", `SELECT `+inquiryColumns+` FROM assistant_task_inquiries WHERE owner_user_id=$1 AND ($2::uuid IS NULL OR task_id=$2) AND ($3='' OR state=$3) AND ($4::uuid IS NULL OR from_bot_id=$4) AND ($5::timestamptz IS NULL OR deadline<=$5) AND ($6::timestamptz IS NULL OR (created_at,id)>($6,$7::uuid)) AND ($9::uuid IS NULL OR item_id=$9) ORDER BY created_at,id LIMIT $8`, scanInquiry, q.OwnerUserID, nullableID(q.TaskID), q.State, nullableID(q.InquiryBotID), q.DeadlineBefore, after, id, limit, nullableID(q.ItemID))
}
func inquiryValues(v model.AssistantTaskInquiry) []any {
	return []any{v.ID, v.OwnerUserID, v.TaskID, v.FromBotID, v.ToBotID, v.Question, v.Answer, v.State, v.RequestFingerprint, v.ItemID, v.CreatedAt, v.Deadline, v.AnsweredAt, v.AnswerBotID}
}
func (d *DAO) InsertInquiry(ctx context.Context, v model.AssistantTaskInquiry) (bool, error) {
	return d.changed(ctx, "insert assistant inquiry", `INSERT INTO assistant_task_inquiries(id,owner_user_id,task_id,from_bot_id,to_bot_id,question,answer,state,request_fingerprint,item_id,created_at,deadline,answered_at,answer_bot_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`, inquiryValues(v)...)
}
func (d *DAO) SaveInquiry(ctx context.Context, v model.AssistantTaskInquiry, state string) (bool, error) {
	return d.changed(ctx, "save assistant inquiry", `UPDATE assistant_task_inquiries SET from_bot_id=$4,to_bot_id=$5,question=$6,answer=$7,state=$8,request_fingerprint=$9,item_id=$10,created_at=$11,deadline=$12,answered_at=$13,answer_bot_id=$14 WHERE id=$1 AND owner_user_id=$2 AND task_id=$3 AND state=$15`, append(inquiryValues(v), state)...)
}
