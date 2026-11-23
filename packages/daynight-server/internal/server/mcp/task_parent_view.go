package mcp

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/model"

func taskParentView(view string) (bool, error) {
	switch view {
	case "":
		return false, nil
	case "v1":
		return true, nil
	default:
		return false, &model.Fault{Code: "invalid_input", Message: "taskParentView must be v1 when supplied."}
	}
}
