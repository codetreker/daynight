package task

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func taskWriteFault(err error) *model.Fault {
	if failed, _ := store.DatabaseErrorFacts(err); failed {
		return nil
	}
	var transaction *store.TransactionError
	if errors.As(err, &transaction) && (transaction.Phase != "operation" || transaction.CleanupFailed || transaction.Outcome != store.TransactionNotCommitted) {
		return nil
	}
	var fault *model.Fault
	if errors.As(err, &fault) {
		return fault
	}
	return taskcore.PropertyFault(err)
}

func enforceAssignmentTransition(ctx context.Context, tx store.ProjectWriteScope, mutation taskcore.Mutation) (taskcore.Mutation, error) {
	values, changed, err := taskcore.AssignmentCandidate(mutation.Current, mutation.Values)
	if err != nil {
		return taskcore.Mutation{}, err
	}
	if !changed {
		return mutation, nil
	}
	if mutation.Values.AssignedTo != nil {
		if _, err := tx.ProjectDAO().ProjectAccess(ctx, model.Principal{UserID: *mutation.Values.AssignedTo}); err != nil {
			if errors.Is(err, model.ErrNotFound) {
				return taskcore.Mutation{}, &model.Fault{Code: "invalid_input", Message: "Assigned user must have access to the project.", Cause: err}
			}
			return taskcore.Mutation{}, err
		}
	}
	mutation.Values = values
	return mutation, nil
}
