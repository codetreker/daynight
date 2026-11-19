package session

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type retentionDAO struct {
	tx      pgx.Tx
	project string
}

// NewArchiveRetention binds the DAO to a transaction already holding the
// Project's shared or exclusive row lock, before any Task or Session locks.
func NewArchiveRetention(tx pgx.Tx, project string) store.ArchiveRetentionDAO {
	return &retentionDAO{tx: tx, project: project}
}

var _ store.SessionArchiveRetentionDAO = (*DAO)(nil)

// The original publication transaction owns both the ready receipt and this
// insertion. An existing row may deliberately have an unknown historical time.
func (tx *DAO) RecordSessionArchiveSuccess(ctx context.Context, id string, at time.Time) error {
	_, err := tx.tx.Exec(ctx, `INSERT INTO session_archive_retention(session_id,first_succeeded_at)
 SELECT s.id,$2 FROM task_sessions s JOIN tasks t ON t.id=s.task_id AND t.project_id=s.project_id
 JOIN session_archives a ON a.session_id=s.id
 WHERE s.id=$1 AND s.scope='task' AND s.backend='web' AND s.bot_id IS NULL AND t.type='task' AND a.state='ready'
 ON CONFLICT(session_id) DO NOTHING`, id, at)
	if err != nil {
		return pg.QueryError("record first session archive success", err)
	}
	return nil
}

const retentionProjection = `session_id::text,first_succeeded_at,grace_until,expires_at,expired_at,reason,version,members`

func scanRetention(row pgx.Row) (store.ArchiveRetention, error) {
	var value store.ArchiveRetention
	var members []byte
	if err := row.Scan(&value.SessionID, &value.FirstSucceededAt, &value.GraceUntil, &value.ExpiresAt, &value.ExpiredAt, &value.Reason, &value.Version, &members); err != nil {
		return value, pg.QueryError("read archive retention", err)
	}
	if err := json.Unmarshal(members, &value.Members); err != nil {
		return value, pg.QueryError("decode archive retention members", err)
	}
	return value, nil
}

func (d *retentionDAO) ArchiveRetentionFacts(ctx context.Context, project, task, id string) (store.ArchiveRetentionFacts, error) {
	var facts store.ArchiveRetentionFacts
	if project != d.project {
		return facts, model.ErrNotFound
	}
	var locked string
	err := d.tx.QueryRow(ctx, `SELECT s.id::text FROM task_sessions s
 JOIN task_resource_rows t ON t.id=s.task_id AND t.project_id=s.project_id
 WHERE s.id=$1 AND s.project_id=$2 AND s.task_id=$3 AND s.scope='task'
 AND s.backend='web' AND s.bot_id IS NULL AND t.type='task' AND t.effective_deleted_at IS NULL
 FOR UPDATE OF s`, id, project, task).Scan(&locked)
	if err != nil {
		return facts, pg.QueryError("lock archive retention session", err)
	}
	if err := d.tx.QueryRow(ctx, `SELECT state FROM session_archives WHERE session_id=$1 FOR UPDATE`, id).Scan(&facts.State); err != nil {
		return facts, pg.QueryError("read archive retention state", err)
	}
	facts.Archive, err = scanRetention(d.tx.QueryRow(ctx, `SELECT `+retentionProjection+` FROM session_archive_retention WHERE session_id=$1 FOR UPDATE`, id))
	if err != nil {
		return facts, err
	}
	rows, err := d.tx.Query(ctx, `WITH RECURSIVE chain(id) AS (
 SELECT id FROM task_resource_rows WHERE project_id=$1 AND id=$2 AND type='task' AND effective_deleted_at IS NULL
 UNION
 SELECT neighbor.id FROM chain member CROSS JOIN LATERAL (
 SELECT depends_on_task_id AS id FROM task_dependencies WHERE project_id=$1 AND task_id=member.id AND dependency_type='task' AND NOT external
 UNION
 SELECT task_id AS id FROM task_dependencies WHERE project_id=$1 AND depends_on_task_id=member.id AND dependency_type='task' AND NOT external
 ) neighbor JOIN task_resource_rows t ON t.id=neighbor.id AND t.project_id=$1 AND t.type='task' AND t.effective_deleted_at IS NULL
 ) SELECT t.id::text,t.version,t.status,t.completed_at,t.cancelled_at
 FROM chain JOIN task_resource_rows t ON t.id=chain.id AND t.project_id=$1 ORDER BY t.id`, project, task)
	if err != nil {
		return facts, pg.QueryError("read archive retention chain", err)
	}
	defer rows.Close()
	facts.Members = []store.ArchiveRetentionMember{}
	for rows.Next() {
		var m store.ArchiveRetentionMember
		if err := rows.Scan(&m.TaskID, &m.Version, &m.Status, &m.CompletedAt, &m.CancelledAt); err != nil {
			return facts, pg.QueryError("scan archive retention chain", err)
		}
		facts.Members = append(facts.Members, m)
	}
	if err := rows.Err(); err != nil {
		return facts, pg.QueryError("read archive retention chain", err)
	}
	return facts, nil
}

func (d *retentionDAO) SaveArchiveRetention(ctx context.Context, expected int64, value store.ArchiveRetention) (store.ArchiveRetention, error) {
	members, err := json.Marshal(value.Members)
	if err != nil {
		return store.ArchiveRetention{}, pg.QueryError("encode archive retention members", err)
	}
	result, err := scanRetention(d.tx.QueryRow(ctx, `UPDATE session_archive_retention r
 SET expires_at=$3,expired_at=$4,reason=$5,members=$6,version=version+1
 WHERE session_id=$1 AND version=$2 AND expired_at IS NULL
 AND EXISTS(SELECT 1 FROM task_sessions s WHERE s.id=r.session_id AND s.project_id=$7)
 RETURNING `+retentionProjection, value.SessionID, expected, value.ExpiresAt, value.ExpiredAt, value.Reason, members, d.project))
	if errors.Is(err, model.ErrNotFound) || errors.Is(err, pgx.ErrNoRows) {
		return store.ArchiveRetention{}, &model.Fault{Code: "version_conflict", Message: "Archive retention changed."}
	}
	return result, err
}
