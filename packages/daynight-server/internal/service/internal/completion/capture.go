package completion

import (
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// Capture stages a domain refusal so transaction completion errors take precedence.
func Capture(operation func() error, refusal **model.Fault) error {
	err := operation()
	if errors.As(err, refusal) {
		return nil
	}
	return err
}
