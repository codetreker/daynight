package session

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

// ProjectDAO binds project-scoped Session changes to the caller's transaction.
type ProjectDAO struct {
	tx        pgx.Tx
	projectID string
}

func NewProjectDAO(tx pgx.Tx, projectID string) store.ProjectSessionDAO {
	return &ProjectDAO{tx: tx, projectID: projectID}
}

var _ store.ProjectSessionDAO = (*ProjectDAO)(nil)

// MatchSessionStartup locks after the task, sharing the relay's task/session order.
// A generation grant does not change task.version and therefore needs this fence.
func (tx *ProjectDAO) MatchSessionStartup(ctx context.Context, taskID string, worker *model.WorkerClaim, report sp.StartupReport) (bool, error) {
	var owner string
	var raw []byte
	err := tx.tx.QueryRow(ctx, `SELECT owner_user_id::text,snapshot FROM task_sessions
 WHERE id=$1 AND project_id=$2 AND task_id=$3 AND claim_id=$4 FOR UPDATE`, report.SessionID, tx.projectID, taskID, report.ClaimID).Scan(&owner, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, pg.QueryError("lock startup session", err)
	}
	var snapshot sp.Snapshot
	if err = json.Unmarshal(raw, &snapshot); err != nil {
		return false, pg.QueryError("read startup session identity", err)
	}
	return owner == worker.UserID && snapshot.Lifecycle == "active" && snapshot.ClaimID == worker.ClaimID &&
		snapshot.ExecutionGeneration == report.ExecutionGeneration && snapshot.Identity.ControllerInstanceID == report.ControllerInstanceID &&
		snapshot.Identity.WorkerID == worker.WorkerID && snapshot.Identity.WorktreeID == worker.WorktreeID, nil
}

// Claim transitions and session writes share the Task transaction. Stream
// writes lock the Task before the Session, so no command can cross this fence.
func (tx *ProjectDAO) DrainTaskSessions(ctx context.Context, taskID string, plan store.TaskSessionDrain) error {
	patch, err := json.Marshal(plan.SnapshotValues)
	if err != nil {
		return pg.QueryError("encode task session snapshot", err)
	}
	_, err = tx.tx.Exec(ctx, `UPDATE task_sessions SET draining_until=statement_timestamp()+$4::bigint*interval '1 second',
 draining_timeline_seq=(snapshot->>$5::text)::bigint,
 snapshot=(snapshot - $6::text[]) || $7::jsonb
 WHERE project_id=$1 AND task_id=$2 AND snapshot->>$8::text=$9::text
 AND ($3::uuid IS NULL OR claim_id<>$3::uuid)`, tx.projectID, taskID, plan.ActiveClaim, plan.GraceSeconds,
		plan.TimelineField, plan.RemoveFields, string(patch), plan.LifecycleField, plan.SourceLifecycle)
	if err != nil {
		return pg.QueryError("freeze task sessions", err)
	}
	return nil
}

func (tx *ProjectDAO) TransitionTaskSessionReceipts(ctx context.Context, taskID string, plan store.TaskSessionReceiptTransition) error {
	_, err := tx.tx.Exec(ctx, `UPDATE session_operations SET receipt=(receipt - $3::text[]) || jsonb_build_object($4::text,$5::text)
 WHERE receipt->>$4::text=$6::text AND session_id IN
 (SELECT id FROM task_sessions WHERE project_id=$1 AND task_id=$2 AND snapshot->>$7::text=$8::text)`,
		tx.projectID, taskID, plan.RemoveFields, plan.StateField, plan.NextState, plan.PreviousState, plan.LifecycleField, plan.Lifecycle)
	if err != nil {
		return pg.QueryError("reject undispatched session operations", err)
	}
	return nil
}
