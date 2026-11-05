package service

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/model"

func invalidInput(message string) error {
	return &model.Fault{Code: "invalid_input", Message: message}
}
