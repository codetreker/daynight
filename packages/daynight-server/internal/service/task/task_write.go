package task

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

type taskWriteMetadataKey struct{}

// TaskWriteMetadata records resource identity from the project write scope.
type TaskWriteMetadata struct {
	Type          model.TaskType
	ParentID      *string
	OldParentID   *string
	NewParentID   *string
	ParentChanged bool
}

func WithTaskWriteMetadata(ctx context.Context, metadata *TaskWriteMetadata) context.Context {
	return context.WithValue(ctx, taskWriteMetadataKey{}, metadata)
}

func recordTaskWriteMetadata(ctx context.Context, mutation taskcore.Mutation) {
	metadata, ok := ctx.Value(taskWriteMetadataKey{}).(*TaskWriteMetadata)
	if !ok || metadata == nil {
		return
	}
	metadata.Type = mutation.Current.Type
	metadata.ParentID = mutation.Current.ParentID
	if mutation.Create {
		metadata.Type, metadata.ParentID = mutation.Values.Type, mutation.Values.ParentID
	} else if !mutation.Delete {
		metadata.NewParentID, metadata.OldParentID = mutation.Values.ParentID, mutation.Current.ParentID
		metadata.ParentChanged = !model.EqualOptional(metadata.OldParentID, metadata.NewParentID)
		metadata.ParentID = mutation.Values.ParentID
	}
}

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
