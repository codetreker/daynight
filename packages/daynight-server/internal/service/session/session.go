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
	engine *sessioncore.Engine
	writer store.SessionWriter
}

func New(writer store.SessionWriter, engine *sessioncore.Engine) *Service {
	s := &Service{engine: engine, writer: writer}
	botRuntime := botruntime.NewRuntime(engine, s.write)
	s.Execution = sessioncore.NewExecution(engine, s.browser, s.controller, s.archive, s.terminal, s.registerTask, s.registerTest, s.controllerGrant, s.taskQuery, s.credential, botRuntime.Run, s.registerTerminal, s.authorize)
	return s
}

func (s *Service) SetOrigin(origin string) { s.engine.Origin = origin }

func (s *Service) write(ctx context.Context, op *sessioncore.Operation, fn func(store.SessionScope) error) error {
	completion, err := s.writer.WriteSession(ctx, fn)
	op.Finish(completion.Outcome)
	if err != nil {
		var transaction *store.TransactionError
		if completion.Outcome == store.TransactionNotCommitted && errors.As(err, &transaction) && !transaction.CommitAttempted && !transaction.CleanupFailed {
			var refusal *model.Fault
			if errors.As(err, &refusal) {
				return refusal
			}
			if errors.Is(err, model.ErrNotFound) {
				return &model.Fault{Code: "not_found", Message: "Session was not found."}
			}
		}
		return err
	}
	if completion.Outcome != store.TransactionCommitted {
		return errors.New("session transaction did not confirm commit")
	}
	return nil
}
