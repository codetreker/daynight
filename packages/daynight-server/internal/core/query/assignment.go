package query

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/model"

func TaskAssignmentScope(value model.TaskAssignmentFilter) (string, error) {
	switch value.Mode {
	case model.TaskAssignmentAll:
		if value.UserID == "" {
			return "all", nil
		}
	case model.TaskAssignmentUnassigned:
		if value.UserID == "" {
			return "unassigned", nil
		}
	case model.TaskAssignmentUser:
		canonical, err := model.CanonicalID(value.UserID)
		if err != nil {
			return "", err
		}
		if canonical == value.UserID {
			return "user:" + canonical, nil
		}
	}
	return "", invalidInput("Task assignment scope is invalid.")
}
