package store

import (
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/internal/transaction"
)

// TransactionOutcome states what is known about a transaction's durable result.
type TransactionOutcome = transaction.Outcome

const (
	TransactionCommitted    = transaction.Committed
	TransactionNotCommitted = transaction.NotCommitted
	TransactionUnknown      = transaction.Unknown
)

// Completion records the durable outcome independently of any operation or
// cleanup error. Unknown must not be interpreted as a rollback.
type Completion struct {
	Outcome TransactionOutcome
}

// Error preserves the driver cause without exposing credentials or SQL in diagnostics.
type Error struct {
	Phase string
	Cause error
}

func (e *Error) Error() string { return fmt.Sprintf("database %s failed", e.Phase) }
func (e *Error) Unwrap() error { return e.Cause }

// TransactionError preserves completion facts separately from the original
// operation and cleanup causes. An unsuccessful COMMIT is not proof of rollback.
type TransactionError = transaction.Error

// ThreadTransactionError records local write stages without inventing a durable
// submission identity. An unsuccessful COMMIT is not proof of rollback.
type ThreadTransactionError struct {
	Phase           string
	Cause           error
	CommitAttempted bool
	OutcomeUnknown  bool
	RollbackFailed  bool
}

func (err *ThreadTransactionError) Error() string {
	return "thread transaction " + err.Phase + " failed"
}
func (err *ThreadTransactionError) Unwrap() error { return err.Cause }

// ThreadClockError means the bounded preparation did not obtain a reliable
// forward position; it does not assert that the database clock moved backwards.
type ThreadClockError struct {
	Head     model.ThreadPosition
	Observed time.Time
	Cause    error
}

func (err *ThreadClockError) Error() string {
	return "reliable forward clock position was not obtained within budget"
}
func (err *ThreadClockError) Unwrap() error { return err.Cause }
