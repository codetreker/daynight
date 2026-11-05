package task

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func (s *Tasks) Delete(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.DeleteTask) error {
	_, err := s.versionedWrite(ctx, principal, projectID, id, input.Version, func(tx store.ProjectWriteScope, current model.Task) (taskcore.Mutation, error) {
		mutation, err := taskcore.PrepareDelete(ctx, tx.TaskDAO(), current, input.RemoveDepends)
		return mutation, err
	})
	return err
}
