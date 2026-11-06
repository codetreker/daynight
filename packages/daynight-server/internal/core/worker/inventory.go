package worker

import (
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

// SnapshotForReport preserves the distinction between an unavailable inventory
// and an explicit, possibly empty observation.
func SnapshotForReport(userID, workerID string, input model.WorkerReport, observedAt time.Time, items []model.WorkerObservedTask) model.WorkerSnapshot {
	observation := model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}}
	if input.TaskInventory != nil {
		observation = model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &observedAt,
			InventoryObservedAt: &input.TaskInventory.ObservedAt, Items: items}
	}
	return model.WorkerSnapshot{UserID: userID, WorkerID: workerID, CreatedAt: observedAt,
		LastReportedAt: observedAt, Telemetry: input.Telemetry, TaskSnapshot: observation}
}

// MatchTaskSnapshots applies Task's claim rules to the accessible batch, keeping
// the worker's inventory order. Reporting never mutates the Tasks or claims.
func MatchTaskSnapshots(sources []store.WorkerTaskSource, inventory model.WorkerTaskInventory, userID, workerID string) ([]model.WorkerObservedTask, error) {
	byID := make(map[string]store.WorkerTaskSource, len(sources))
	for _, source := range sources {
		byID[source.Task.ID] = source
	}
	items := make([]model.WorkerObservedTask, 0, len(inventory.Claims))
	for _, reference := range inventory.Claims {
		source, exists := byID[reference.TaskID]
		if !exists {
			continue
		}
		claim, err := taskcore.ActiveWorker(source.Task, reference.ClaimID)
		if err != nil {
			var fault *model.Fault
			if errors.As(err, &fault) && fault.Code == "claim_conflict" {
				continue
			}
			return nil, fmt.Errorf("decode reported worker: %w", err)
		}
		if source.Task.ProjectID != reference.ProjectID || claim.UserID != userID || claim.WorkerID != workerID {
			continue
		}
		items = append(items, model.WorkerObservedTask{
			ProjectID: source.Task.ProjectID, TaskID: source.Task.ID, ClaimID: claim.ClaimID,
			Title: source.Task.Title, ProjectName: source.ProjectName, Status: source.Task.Status,
			Phase: claim.Phase, Agent: claim.Agent,
		})
	}
	return items, nil
}

// SnapshotProjection holds the observation semantics used by list and detail.
// A missing count means inventory has never been observed, rather than zero.
type SnapshotProjection struct {
	Snapshot        model.WorkerSnapshot
	ActiveTaskCount *int
}

func ProjectSnapshot(snapshot model.WorkerSnapshot) SnapshotProjection {
	projection := SnapshotProjection{Snapshot: snapshot}
	if snapshot.TaskSnapshot.State != model.WorkerTasksUnavailable {
		count := len(snapshot.TaskSnapshot.Items)
		projection.ActiveTaskCount = &count
	}
	return projection
}
