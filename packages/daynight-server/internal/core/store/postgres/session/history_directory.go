package session

import (
	"context"
	"fmt"
	"math/big"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/graph"
	"github.com/jackc/pgx/v5"
)

type historyDirectory struct{ tx pgx.Tx }

func NewHistoryDirectory(tx pgx.Tx) store.HistoryDirectoryDAO { return &historyDirectory{tx: tx} }

// Each expansion probes both dependency indexes and validates the reached task.
// UNION deduplicates vertices even when the graph contains multiple paths.
const historyChain = `WITH RECURSIVE chain(id) AS (
 SELECT id FROM task_resource_rows WHERE project_id=$1 AND id=$2::uuid AND type='task' AND effective_deleted_at IS NULL
 UNION
 SELECT neighbor.id FROM chain
 CROSS JOIN LATERAL (
  SELECT d.depends_on_task_id AS id FROM task_dependencies d WHERE d.project_id=$1 AND d.task_id=chain.id AND d.dependency_type='task' AND NOT d.external
  UNION ALL
  SELECT d.task_id AS id FROM task_dependencies d WHERE d.project_id=$1 AND d.depends_on_task_id=chain.id AND d.dependency_type='task' AND NOT d.external
 ) neighbor
 JOIN task_resource_rows t ON t.project_id=$1 AND t.id=neighbor.id AND t.type='task' AND t.effective_deleted_at IS NULL
) `

// membership reads narrow graph facts in the caller's snapshot. Edges are
// consumed once; only vertices and their disjoint-set state remain in memory.
func (d *historyDirectory) membership(ctx context.Context, project string) ([]string, []string, error) {
	rows, err := d.tx.Query(ctx, `SELECT id::text FROM task_resource_rows WHERE project_id=$1 AND type='task' AND effective_deleted_at IS NULL`, project)
	if err != nil {
		return nil, nil, pg.QueryError("read history directory vertices", err)
	}
	ids := []string{}
	index := map[string]int{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, nil, pg.QueryError("scan history directory vertex", err)
		}
		index[id] = len(ids)
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, pg.QueryError("read history directory vertices", err)
	}
	sets := graph.NewDisjointSets(len(ids))
	rows, err = d.tx.Query(ctx, `SELECT d.task_id::text,d.depends_on_task_id::text
 FROM task_dependencies d
 JOIN task_resource_rows a ON a.project_id=d.project_id AND a.id=d.task_id AND a.type='task' AND a.effective_deleted_at IS NULL
 JOIN task_resource_rows b ON b.project_id=d.project_id AND b.id=d.depends_on_task_id AND b.type='task' AND b.effective_deleted_at IS NULL
 WHERE d.project_id=$1 AND d.dependency_type='task' AND NOT d.external`, project)
	if err != nil {
		return nil, nil, pg.QueryError("read history directory edges", err)
	}
	for rows.Next() {
		var a, b string
		if err := rows.Scan(&a, &b); err != nil {
			rows.Close()
			return nil, nil, pg.QueryError("scan history directory edge", err)
		}
		ai, aok := index[a]
		bi, bok := index[b]
		if !aok || !bok {
			rows.Close()
			return nil, nil, fmt.Errorf("history directory edge references missing vertex")
		}
		sets.Union(ai, bi)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, pg.QueryError("read history directory edges", err)
	}
	minima := make(map[int]string, len(ids))
	for i, id := range ids {
		if i%256 == 0 && ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		root := sets.Find(i)
		if old, ok := minima[root]; !ok || id < old {
			minima[root] = id
		}
	}
	groups := make([]string, len(ids))
	for i := range ids {
		if i%256 == 0 && ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		groups[i] = minima[sets.Find(i)]
	}
	return ids, groups, nil
}

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
	ids, groupIDs, err := d.membership(ctx, project)
	if err != nil {
		return nil, err
	}
	rows, err := d.tx.Query(ctx, `WITH membership AS (SELECT id,group_id::text FROM unnest($5::uuid[],$6::uuid[]) AS m(id,group_id)), grouped AS (
 SELECT m.group_id,count(*) AS member_count,
 CASE WHEN bool_and(t.status IN ('done','cancelled')) AND bool_and(CASE WHEN t.status='done' THEN t.completed_at WHEN t.status='cancelled' THEN t.cancelled_at END IS NOT NULL)
 THEN max(CASE WHEN t.status='done' THEN t.completed_at WHEN t.status='cancelled' THEN t.cancelled_at END) END AS ended_at,
 CASE WHEN NOT bool_and(t.status IN ('done','cancelled')) THEN 'unfinished'
 WHEN NOT bool_and(CASE WHEN t.status='done' THEN t.completed_at WHEN t.status='cancelled' THEN t.cancelled_at END IS NOT NULL) THEN 'unknown' ELSE 'ended' END AS time_state
 FROM membership m JOIN task_resource_rows t ON t.project_id=$1 AND t.id=m.id GROUP BY m.group_id
 ) SELECT group_id,member_count,ended_at,time_state FROM grouped
 WHERE $2::text IS NULL OR ($3::timestamptz IS NOT NULL AND (ended_at<$3 OR ended_at IS NULL OR (ended_at=$3 AND group_id>$2))) OR ($3::timestamptz IS NULL AND ended_at IS NULL AND group_id>$2)
 ORDER BY ended_at DESC NULLS LAST,group_id LIMIT $4`, project, afterID, afterTime, limit, ids, groupIDs)
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
	rows, err := d.tx.Query(ctx, historyChain+`SELECT t.id::text,t.version,t.status,t.completed_at,t.cancelled_at,t.title FROM chain JOIN task_resource_rows t ON t.project_id=$1 AND t.id=chain.id WHERE (SELECT min(id::text) FROM chain)=$2::text AND ($3='' OR t.id::text>$3) ORDER BY t.id LIMIT $4`, project, group, after, limit)
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
	rows, err := d.tx.Query(ctx, historyChain+`SELECT t.id::text,t.version,t.status,t.completed_at,t.cancelled_at FROM chain JOIN task_resource_rows t ON t.project_id=$1 AND t.id=chain.id ORDER BY t.id`, project, task)
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
