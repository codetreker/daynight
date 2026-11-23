package task

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/freeze"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

// SetLifecycleLogger configures diagnostics before Task operations start.
func (s *Tasks) SetLifecycleLogger(logger *slog.Logger) {
	s.lifecycleLogger = logger
}

type statusBatchCapturer interface {
	CaptureStatusBatch(context.Context, store.WebhookCaptureDAO, wm.Actor, []protocol.Fact) error
}

// cancelDescendants validates every change before applying any, because known
// business refusals in Project writes normally commit the read-only callback.
func (s *Tasks) cancelDescendants(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.SetTaskStatus) (model.Task, error) {
	var result model.Task
	var refusal *model.Fault
	var planned, changed int
	outcome := "failed"
	defer func() {
		logger := s.lifecycleLogger
		if logger == nil {
			logger = slog.Default()
		}
		logger.InfoContext(ctx, "task descendant cancellation", "component", "task", "operation", "cancel_descendants", "request_id", requestid.From(ctx), "project_id", projectID, "task_id", id, "planned_count", planned, "changed_count", changed, "outcome", outcome)
	}()
	completion, err := s.store.WriteProject(ctx, projectID, func(tx store.ProjectWriteScope) error {
		if _, err := s.writeOperations.requireProjectWrite(ctx, tx.ProjectDAO(), principal); err != nil {
			return err
		}
		if err := s.authorizeTaskWrite(ctx, tx, principal); err != nil {
			return err
		}
		actor, err := sourceActor(ctx, tx, principal)
		if err != nil {
			return err
		}
		dao := tx.TaskDAO()
		planner, ok := dao.(store.TaskCascadeCancelDAO)
		if !ok {
			return errors.New("task cancellation planning unavailable")
		}
		rows, err := planner.TaskCascadeCancel(ctx, id)
		if errors.Is(err, model.ErrNotFound) {
			return taskcore.NotFound(err)
		}
		if err != nil {
			return err
		}
		planned = len(rows)
		var root *model.Task
		for i := range rows {
			if rows[i].ID == id {
				root = &rows[i]
				break
			}
		}
		if root == nil {
			return errors.New("task cancellation plan missing target")
		}
		if root.Type != model.TaskTypeTask {
			return &model.Fault{Code: "invalid_input", Message: "Descendant cancellation requires an ordinary Task."}
		}
		if err := taskcore.RequireVersion(root.Version, input.Version); err != nil {
			return err
		}
		// A same-status cancellation retains its existing no-op semantics.
		if root.Status == model.TaskCancelled {
			worker, err := taskproperty.Worker(root.Properties)
			if err != nil {
				return err
			}
			if err := taskcore.RequireCompatibleWorker(ctx, worker); err != nil {
				return cancellationFault(err, root.ID)
			}
			result = *root
			recordTaskWriteMetadata(ctx, taskcore.Mutation{Current: *root, Values: taskcore.CurrentWrite(*root)})
			return admitTaskResponse(ctx, result, false)
		}
		mutations := make([]taskcore.Mutation, 0, len(rows))
		for _, current := range rows {
			worker, err := taskproperty.Worker(current.Properties)
			if err != nil {
				return err
			}
			if err := taskcore.RequireCompatibleWorker(ctx, worker); err != nil {
				return cancellationFault(err, current.ID)
			}
			values, changed, err := taskcore.StatusCandidate(ctx, dao, principal, current, input, worker)
			if err != nil {
				if fault := taskWriteFault(err); fault != nil {
					refusal = cancellationFault(fault, current.ID).(*model.Fault)
					return nil
				}
				return err
			}
			mutations = append(mutations, taskcore.Mutation{ID: current.ID, Current: current, Values: values, Changed: changed})
		}
		facts := make([]protocol.Fact, 0, len(mutations))
		for _, mutation := range mutations {
			applied, err := taskcore.ApplyMutation(ctx, dao, mutation)
			if err != nil {
				return err
			}
			if mutation.ID == id {
				result = applied.Task
				recordTaskWriteMetadata(ctx, mutation)
			}
			if !mutation.Changed {
				continue
			}
			changed++
			if err := sessioncore.FreezeTaskSessions(ctx, tx.SessionDAO(), mutation.ID, mutation.Values.Status, mutation.Values.Properties); err != nil {
				return err
			}
			fs, err := taskFacts(false, mutation.Current, applied.Task)
			if err != nil {
				return err
			}
			facts = append(facts, fs...)
		}
		if err := admitTaskResponse(ctx, result, true); err != nil {
			return err
		}
		if len(facts) > 0 {
			capturer, ok := s.capturer.(statusBatchCapturer)
			if !ok {
				return errors.New("multi-task status capture unavailable")
			}
			return capturer.CaptureStatusBatch(ctx, tx.CaptureDAO(), actor, facts)
		}
		return nil
	})
	if err != nil {
		outcome = "not_confirmed"
		if fault := taskWriteFault(err); fault != nil {
			outcome = fault.Code
		} else {
			var transaction *store.TransactionError
			if errors.As(err, &transaction) {
				outcome = string(transaction.Outcome)
			}
		}
		err = redactTaskWriteError(ctx, projectcore.ProjectWriteError(err))
		if fault, ok := err.(*model.Fault); ok {
			return model.Task{}, fault
		}
		return model.Task{}, fmt.Errorf("cancel task descendants: %w", err)
	}
	if completion.Outcome != store.TransactionCommitted {
		return model.Task{}, errors.New("cancel task descendants: transaction did not confirm commit")
	}
	if refusal != nil {
		outcome = refusal.Code
		return model.Task{}, redactTaskWriteError(ctx, refusal)
	}
	outcome = "committed"
	return projectTaskWriteResponse(ctx, result), nil
}

// cancellationFault identifies the protected Task without exposing it through
// callers whose credential lacks task:read; the normal write redactor owns that.
func cancellationFault(err error, taskID string) error {
	fault := taskWriteFault(err)
	if fault == nil {
		return err
	}
	copy := *fault
	if len(copy.TaskIDs) == 0 {
		copy.TaskIDs = []string{taskID}
	}
	return &copy
}
