package session

import (
	"context"
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type Reader struct{ tx pgx.Tx }

func NewReader(tx pgx.Tx) store.SessionReader { return &Reader{tx: tx} }

var _ store.SessionReader = (*Reader)(nil)

func (r *Reader) CurrentTaskSessionSources(ctx context.Context, projectID string) ([]store.TaskSessionSource, error) {
	rows, err := r.tx.Query(ctx, `SELECT t.id::text,t.status,w.value,
 s.id::text,s.project_id::text,s.task_id::text,s.claim_id::text,
 jsonb_build_object('sessionId',s.snapshot->'sessionId','claimId',s.snapshot->'claimId',
 'executionGeneration',s.snapshot->'executionGeneration','connectionEpoch',s.snapshot->'connectionEpoch',
 'identity',s.snapshot->'identity','lifecycle',s.snapshot->'lifecycle'),
 s.last_seen,s.draining_until
 FROM tasks t
 LEFT JOIN task_properties w ON w.task_id=t.id AND w.name='worker'
 LEFT JOIN task_sessions s ON s.project_id=t.project_id AND s.task_id=t.id
  AND s.claim_id=((w.value::jsonb)->>'claimId')::uuid
  AND s.scope='task' AND s.backend='web'
 WHERE t.project_id=$1 AND t.deleted_at IS NULL AND t.status='in_progress'
 ORDER BY t.id`, projectID)
	if err != nil {
		return nil, pg.QueryError("read task session sources", err)
	}
	defer rows.Close()
	result := make([]store.TaskSessionSource, 0)
	for rows.Next() {
		var source store.TaskSessionSource
		var worker *string
		var fields [4]*string
		var snapshot []byte
		state := &store.TaskSessionStateSource{}
		if err := rows.Scan(&source.TaskID, &source.TaskStatus, &worker,
			&fields[0], &fields[1], &fields[2], &fields[3],
			&snapshot, &state.LastSeen, &state.DrainUntil); err != nil {
			return nil, pg.QueryError("read task session source", err)
		}
		if worker != nil {
			source.Worker, err = taskSessionWorker(*worker)
			if err != nil {
				return nil, err
			}
		}
		if fields[0] != nil {
			state.SessionID, state.ProjectID, state.TaskID, state.ClaimID = *fields[0], *fields[1], *fields[2], *fields[3]
			if err := decodeTaskSessionState(snapshot, state); err != nil {
				return nil, pg.QueryError("decode task session state", err)
			}
			source.Session = state
		}
		result = append(result, source)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read task session sources", err)
	}
	return result, nil
}

func taskSessionWorker(raw string) (*model.WorkerClaim, error) {
	return taskproperties.Worker(model.TaskProperties{"worker": json.RawMessage(raw)})
}

func decodeTaskSessionState(raw []byte, state *store.TaskSessionStateSource) error {
	var snapshot struct {
		sp.ControllerFence
		Identity  sp.Identity `json:"identity"`
		Lifecycle string      `json:"lifecycle"`
	}
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return err
	}
	state.Fence, state.Identity, state.Lifecycle = snapshot.ControllerFence, snapshot.Identity, snapshot.Lifecycle
	return nil
}
