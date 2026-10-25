package service

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type DeleteTask struct {
	Version       int64
	RemoveDepends bool
}

func (s *Tasks) Delete(ctx context.Context, principal core.Principal, projectID, id string, input DeleteTask) error {
	_, err := s.versionedWrite(ctx, principal, projectID, id, input.Version, func(tx *store.ProjectTx, current core.Task) (taskMutation, error) {
		if current.Properties.Worker != nil && current.Properties.Worker.State == core.WorkerActive {
			return taskMutation{}, &Fault{Code: "invalid_transition", Message: "Release the active worker execution before deleting the task."}
		}
		if !input.RemoveDepends {
			dependents, err := tx.DependentIDs(ctx, id)
			if err != nil {
				return taskMutation{}, err
			}
			if len(dependents) > 0 {
				return taskMutation{}, &Fault{Code: "dependency_unsatisfied", Message: "Remove dependent task relationships before deleting the task.", TaskIDs: dependents}
			}
		}
		return taskMutation{id: id, changed: true, deleted: true, removeDepends: input.RemoveDepends}, nil
	})
	return err
}
