package task

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

const goalLifecycleTimeout = 5 * time.Second

const GoalWriteUnknownMessage = "The write outcome is unknown. Read the current resource before deciding on another operation."

// GoalWriteUnknown retains the actual transaction facts for diagnostics while
// identifying a Goal lifecycle commit whose outcome cannot be confirmed.
type GoalWriteUnknown struct{ Cause error }

func (e *GoalWriteUnknown) Error() string { return GoalWriteUnknownMessage }
func (e *GoalWriteUnknown) Unwrap() error { return e.Cause }

func goalLifecycleError(err error, goal bool) error {
	if !goal || err == nil {
		return err
	}
	var tx *store.TransactionError
	if errors.As(err, &tx) && tx.CommitAttempted && tx.Outcome == store.TransactionUnknown {
		return &GoalWriteUnknown{Cause: err}
	}
	return err
}

// lifecycleContext reads the immutable type without locking a Task row.
// Goal writes receive a bounded context after this type selection; authorization,
// identity and version are checked again in the write scope.
func (s *Tasks) lifecycleContext(ctx context.Context, principal model.Principal, projectID, id string) (context.Context, context.CancelFunc, bool, error) {
	var goal bool
	var refusal *model.Fault
	err := s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if _, err := projectcore.RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID); err != nil {
			if errors.As(err, &refusal) {
				return nil
			}
			return err
		}
		header, err := snapshot.TaskDAO().TaskHeader(ctx, projectID, id)
		if errors.Is(err, model.ErrNotFound) || errors.Is(err, model.ErrTaskDeleted) {
			refusal = taskcore.NotFound(err)
			return nil
		}
		if err != nil {
			return err
		}
		if header.DeletedAt != nil {
			refusal = taskcore.NotFound(model.ErrTaskDeleted)
			return nil
		}
		goal = header.Type == model.TaskTypeGoal
		return nil
	})
	if err != nil {
		return nil, nil, false, fmt.Errorf("read lifecycle target: %w", err)
	}
	if refusal != nil {
		return nil, nil, false, refusal
	}
	if !goal {
		return ctx, func() {}, false, nil
	}
	bounded, cancel := context.WithTimeout(ctx, goalLifecycleTimeout)
	return bounded, cancel, true, nil
}
