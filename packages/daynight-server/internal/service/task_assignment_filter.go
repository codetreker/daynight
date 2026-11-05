package service

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/model"

func taskAssignmentFilter(value *string, principalUserID string) (model.TaskAssignmentFilter, error) {
	if value == nil {
		return model.TaskAssignmentFilter{}, nil
	}
	if *value == "unassigned" {
		return model.TaskAssignmentFilter{Mode: model.TaskAssignmentUnassigned}, nil
	}
	userID := *value
	if userID == "me" {
		userID = principalUserID
	}
	canonical, err := CanonicalID(userID)
	if err != nil {
		return model.TaskAssignmentFilter{}, err
	}
	return model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: canonical}, nil
}

func taskAssignmentScope(value model.TaskAssignmentFilter) (string, error) {
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
		canonical, err := CanonicalID(value.UserID)
		if err != nil {
			return "", err
		}
		if canonical == value.UserID {
			return "user:" + canonical, nil
		}
	}
	return "", invalidInput("Task assignment scope is invalid.")
}
