package session

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type projectRetirementDAO struct {
	tx        pgx.Tx
	projectID string
}

// NewProjectRetirementDAO binds retirement to the caller's deletion transaction.
func NewProjectRetirementDAO(tx pgx.Tx, projectID string) store.ProjectSessionRetirementDAO {
	return &projectRetirementDAO{tx: tx, projectID: projectID}
}

func (d *projectRetirementDAO) LockProjectSessions(ctx context.Context, project, after string, limit int) ([]store.ProjectSessionRetirementFact, error) {
	if project != d.projectID {
		return nil, fmt.Errorf("project retirement scope mismatch")
	}
	rows, err := d.tx.Query(ctx, `SELECT id::text, backend, COALESCE(snapshot->>'lifecycle','') FROM task_sessions WHERE project_id=$1 AND scope='task' AND ($2::text='' OR id>$2::uuid) ORDER BY id LIMIT $3 FOR UPDATE`, project, after, limit)
	if err != nil {
		return nil, pg.QueryError("lock project sessions", err)
	}
	defer rows.Close()
	var facts []store.ProjectSessionRetirementFact
	for rows.Next() {
		var fact store.ProjectSessionRetirementFact
		if err := rows.Scan(&fact.ID, &fact.Backend, &fact.Lifecycle); err != nil {
			return nil, pg.QueryError("read project sessions", err)
		}
		facts = append(facts, fact)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read project sessions", err)
	}
	return facts, nil
}

func (d *projectRetirementDAO) ApplyProjectSessionRetirement(ctx context.Context, plans []store.ProjectSessionRetirementPlan) error {
	raw, err := json.Marshal(plans)
	if err != nil {
		return pg.QueryError("encode project session retirement", err)
	}
	_, err = d.tx.Exec(ctx, `WITH plans AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS p(id uuid, backend text, "snapshotPatch" jsonb, "snapshotRemove" jsonb)) UPDATE task_sessions s SET snapshot=(s.snapshot - ARRAY(SELECT jsonb_array_elements_text(COALESCE(p."snapshotRemove",'[]'::jsonb)))) || p."snapshotPatch", grant_hash=NULL, grant_expires_at=NULL, connection_expires_at=NULL, draining_until=NULL FROM plans p WHERE s.id=p.id AND s.project_id=$2 AND s.scope='task' AND s.backend='web' AND p.backend='web'`, string(raw), d.projectID)
	if err != nil {
		return pg.QueryError("retire project sessions", err)
	}
	_, err = d.tx.Exec(ctx, `WITH plans AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS p(id uuid, backend text, receipts jsonb)), transitions AS (SELECT p.id, t.* FROM plans p CROSS JOIN LATERAL jsonb_to_recordset(p.receipts) AS t(previous text, next text) WHERE p.backend='web') UPDATE session_operations o SET receipt=(o.receipt - 'error') || jsonb_build_object('state',t.next) FROM transitions t WHERE o.session_id=t.id AND o.receipt->>'state'=t.previous AND EXISTS (SELECT 1 FROM task_sessions s WHERE s.id=t.id AND s.project_id=$2 AND s.scope='task' AND s.backend='web')`, string(raw), d.projectID)
	if err != nil {
		return pg.QueryError("retire project session operations", err)
	}
	return nil
}
