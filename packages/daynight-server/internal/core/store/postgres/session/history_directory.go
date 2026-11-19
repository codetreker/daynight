package session

import (
	"context"
	"fmt"
	"math/big"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type historyDirectory struct{ tx pgx.Tx }

func NewHistoryDirectory(tx pgx.Tx) store.HistoryDirectoryDAO { return &historyDirectory{tx: tx} }

// Rooting the same undirected ordinary graph at each visible member gives each
// component one stable minimum identity, independent of edge direction.
const historyComponents = `WITH RECURSIVE live AS (
 SELECT * FROM task_resource_rows WHERE project_id=$1 AND type='task' AND effective_deleted_at IS NULL
), edges AS MATERIALIZED (
 SELECT d.task_id AS source,d.depends_on_task_id AS target FROM task_dependencies d JOIN live a ON a.id=d.task_id JOIN live b ON b.id=d.depends_on_task_id WHERE d.project_id=$1 AND d.dependency_type='task' AND NOT d.external
 UNION ALL
 SELECT d.depends_on_task_id,d.task_id FROM task_dependencies d JOIN live a ON a.id=d.task_id JOIN live b ON b.id=d.depends_on_task_id WHERE d.project_id=$1 AND d.dependency_type='task' AND NOT d.external
), reach(root,id) AS (
 SELECT id,id FROM live
 UNION
 SELECT reach.root,edges.target FROM reach JOIN edges ON edges.source=reach.id
), membership AS (SELECT id,min(root::text) AS group_id FROM reach GROUP BY id) `

const historyChain = `WITH RECURSIVE live AS (
 SELECT * FROM task_resource_rows WHERE project_id=$1 AND type='task' AND effective_deleted_at IS NULL
), edges AS MATERIALIZED (
 SELECT d.task_id AS source,d.depends_on_task_id AS target FROM task_dependencies d JOIN live a ON a.id=d.task_id JOIN live b ON b.id=d.depends_on_task_id WHERE d.project_id=$1 AND d.dependency_type='task' AND NOT d.external
 UNION ALL
 SELECT d.depends_on_task_id,d.task_id FROM task_dependencies d JOIN live a ON a.id=d.task_id JOIN live b ON b.id=d.depends_on_task_id WHERE d.project_id=$1 AND d.dependency_type='task' AND NOT d.external
), chain(id) AS (
 SELECT id FROM live WHERE id=$2::uuid
 UNION
 SELECT edges.target FROM chain JOIN edges ON edges.source=chain.id
) `

func directoryLimit(limit int) error {
	if limit < 1 || limit > 201 {
		return fmt.Errorf("invalid history directory limit")
	}
	return nil
}

func (d *historyDirectory) Fence(ctx context.Context, project string) (string, error) {
	var value string
	err := d.tx.QueryRow(ctx, `SELECT md5(jsonb_build_array(
 (SELECT jsonb_build_array(count(*)::text,COALESCE(sum(version::numeric),0)::text) FROM tasks WHERE project_id=$1),
 COALESCE((SELECT jsonb_agg(jsonb_build_array(s.id,s.task_id,s.claim_id,s.backend,s.created_at,s.snapshot->>'executionGeneration',s.terminal_state->'Envelope'->>'executionGeneration',s.terminal_state->'Runs'->-1->>'stoppedAt',a.state,a.sha256,a.byte_length,a.completeness,COALESCE(a.receipt->>'reason',a.error_code),r.first_succeeded_at,r.grace_until,r.expired_at) ORDER BY s.id)
 FROM task_sessions s JOIN task_resource_rows t ON t.id=s.task_id AND t.project_id=s.project_id
 LEFT JOIN session_archives a ON a.session_id=s.id LEFT JOIN session_archive_retention r ON r.session_id=s.id
 WHERE s.project_id=$1 AND s.scope='task' AND t.type='task' AND t.effective_deleted_at IS NULL),'[]'::jsonb))::text)`, project).Scan(&value)
	if err != nil {
		return "", pg.QueryError("read history directory fence", err)
	}
	version, ok := new(big.Int).SetString(value, 16)
	if !ok {
		return "", fmt.Errorf("invalid history directory fence digest")
	}
	return version.String(), nil
}

func (d *historyDirectory) Groups(ctx context.Context, project string, after *store.HistoryGroupPosition, limit int) ([]store.HistoryDirectoryGroup, error) {
	if err := directoryLimit(limit); err != nil {
		return nil, err
	}
	var afterID, afterTime any
	if after != nil {
		afterID, afterTime = after.ID, after.EndedAt
	}
	rows, err := d.tx.Query(ctx, historyComponents+`, grouped AS (
 SELECT m.group_id,count(*) AS member_count,
 CASE WHEN bool_and(t.status IN ('done','cancelled')) AND bool_and(CASE WHEN t.status='done' THEN t.completed_at WHEN t.status='cancelled' THEN t.cancelled_at END IS NOT NULL)
 THEN max(CASE WHEN t.status='done' THEN t.completed_at WHEN t.status='cancelled' THEN t.cancelled_at END) END AS ended_at,
 CASE WHEN NOT bool_and(t.status IN ('done','cancelled')) THEN 'unfinished'
 WHEN NOT bool_and(CASE WHEN t.status='done' THEN t.completed_at WHEN t.status='cancelled' THEN t.cancelled_at END IS NOT NULL) THEN 'unknown' ELSE 'ended' END AS time_state
 FROM membership m JOIN live t ON t.id=m.id GROUP BY m.group_id
 ) SELECT group_id,member_count,ended_at,time_state FROM grouped
 WHERE $2::text IS NULL OR ($3::timestamptz IS NOT NULL AND (ended_at<$3 OR ended_at IS NULL OR (ended_at=$3 AND group_id>$2))) OR ($3::timestamptz IS NULL AND ended_at IS NULL AND group_id>$2)
 ORDER BY ended_at DESC NULLS LAST,group_id LIMIT $4`, project, afterID, afterTime, limit)
	if err != nil {
		return nil, pg.QueryError("read history directory groups", err)
	}
	defer rows.Close()
	result := []store.HistoryDirectoryGroup{}
	for rows.Next() {
		var v store.HistoryDirectoryGroup
		if err := rows.Scan(&v.ID, &v.MemberCount, &v.EndedAt, &v.TimeState); err != nil {
			return nil, pg.QueryError("scan history directory group", err)
		}
		result = append(result, v)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read history directory groups", err)
	}
	return result, nil
}

func (d *historyDirectory) Members(ctx context.Context, project, group, after string, limit int) ([]store.HistoryDirectoryMember, error) {
	if err := directoryLimit(limit); err != nil {
		return nil, err
	}
	rows, err := d.tx.Query(ctx, historyChain+`SELECT t.id::text,t.version,t.status,t.completed_at,t.cancelled_at,t.title FROM chain JOIN live t ON t.id=chain.id WHERE (SELECT min(id::text) FROM chain)=$2::text AND ($3='' OR t.id::text>$3) ORDER BY t.id LIMIT $4`, project, group, after, limit)
	if err != nil {
		return nil, pg.QueryError("read history directory members", err)
	}
	defer rows.Close()
	result := []store.HistoryDirectoryMember{}
	for rows.Next() {
		var v store.HistoryDirectoryMember
		if err := rows.Scan(&v.TaskID, &v.Version, &v.Status, &v.CompletedAt, &v.CancelledAt, &v.Title); err != nil {
			return nil, pg.QueryError("scan history directory member", err)
		}
		result = append(result, v)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read history directory members", err)
	}
	return result, nil
}

func (d *historyDirectory) RetentionMembers(ctx context.Context, project, task string) ([]store.ArchiveRetentionMember, error) {
	rows, err := d.tx.Query(ctx, historyChain+`SELECT t.id::text,t.version,t.status,t.completed_at,t.cancelled_at FROM chain JOIN live t ON t.id=chain.id ORDER BY t.id`, project, task)
	if err != nil {
		return nil, pg.QueryError("read history retention members", err)
	}
	defer rows.Close()
	result := []store.ArchiveRetentionMember{}
	for rows.Next() {
		var v store.ArchiveRetentionMember
		if err := rows.Scan(&v.TaskID, &v.Version, &v.Status, &v.CompletedAt, &v.CancelledAt); err != nil {
			return nil, pg.QueryError("scan history retention member", err)
		}
		result = append(result, v)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read history retention members", err)
	}
	return result, nil
}

func (d *historyDirectory) Sessions(ctx context.Context, project, task string, after *store.Position, limit int) ([]store.HistoryDirectorySession, error) {
	if err := directoryLimit(limit); err != nil {
		return nil, err
	}
	var afterID, afterTime any
	if after != nil {
		afterID, afterTime = after.ID, after.CreatedAt
	}
	rows, err := d.tx.Query(ctx, `SELECT s.id::text,s.claim_id::text,s.backend,s.created_at,
 COALESCE(CASE WHEN s.backend='herdr' THEN s.terminal_state->'Envelope'->>'executionGeneration' ELSE s.snapshot->>'executionGeneration' END,''),
 CASE WHEN s.backend='herdr' THEN s.terminal_state->'Runs'->-1->>'stoppedAt' END,
 a.state,a.sha256,a.byte_length::text,a.completeness,COALESCE(a.receipt->>'reason',a.error_code),r.session_id::text,r.first_succeeded_at,r.grace_until,r.expires_at,r.expired_at,COALESCE(r.reason,''),COALESCE(r.version,0)
 FROM task_sessions s JOIN task_resource_rows t ON t.id=s.task_id AND t.project_id=s.project_id
 LEFT JOIN session_archives a ON a.session_id=s.id LEFT JOIN session_archive_retention r ON r.session_id=s.id
 WHERE s.project_id=$1 AND s.task_id=$2 AND s.scope='task' AND t.type='task' AND t.effective_deleted_at IS NULL
 AND ($3::timestamptz IS NULL OR (s.created_at,s.id)<($3,$4::uuid)) ORDER BY s.created_at DESC,s.id DESC LIMIT $5`, project, task, afterTime, afterID, limit)
	if err != nil {
		return nil, pg.QueryError("read history directory sessions", err)
	}
	defer rows.Close()
	result := []store.HistoryDirectorySession{}
	for rows.Next() {
		var v store.HistoryDirectorySession
		var r store.ArchiveRetention
		var id *string
		if err := rows.Scan(&v.ID, &v.Claim, &v.Backend, &v.Created, &v.ExecutionGeneration, &v.EndedAt, &v.State, &v.Hash, &v.Size, &v.Completeness, &v.ArchiveReason, &id, &r.FirstSucceededAt, &r.GraceUntil, &r.ExpiresAt, &r.ExpiredAt, &r.Reason, &r.Version); err != nil {
			return nil, pg.QueryError("scan history directory session", err)
		}
		if id != nil {
			r.SessionID = *id
			v.Retention = &r
		}
		result = append(result, v)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read history directory sessions", err)
	}
	return result, nil
}
