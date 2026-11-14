package task

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// A fresh snapshot after live sampling detects a Task or execution change that
// the original repeatable-read snapshot cannot see. It also checks the real
// credential and Project access again before publishing the sampled facts.
func (s *Observations) recheckSources(ctx context.Context, principal model.Principal, projectID string, ids []string) (map[string]store.TaskSessionSource, error) {
	var sources []store.TaskSessionSource
	err := s.database.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if err := s.authorizeObservation(ctx, snapshot, principal, projectID); err != nil {
			return err
		}
		var err error
		sources, err = snapshot.SessionDAO().TaskSessionSources(ctx, projectID, ids)
		return err
	})
	if err != nil {
		return nil, err
	}
	result := make(map[string]store.TaskSessionSource, len(sources))
	for _, source := range sources {
		result[source.TaskID] = source
	}
	return result, nil
}
func sameObservedBinding(selected, current store.TaskSessionSource) bool {
	if selected.ProjectID != current.ProjectID || selected.TaskID != current.TaskID || selected.TaskVersion != current.TaskVersion || selected.TaskStatus != current.TaskStatus {
		return false
	}
	if (selected.Worker == nil) != (current.Worker == nil) || (selected.Session == nil) != (current.Session == nil) {
		return false
	}
	if selected.Worker != nil && (selected.Worker.ClaimID != current.Worker.ClaimID || selected.Worker.State != current.Worker.State || selected.Worker.UserID != current.Worker.UserID) {
		return false
	}
	return selected.Session == nil || (selected.Session.SessionID == current.Session.SessionID && selected.Session.Fence == current.Session.Fence && selected.Session.Lifecycle == current.Session.Lifecycle)
}

// Session lifecycle changes do not change the inventory, but task and claim
// changes must invalidate the Worker projection from the selected snapshot.
func samePersonalTaskBinding(selected, current store.TaskSessionSource) bool {
	if selected.ProjectID != current.ProjectID || selected.TaskID != current.TaskID || selected.TaskVersion != current.TaskVersion || selected.TaskStatus != current.TaskStatus {
		return false
	}
	if (selected.Worker == nil) != (current.Worker == nil) {
		return false
	}
	return selected.Worker == nil || (selected.Worker.ClaimID == current.Worker.ClaimID && selected.Worker.State == current.Worker.State && selected.Worker.UserID == current.Worker.UserID)
}
