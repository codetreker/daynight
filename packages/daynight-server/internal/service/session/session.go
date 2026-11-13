package session

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	botruntime "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot/runtime"
)

// Service coordinates each Session operation with the application's writer.
type Service struct {
	*sessioncore.Execution
	engine       *sessioncore.Engine
	writer       store.SessionWriter
	historyOps   historyScopeOperations
	beginBrowser func() (browserOperation, error)
}

func New(writer store.SessionWriter, engine *sessioncore.Engine) *Service {
	s := &Service{engine: engine, writer: writer, historyOps: historyScopeBindings(), beginBrowser: func() (browserOperation, error) { return engine.BeginOperation() }}
	botRuntime := botruntime.NewRuntime(engine, func(ctx context.Context, op *sessioncore.Operation, fn func(store.SessionScope) error) error {
		return s.write(ctx, op.Finish, fn)
	})
	s.Execution = sessioncore.NewExecution(engine, s.browserFor, s.controller, s.archive, s.terminal, s.registerTask, s.registerTest, s.controllerGrant, s.taskQuery, s.credential, botRuntime.Run, s.registerTerminal, s.authorize)
	s.Execution.SetArchivePreflight(s.archivePreflight)
	engine.SetMediaLeaseRecovery(s.recoverMediaLeases)
	engine.SetMediaLeaseCleanup(func(ctx context.Context, id, lease string) error {
		return s.write(ctx, func(store.TransactionOutcome) {}, func(scope store.SessionScope) error {
			dao, ok := scope.SessionDAO().(store.SessionResourceDAO)
			if !ok {
				return errors.New("resource lease cleanup requires resource DAO")
			}
			return dao.ReleaseSessionResourceLease(ctx, id, lease)
		})
	})
	s.Execution.SetTaskReadRunners(s.taskContentRead, s.taskReadQuery, s.taskArchiveRead)
	return s
}

func (s *Service) SetOrigin(origin string) { s.engine.Origin = origin }

func (s *Service) write(ctx context.Context, finish func(store.TransactionOutcome), fn func(store.SessionScope) error) error {
	completion, err := s.writer.WriteSession(ctx, fn)
	finish(completion.Outcome)
	if err != nil {
		var transaction *store.TransactionError
		if completion.Outcome == store.TransactionNotCommitted && errors.As(err, &transaction) && !transaction.CommitAttempted && !transaction.CleanupFailed {
			var refusal *model.Fault
			if errors.As(err, &refusal) && refusal.Code != "cleanup_unknown" && onlySessionCause(transaction.Cause, refusal) {
				// Publication refusals carry identity and failure evidence used by
				// Core after this confirmed rollback. Retain the original chain.
				var evidence interface{ PreserveSessionRefusal() bool }
				if errors.As(transaction.Cause, &evidence) && evidence.PreserveSessionRefusal() {
					return transaction.Cause
				}
				return refusal
			}
			if errors.Is(err, model.ErrNotFound) && onlySessionCause(transaction.Cause, model.ErrNotFound) {
				return errors.Join(&model.Fault{Code: "not_found", Message: "Session was not found."}, err)
			}
		}
		return err
	}
	if completion.Outcome != store.TransactionCommitted {
		return errors.New("session transaction did not confirm commit")
	}
	return nil
}

// archivePreflight releases the database scope before the owner gate is taken.
func (s *Service) archivePreflight(ctx context.Context, principal model.Principal, project, taskID, id string, mode sessioncore.ArchiveMode) (string, error) {
	return s.archivePreflightWithRecovery(ctx, principal, project, taskID, id, mode, s.recoverMediaLeases, (*sessioncore.Operation).ArchivePreflight)
}

func (s *Service) archivePreflightWithRecovery(ctx context.Context, principal model.Principal, project, taskID, id string, mode sessioncore.ArchiveMode, recover func(context.Context) error, preflight archivePreflightOperation) (owner string, err error) {
	op, err := s.engine.BeginOperation()
	if err != nil {
		return "", err
	}
	defer op.Close()
	ctx, cancel := mediaRecoveryContext(ctx, op)
	defer cancel()
	if err = recover(ctx); err != nil {
		return "", err
	}
	err = s.write(ctx, op.Finish, func(scope store.SessionScope) error {
		var e error
		owner, e = preflight(op, ctx, scope, principal, project, taskID, id, mode)
		return e
	})
	return owner, err
}

// onlySessionCause permits ordinary domain refusals to retain their established
// response while keeping independent cleanup failures and completion facts intact.
func onlySessionCause(err, target error) bool {
	if err == target {
		return true
	}
	if failure, ok := err.(*store.Error); ok && target == model.ErrNotFound && failure.MissingRow && !failure.DatabaseFailure {
		return true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		children := joined.Unwrap()
		return len(children) == 1 && onlySessionCause(children[0], target)
	}
	if next := errors.Unwrap(err); next != nil {
		return onlySessionCause(next, target)
	}
	return false
}
