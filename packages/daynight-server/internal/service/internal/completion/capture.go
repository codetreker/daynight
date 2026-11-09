package completion

import (
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// Capture stages a domain refusal so transaction completion errors take precedence.
func Capture(operation func() error, refusal **model.Fault) error {
	err := operation()
	if failed, _ := store.DatabaseErrorFacts(err); failed {
		return err
	}
	var thread *store.ThreadTransactionError
	if errors.As(err, &thread) && (thread.RollbackFailed || thread.OutcomeUnknown) {
		return err
	}
	var transaction *store.TransactionError
	if errors.As(err, &transaction) && (transaction.Phase != "operation" || transaction.CleanupFailed || transaction.Outcome != store.TransactionNotCommitted) {
		return err
	}
	if errors.As(err, refusal) {
		return nil
	}
	return err
}
