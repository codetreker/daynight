package github

import (
	"context"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type signalWriter struct{ tx pgx.Tx }

func NewSignalWriter(tx pgx.Tx) store.GitHubSignalWriter { return &signalWriter{tx: tx} }

type workReader struct{ pool *pgxpool.Pool }

func NewWorkReader(pool *pgxpool.Pool) store.GitHubWorkReader { return &workReader{pool: pool} }

func (r *workReader) DueGitHubProjects(ctx context.Context, appID int64, now time.Time, limit int) ([]string, error) {
	if limit < 1 || limit > 32 {
		return nil, fmt.Errorf("github work limit must be 1..32")
	}
	// Each Project contributes its highest-priority due work; projects are then
	// ordered by work priority, due time, and Project ID, with a bounded result.
	rows, err := r.pool.Query(ctx, `SELECT g.project_id::text FROM project_github g JOIN projects p ON p.id=g.project_id AND p.deleted_at IS NULL
 JOIN LATERAL (SELECT priority,due FROM (
 SELECT 1 AS priority,$2::timestamptz AS due WHERE g.app_id <> $1 OR (g.access_hint_id IS NOT NULL AND g.next_access_check_at IS NULL)
 UNION ALL SELECT 1,g.next_access_check_at WHERE g.next_access_check_at <= $2
 UNION ALL SELECT 2,g.next_poll_at WHERE g.app_id=$1 AND g.access_hint_id IS NULL AND g.access_state='available' AND g.next_poll_at <= $2
 UNION ALL SELECT 3,min(q.next_attempt_at) FROM project_github_pending_prs q WHERE g.app_id=$1 AND g.access_hint_id IS NULL AND g.access_state='available' AND q.project_id=g.project_id AND q.generation=g.generation AND q.next_attempt_at <= $2 HAVING count(*)>0
 ) c ORDER BY priority LIMIT 1) work ON true
 WHERE g.enabled AND (g.access_state<>'unavailable' OR g.access_reason IS DISTINCT FROM 'app_changed')
 AND (g.app_id<>$1 OR g.access_state<>'unavailable' OR g.access_reason IS DISTINCT FROM 'installation_missing')
 AND (g.not_before IS NULL OR g.not_before <= $2) AND (g.claim_until IS NULL OR g.claim_until <= $2)
 ORDER BY work.priority,work.due,g.project_id LIMIT $3`, appID, now, limit)
	if err != nil {
		return nil, pg.QueryError("find due github projects", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, pg.QueryError("find due github projects", err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("find due github projects", err)
	}
	return out, nil
}

// The lock CTE visits matching GitHub rows in a stable order and never takes a
// Project row lock. Rechecking enabled in UPDATE handles deletion/disconnect
// that completed while this transaction waited for a connection row.
func (s *signalWriter) SignalPullRequest(ctx context.Context, p store.GitHubPRSignal) (int64, error) {
	var n int64
	err := s.tx.QueryRow(ctx, `WITH locked AS MATERIALIZED (
 SELECT g.project_id FROM project_github g WHERE g.enabled AND g.app_id=$1 AND g.installation_id=$2 AND g.repository_id=$3
 AND EXISTS (SELECT 1 FROM projects p WHERE p.id=g.project_id AND p.deleted_at IS NULL) ORDER BY g.project_id FOR UPDATE OF g),
 changed AS (UPDATE project_github g SET last_webhook_received_at=GREATEST(g.last_webhook_received_at,$7::timestamptz),revision=g.revision+1,updated_at=clock_timestamp() FROM locked l
 WHERE g.project_id=l.project_id AND g.enabled AND g.app_id=$1 AND g.installation_id=$2 AND g.repository_id=$3 RETURNING g.project_id,g.generation),
 written AS (INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at)
 SELECT project_id,$4,generation,$5,$6,$7,$8 FROM changed
 ON CONFLICT(project_id,number) DO UPDATE SET generation=EXCLUDED.generation,request_id=EXCLUDED.request_id,delivery_id=EXCLUDED.delivery_id,received_at=EXCLUDED.received_at,next_attempt_at=EXCLUDED.next_attempt_at RETURNING 1)
 SELECT count(*) FROM written`, p.AppID, p.InstallationID, p.RepositoryID, p.Number, p.RequestID, p.DeliveryID, p.ReceivedAt, p.NextAttemptAt).Scan(&n)
	if err != nil {
		return 0, pg.QueryError("record github pull request signal", err)
	}
	return n, nil
}
func (s *signalWriter) SignalAccess(ctx context.Context, p store.GitHubAccessSignal) (int64, error) {
	tag, err := s.tx.Exec(ctx, `WITH locked AS MATERIALIZED (
 SELECT g.project_id FROM project_github g WHERE g.enabled AND g.app_id=$1 AND g.installation_id=$2
 AND EXISTS (SELECT 1 FROM projects p WHERE p.id=g.project_id AND p.deleted_at IS NULL) ORDER BY g.project_id FOR UPDATE OF g)
 UPDATE project_github g SET access_hint_id=$3,access_delivery_id=$4,next_access_check_at=$5,last_webhook_received_at=GREATEST(g.last_webhook_received_at,$5::timestamptz),claim_token=NULL,claim_kind=NULL,claim_until=NULL,revision=g.revision+1,updated_at=clock_timestamp()
 FROM locked l WHERE g.project_id=l.project_id AND g.enabled AND g.app_id=$1 AND g.installation_id=$2`, p.AppID, p.InstallationID, p.HintID, p.DeliveryID, p.ReceivedAt)
	if err != nil {
		return 0, pg.QueryError("record github access signal", err)
	}
	return tag.RowsAffected(), nil
}
