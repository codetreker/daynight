package github

import (
	"context"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5/pgxpool"
)

type appWorkReader struct{ pool *pgxpool.Pool }

func NewAppWorkReader(pool *pgxpool.Pool) store.GitHubAppWorkReader {
	return &appWorkReader{pool: pool}
}

func (r *appWorkReader) DueGitHubAppProjects(ctx context.Context, now time.Time, limit int) ([]string, error) {
	if limit < 1 || limit > 32 {
		return nil, fmt.Errorf("github App work limit must be 1..32")
	}
	rows, err := r.pool.Query(ctx, `SELECT g.project_id::text `+appWorkJoins+`
 JOIN LATERAL (SELECT priority,due FROM (
 SELECT 1 AS priority,$1::timestamptz AS due WHERE g.access_hint_id IS NOT NULL AND g.next_access_check_at IS NULL
 UNION ALL SELECT 1,g.next_access_check_at WHERE g.next_access_check_at <= $1
 UNION ALL SELECT 2,g.next_poll_at WHERE g.access_hint_id IS NULL AND g.access_state='available' AND g.next_poll_at <= $1
 UNION ALL SELECT 3,min(q.next_attempt_at) FROM project_github_pending_prs q WHERE g.access_hint_id IS NULL AND g.access_state='available' AND q.project_id=g.project_id AND q.generation=g.generation AND q.next_attempt_at <= $1 HAVING count(*)>0
 ) c ORDER BY priority LIMIT 1) work ON true
 WHERE `+appWorkAuthorization+`
 AND (g.access_state<>'unavailable' OR g.access_reason IS DISTINCT FROM 'installation_missing')
 AND (g.not_before IS NULL OR g.not_before <= $1) AND (g.claim_until IS NULL OR g.claim_until <= $1)
 ORDER BY work.priority,work.due,g.project_id LIMIT $2`, now, limit)
	if err != nil {
		return nil, pg.QueryError("find due github App projects", err)
	}
	defer rows.Close()
	projects := []string{}
	for rows.Next() {
		var project string
		if err := rows.Scan(&project); err != nil {
			return nil, pg.QueryError("read due github App project", err)
		}
		projects = append(projects, project)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read due github App projects", err)
	}
	return projects, nil
}
