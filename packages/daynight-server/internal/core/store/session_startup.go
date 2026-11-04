package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/jackc/pgx/v5"
)

// MatchSessionStartup locks after the task, sharing the relay's task/session order.
// A generation grant does not change task.version and therefore needs this fence.
func (tx *ProjectTx) MatchSessionStartup(ctx context.Context, taskID string, worker *core.WorkerClaim, report sp.StartupReport) (bool, error) {
	var owner string
	var raw []byte
	err := tx.tx.QueryRow(ctx, `SELECT owner_user_id::text,snapshot FROM task_sessions
 WHERE id=$1 AND project_id=$2 AND task_id=$3 AND claim_id=$4 FOR UPDATE`, report.SessionID, tx.projectID, taskID, report.ClaimID).Scan(&owner, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, queryError("lock startup session", err)
	}
	var snapshot sp.Snapshot
	if err = json.Unmarshal(raw, &snapshot); err != nil {
		return false, queryError("read startup session identity", err)
	}
	return owner == worker.UserID && snapshot.Lifecycle == "active" && snapshot.ClaimID == worker.ClaimID &&
		snapshot.ExecutionGeneration == report.ExecutionGeneration && snapshot.Identity.ControllerInstanceID == report.ControllerInstanceID &&
		snapshot.Identity.WorkerID == worker.WorkerID && snapshot.Identity.WorktreeID == worker.WorktreeID, nil
}
