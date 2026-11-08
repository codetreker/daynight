package worker

import (
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

func invalidInput(message string) error {
	return &model.Fault{Code: "invalid_input", Message: message}
}

// InputLimit converts policy and encoding budget violations to the public input fault.
func InputLimit(err error) error {
	var violation *limit.Violation
	if errors.As(err, &violation) {
		return &model.Fault{Code: "invalid_input", Message: violation.Error(), Cause: err}
	}
	return err
}
