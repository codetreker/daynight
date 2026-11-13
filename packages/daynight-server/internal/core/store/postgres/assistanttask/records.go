package assistanttask

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

const recordColumns = `id::text,owner_user_id::text,task_id::text,author,kind,text,request_fingerprint,item_id::text,author_bot_id::text,refs,created_at`

func scanRecord(row pgx.Row) (model.AssistantTaskRecord, error) {
	var v model.AssistantTaskRecord
	err := row.Scan(&v.ID, &v.OwnerUserID, &v.TaskID, &v.Author, &v.Kind, &v.Text, &v.RequestFingerprint, &v.ItemID, &v.AuthorBotID, &v.Refs, &v.CreatedAt)
	v.CreatedAt = v.CreatedAt.UTC()
	return v, err
}
func (d *DAO) Record(ctx context.Context, owner, task, id string) (model.AssistantTaskRecord, error) {
	return one(d.tx.QueryRow(ctx, `SELECT `+recordColumns+` FROM assistant_task_records WHERE owner_user_id=$1 AND task_id=$2 AND id=$3`, owner, task, id), "read assistant record", scanRecord)
}
func (d *DAO) Records(ctx context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskRecord, error) {
	after, id, limit := page(q)
	return many(ctx, d.tx, "list assistant records", `SELECT `+recordColumns+` FROM assistant_task_records WHERE owner_user_id=$1 AND task_id=$2 AND ($3::uuid IS NULL OR item_id=$3) AND ($4::timestamptz IS NULL OR (created_at,id)>($4,$5::uuid)) ORDER BY created_at,id LIMIT $6`, scanRecord, q.OwnerUserID, q.TaskID, nullableID(q.ItemID), after, id, limit)
}

func (d *DAO) InsertRecord(ctx context.Context, v model.AssistantTaskRecord) (model.AssistantTaskRecord, error) {
	var lastTime *time.Time
	var lastID *string
	if err := d.tx.QueryRow(ctx, `SELECT record_last_created_at,record_last_id::text FROM assistant_tasks WHERE owner_user_id=$1 AND id=$2 FOR UPDATE`, v.OwnerUserID, v.TaskID).Scan(&lastTime, &lastID); err != nil {
		return model.AssistantTaskRecord{}, pg.QueryError("lock assistant record head", err)
	}
	sample := func(ctx context.Context) (time.Time, error) {
		var now time.Time
		err := d.tx.QueryRow(ctx, `SELECT date_trunc('milliseconds',clock_timestamp())`).Scan(&now)
		return now.UTC(), pg.AuthQueryError("sample assistant record clock", err)
	}
	stamp, err := sample(ctx)
	if err != nil {
		return model.AssistantTaskRecord{}, err
	}
	if lastTime != nil {
		if lastID == nil {
			return model.AssistantTaskRecord{}, pg.QueryError("read assistant record head", errors.New("record head identity is missing"))
		}
		if !stamp.After(*lastTime) && !(stamp.Equal(*lastTime) && strings.Compare(v.ID, *lastID) > 0) {
			stamp, err = forwardRecordClock(ctx, model.ThreadPosition{CreatedAt: *lastTime, ID: *lastID}, 100*time.Millisecond, sample, waitRecordClock)
			if err != nil {
				return model.AssistantTaskRecord{}, err
			}
		}
	}
	v.CreatedAt = stamp
	result, err := one(d.tx.QueryRow(ctx, `INSERT INTO assistant_task_records(id,owner_user_id,task_id,author,kind,text,request_fingerprint,item_id,author_bot_id,refs,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING `+recordColumns, v.ID, v.OwnerUserID, v.TaskID, v.Author, v.Kind, v.Text, v.RequestFingerprint, v.ItemID, v.AuthorBotID, v.Refs, v.CreatedAt), "insert assistant record", scanRecord)
	if err != nil {
		return model.AssistantTaskRecord{}, err
	}
	ok, err := d.changed(ctx, "advance assistant record head", `UPDATE assistant_tasks SET record_last_created_at=$3,record_last_id=$4 WHERE owner_user_id=$1 AND id=$2 AND (record_last_created_at IS NULL OR (record_last_created_at,record_last_id)<($3,$4::uuid))`, v.OwnerUserID, v.TaskID, result.CreatedAt, result.ID)
	if err != nil {
		return model.AssistantTaskRecord{}, err
	}
	if !ok {
		return model.AssistantTaskRecord{}, pg.QueryError("advance assistant record head", errors.New("record head did not advance"))
	}
	return result, ctx.Err()
}

// Recovery waits for a later real database millisecond, never head plus a tick.
func forwardRecordClock(ctx context.Context, head model.ThreadPosition, budget time.Duration, sample func(context.Context) (time.Time, error), wait func(context.Context) error) (time.Time, error) {
	clock, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	var observed time.Time
	for {
		if err := ctx.Err(); err != nil {
			return time.Time{}, err
		}
		if err := clock.Err(); err != nil {
			return time.Time{}, &store.ThreadClockError{Head: head, Observed: observed, Cause: err}
		}
		value, err := sample(clock)
		if !value.IsZero() {
			observed = value.UTC()
		}
		if parent := ctx.Err(); parent != nil {
			return time.Time{}, parent
		}
		if clock.Err() != nil {
			return time.Time{}, &store.ThreadClockError{Head: head, Observed: observed, Cause: errors.Join(clock.Err(), err)}
		}
		if err != nil {
			return time.Time{}, err
		}
		if observed.After(head.CreatedAt) {
			return observed, nil
		}
		if err := wait(clock); err != nil {
			if parent := ctx.Err(); parent != nil {
				return time.Time{}, parent
			}
			if clock.Err() != nil {
				return time.Time{}, &store.ThreadClockError{Head: head, Observed: observed, Cause: errors.Join(clock.Err(), err)}
			}
			return time.Time{}, err
		}
	}
}

func waitRecordClock(ctx context.Context) error {
	timer := time.NewTimer(time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
