package session

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
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
 s.snapshot->>'sessionId',s.snapshot->>'claimId',
 CASE WHEN jsonb_typeof(s.snapshot->'executionGeneration')='string' THEN s.snapshot->>'executionGeneration' END,
 CASE WHEN jsonb_typeof(s.snapshot->'connectionEpoch')='string' THEN s.snapshot->>'connectionEpoch' END,
 s.snapshot->'identity'->>'projectId',s.snapshot->'identity'->>'taskId',
 s.snapshot->'identity'->>'workerId',s.snapshot->'identity'->>'worktreeId',
 s.snapshot->'identity'->>'agentControlMode',s.snapshot->>'lifecycle',
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
		var fields [14]*string
		state := &store.TaskSessionStateSource{}
		if err := rows.Scan(&source.TaskID, &source.TaskStatus, &worker,
			&fields[0], &fields[1], &fields[2], &fields[3],
			&fields[4], &fields[5], &fields[6], &fields[7],
			&fields[8], &fields[9], &fields[10], &fields[11],
			&fields[12], &fields[13], &state.LastSeen, &state.DrainUntil); err != nil {
			return nil, pg.QueryError("read task session source", err)
		}
		if worker != nil {
			source.Worker, err = taskSessionWorker(*worker)
			if err != nil {
				return nil, err
			}
		}
		if fields[0] != nil {
			if err := decodeTaskSessionState(fields, state); err != nil {
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
	if len(raw) > taskproperties.MaxValueBytes {
		return nil, &limit.Violation{Field: "properties.worker", Actual: int64(len(raw)), Max: taskproperties.MaxValueBytes, Unit: "bytes"}
	}
	normalized, err := taskproperties.NormalizeValue("worker", json.RawMessage(raw))
	if err != nil {
		return nil, err
	}
	if err := taskproperties.AdmitValue("worker", normalized); err != nil {
		return nil, err
	}
	return taskproperties.Worker(model.TaskProperties{"worker": normalized})
}

func decodeTaskSessionState(fields [14]*string, state *store.TaskSessionStateSource) error {
	for i, value := range fields {
		if value == nil {
			return fmt.Errorf("task session state field %d is required", i)
		}
	}
	for _, i := range []int{0, 1, 2, 3, 4, 5, 8, 9, 10, 11} {
		canonical, err := model.CanonicalID(*fields[i])
		if err != nil || canonical != *fields[i] {
			return fmt.Errorf("task session state field %d must be a canonical UUID", i)
		}
	}
	for _, i := range []int{6, 7} {
		value, err := strconv.ParseInt(*fields[i], 10, 64)
		minimum := int64(0)
		if i == 6 {
			minimum = 1
		}
		if err != nil || value < minimum || strconv.FormatInt(value, 10) != *fields[i] {
			return fmt.Errorf("task session state field %d has an invalid fence sequence", i)
		}
	}
	if *fields[12] != string(model.AgentControlModeWeb) && *fields[12] != string(model.AgentControlModeHerdr) {
		return fmt.Errorf("task session state has an invalid agent control mode")
	}
	switch *fields[13] {
	case "active", "draining", "archived":
	default:
		return fmt.Errorf("task session state has an invalid lifecycle")
	}
	state.SessionID, state.ProjectID, state.TaskID, state.ClaimID = *fields[0], *fields[1], *fields[2], *fields[3]
	state.Fence.SessionID, state.Fence.ClaimID = *fields[4], *fields[5]
	state.Fence.ExecutionGeneration, state.Fence.ConnectionEpoch = *fields[6], *fields[7]
	state.Identity.ProjectID, state.Identity.TaskID = *fields[8], *fields[9]
	state.Identity.WorkerID, state.Identity.WorktreeID = *fields[10], *fields[11]
	state.Identity.AgentControlMode, state.Lifecycle = *fields[12], *fields[13]
	return nil
}
