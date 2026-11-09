package model

import "fmt"

// BotOperationError preserves storage and transaction failures without turning
// an embedded business refusal into a confirmed rejection after failed cleanup.
type BotOperationError struct {
	Operation string
	Cause     error
}

func (e *BotOperationError) Error() string { return fmt.Sprintf("%s bot: %v", e.Operation, e.Cause) }
func (e *BotOperationError) Unwrap() error { return e.Cause }
