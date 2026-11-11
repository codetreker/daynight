package session

import (
	"context"
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

// The projection excludes Controller catalogs, history, terminal frames and
// operation bodies. Row identity remains independent of the stored protocol identity.
const taskObservationColumns = `t.project_id::text,t.id::text,t.version,t.status,w.value,
 s.id::text,s.project_id::text,s.task_id::text,s.claim_id::text,s.owner_user_id::text,s.backend,
 CASE s.backend WHEN 'web' THEN jsonb_build_object(
 'sessionId',s.snapshot->'sessionId','claimId',s.snapshot->'claimId',
 'executionGeneration',s.snapshot->'executionGeneration','connectionEpoch',s.snapshot->'connectionEpoch',
 'identity',s.snapshot->'identity','lifecycle',s.snapshot->'lifecycle','initialInputState',s.snapshot->'initialInputState')
 WHEN 'herdr' THEN jsonb_build_object(
 'sessionId',s.terminal_state->'Envelope'->'sessionId','claimId',s.terminal_state->'Envelope'->'claimId',
 'executionGeneration',s.terminal_state->'Envelope'->'executionGeneration','connectionEpoch',s.terminal_state->'ConnectionEpoch',
 'identity',jsonb_build_object('projectId',s.terminal_state->'Owner'->'projectId','taskId',s.terminal_state->'Owner'->'taskId',
 'workerId',s.terminal_state->'Owner'->'workerId','worktreeId',s.terminal_state->'Owner'->'worktreeId',
 'provider',s.terminal_state->'Owner'->'provider','nativeSessionId',s.terminal_state->'Binding'->'nativeSessionId','agentControlMode','herdr'),
 'terminalFinalizationId',s.terminal_state->'FinalizationID') END,
 s.last_seen,s.draining_until,s.connection_expires_at,s.server_instance::text,a.state`

func (r *Reader) TaskSessionSources(ctx context.Context, projectID string, taskIDs []string) ([]store.TaskSessionSource, error) {
	if len(taskIDs) > 200 {
		return nil, &model.Fault{Code: "invalid_input", Message: "A Session observation batch supports at most 200 Tasks."}
	}
	if len(taskIDs) == 0 {
		return []store.TaskSessionSource{}, nil
	}
	return r.taskObservationSources(ctx, `SELECT `+taskObservationColumns+`
 FROM task_resource_rows t JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL
 LEFT JOIN task_properties w ON w.task_id=t.id AND t.type='task' AND w.name='worker'
 LEFT JOIN task_sessions s ON s.project_id=t.project_id AND s.task_id=t.id AND t.type='task' AND s.scope='task'
 AND s.claim_id=((w.value::jsonb)->>'claimId')::uuid
 LEFT JOIN session_archives a ON a.session_id=s.id
 WHERE t.project_id=$1 AND t.id=ANY($2::uuid[]) AND t.effective_deleted_at IS NULL ORDER BY t.id`, projectID, taskIDs)
}

func (r *Reader) TaskSessionInspectionSource(ctx context.Context, projectID, taskID, sessionID string) (store.TaskSessionSource, error) {
	sources, err := r.taskObservationSources(ctx, `SELECT `+taskObservationColumns+`
 FROM task_resource_rows t JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL
 LEFT JOIN task_properties w ON w.task_id=t.id AND t.type='task' AND w.name='worker'
 JOIN task_sessions s ON s.project_id=t.project_id AND s.task_id=t.id AND t.type='task' AND s.scope='task' AND s.id=$3
 LEFT JOIN session_archives a ON a.session_id=s.id
 WHERE t.project_id=$1 AND t.id=$2 AND t.effective_deleted_at IS NULL`, projectID, taskID, sessionID)
	if err != nil {
		return store.TaskSessionSource{}, err
	}
	if len(sources) == 0 {
		return store.TaskSessionSource{}, model.ErrNotFound
	}
	return sources[0], nil
}

func (r *Reader) taskObservationSources(ctx context.Context, query string, args ...any) ([]store.TaskSessionSource, error) {
	rows, err := r.tx.Query(ctx, query, args...)
	if err != nil {
		return nil, pg.QueryError("read task observations", err)
	}
	defer rows.Close()
	out := make([]store.TaskSessionSource, 0)
	for rows.Next() {
		var source store.TaskSessionSource
		var worker *string
		var fields [6]*string
		var metadata []byte
		var instance, archive *string
		state := &store.TaskSessionStateSource{}
		if err := rows.Scan(&source.ProjectID, &source.TaskID, &source.TaskVersion, &source.TaskStatus, &worker, &fields[0], &fields[1], &fields[2], &fields[3], &fields[4], &fields[5], &metadata, &state.LastSeen, &state.DrainUntil, &state.ConnectionExpiry, &instance, &archive); err != nil {
			return nil, pg.QueryError("read task observation", err)
		}
		if worker != nil {
			source.Worker, err = taskSessionWorker(*worker)
			if err != nil {
				return nil, pg.QueryError("decode task observation worker", err)
			}
		}
		if fields[0] != nil {
			state.SessionID, state.ProjectID, state.TaskID, state.ClaimID, state.OwnerID, state.Backend = *fields[0], *fields[1], *fields[2], *fields[3], *fields[4], *fields[5]
			var snapshot struct {
				sp.ControllerFence
				Identity               sp.Identity `json:"identity"`
				Lifecycle              string      `json:"lifecycle"`
				InitialInputState      string      `json:"initialInputState"`
				TerminalFinalizationID *string     `json:"terminalFinalizationId"`
			}
			if err := json.Unmarshal(metadata, &snapshot); err != nil {
				return nil, pg.QueryError("decode task observation", err)
			}
			state.Fence, state.Identity, state.Lifecycle, state.InitialInputState, state.TerminalFinalizationID = snapshot.ControllerFence, snapshot.Identity, snapshot.Lifecycle, snapshot.InitialInputState, snapshot.TerminalFinalizationID
			if instance != nil {
				state.ServerInstance = *instance
			}
			state.ArchiveState = "unavailable"
			if archive != nil {
				state.ArchiveState = *archive
			}
			source.Session = state
		}
		out = append(out, source)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read task observations", err)
	}
	return out, nil
}
