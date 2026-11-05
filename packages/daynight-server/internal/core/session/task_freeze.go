package session

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// FreezeTaskSessions fences sessions whose claim is no longer the active Web claim.
func FreezeTaskSessions(ctx context.Context, dao store.TaskSessionFreezeDAO, taskID string, status model.TaskStatus, properties model.TaskProperties) error {
	worker, err := taskproperties.Worker(properties)
	if err != nil {
		return err
	}
	var activeClaim *string
	if status == model.TaskInProgress && worker != nil && worker.State == model.WorkerActive && worker.AgentControlMode == model.AgentControlModeWeb {
		activeClaim = &worker.ClaimID
	}
	if err := dao.DrainTaskSessions(ctx, taskID, store.TaskSessionDrain{
		ActiveClaim:     activeClaim,
		SourceLifecycle: "active",
		GraceSeconds:    60,
		TimelineField:   "lastTimelineSeq",
		LifecycleField:  "lifecycle",
		RemoveFields:    []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"},
		SnapshotValues:  map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"},
	}); err != nil {
		return err
	}
	return dao.TransitionTaskSessionReceipts(ctx, taskID, store.TaskSessionReceiptTransition{
		LifecycleField: "lifecycle", Lifecycle: "draining", StateField: "state", PreviousState: "accepted", NextState: "rejected", RemoveFields: []string{"error"},
	})
}
