package task

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
)

type taskWriteAuthorizationKey struct{}
type taskWriteOperationsKey struct{}
type taskWriteTargetKey struct{}
type taskWriteTarget struct {
	id   string
	goal bool
}
type taskWriteAuthorization struct {
	authorization model.CredentialAuthorization
	fullResponse  bool
}

// WithTaskWriteAuthorization binds the authenticated policy and response view
// to the existing shared write operation. The caller must only select a minimal
// view when it actually serializes a minimal receipt.
func WithTaskWriteAuthorization(ctx context.Context, auth model.CredentialAuthorization, fullResponse bool) context.Context {
	return context.WithValue(ctx, taskWriteAuthorizationKey{}, taskWriteAuthorization{auth, fullResponse})
}

// TaskWriteAuthorizationFromContext reports the policy and view selected by a
// protocol adapter. A missing value denotes the legacy assembly.
func TaskWriteAuthorizationFromContext(ctx context.Context) (model.CredentialAuthorization, bool, bool) {
	auth, ok := ctx.Value(taskWriteAuthorizationKey{}).(taskWriteAuthorization)
	return auth.authorization, auth.fullResponse, ok
}

func withTaskWriteOperations(ctx context.Context, ops ...scopepolicy.Operation) context.Context {
	if _, scoped := ctx.Value(taskWriteAuthorizationKey{}).(taskWriteAuthorization); !scoped {
		return ctx
	}
	return context.WithValue(ctx, taskWriteOperationsKey{}, ops)
}

func withTaskWriteTarget(ctx context.Context, id string, goal bool) context.Context {
	if _, scoped := ctx.Value(taskWriteAuthorizationKey{}).(taskWriteAuthorization); !scoped {
		return ctx
	}
	return context.WithValue(ctx, taskWriteTargetKey{}, taskWriteTarget{id, goal})
}

func scopedGoalLocked(ctx context.Context) bool {
	target, ok := ctx.Value(taskWriteTargetKey{}).(taskWriteTarget)
	return ok && target.goal
}

// authorizeTaskWrite establishes target visibility under the same project lock.
// Goal operations take the team lock before locking the target, as in legacy.
func (s *Tasks) authorizeTaskWrite(ctx context.Context, tx store.ProjectWriteScope, principal model.Principal) error {
	if _, scoped := ctx.Value(taskWriteAuthorizationKey{}).(taskWriteAuthorization); !scoped {
		return nil
	}
	if target, ok := ctx.Value(taskWriteTargetKey{}).(taskWriteTarget); ok {
		if target.goal {
			if err := tx.GoalDependencyDAO().LockTeam(ctx); err != nil {
				return err
			}
			if _, err := s.writeOperations.requireProjectWrite(ctx, tx.ProjectDAO(), principal); err != nil {
				return err
			}
		}
		var header model.TaskHeader
		var err error
		// Mutation planners own the first Task row lock and their complete
		// ordered write set; the project lock stabilizes this visibility read.
		header, err = tx.TaskDAO().TaskVisibilityHeader(ctx, target.id)
		if errors.Is(err, model.ErrNotFound) || errors.Is(err, model.ErrTaskDeleted) {
			return taskcore.NotFound(err)
		}
		if err != nil {
			return err
		}
		if header.DeletedAt != nil {
			return taskcore.NotFound(model.ErrTaskDeleted)
		}
	}
	return checkTaskWriteScope(ctx, principal)
}

type redactedTaskFault struct {
	cause error
	fault *model.Fault
}

func (e *redactedTaskFault) Error() string { return e.cause.Error() }
func (e *redactedTaskFault) Unwrap() error { return e.cause }
func (e *redactedTaskFault) As(target any) bool {
	if p, ok := target.(**model.Fault); ok {
		*p = e.fault
		return true
	}
	return false
}

func redactTaskWriteError(ctx context.Context, err error) error {
	auth, scoped := ctx.Value(taskWriteAuthorizationKey{}).(taskWriteAuthorization)
	if !scoped || scopeadmission.Require(auth.authorization, scopepolicy.TaskRead) == nil {
		return err
	}
	fault, safe := operation.KnownFault(err)
	if !safe || len(fault.TaskIDs) == 0 {
		return err
	}
	copy := *fault
	copy.TaskIDs = nil
	return &redactedTaskFault{cause: err, fault: &copy}
}

// checkTaskWriteScope follows existing resource visibility and precedes any
// mutation. Absence of the context retains the existing legacy assembly.
func checkTaskWriteScope(ctx context.Context, principal model.Principal) error {
	auth, scoped := ctx.Value(taskWriteAuthorizationKey{}).(taskWriteAuthorization)
	if !scoped {
		return nil
	}
	if auth.authorization.Principal != principal {
		return model.Unauthenticated(errors.New("mismatched task credential authorization"))
	}
	ops, ok := ctx.Value(taskWriteOperationsKey{}).([]scopepolicy.Operation)
	if !ok || len(ops) == 0 {
		return errors.New("missing task write scope classification")
	}
	ops = append([]scopepolicy.Operation(nil), ops...)
	if auth.fullResponse {
		ops = append(ops, scopepolicy.TaskRead)
		for _, op := range ops {
			if op == scopepolicy.WorkerClaim || op == scopepolicy.WorkerReport || op == scopepolicy.WorkerComplete {
				ops = append(ops, scopepolicy.SessionRead)
				break
			}
		}
	}
	return scopeadmission.Require(auth.authorization, ops...)
}

func projectTaskWriteResponse(ctx context.Context, task model.Task) model.Task {
	auth, full, scoped := TaskWriteAuthorizationFromContext(ctx)
	if scoped && full && !sessionProjectionAllowed(&auth) {
		return taskcore.WithoutSessionProperties(task)
	}
	return task
}
