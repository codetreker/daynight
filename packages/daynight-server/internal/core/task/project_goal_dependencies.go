package task

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// RemoveProjectGoalDependencies requires authorization for the enclosing Project
// operation and the owner Team graph lock in the same transaction.
func RemoveProjectGoalDependencies(ctx context.Context, dao store.ProjectGoalDependencyDAO, confirmed bool) error {
	if !confirmed {
		found, err := dao.HasProjectEdges(ctx)
		if err != nil {
			return err
		}
		if found {
			return &model.Fault{Code: "invalid_input", Message: "This operation permanently removes all Goal dependencies involving the Project. Update the client or use an entry point that explicitly confirms Goal dependency removal."}
		}
		return nil
	}
	return dao.RemoveProjectEdges(ctx)
}
