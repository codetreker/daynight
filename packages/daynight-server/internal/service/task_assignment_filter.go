package service

import "github.com/codetreker/daynight/packages/daynight-server/internal/core"

func taskAssignmentFilter(value *string, principalUserID string) (core.TaskAssignmentFilter, error) {
	if value == nil {
		return core.TaskAssignmentFilter{}, nil
	}
	if *value == "unassigned" {
		return core.TaskAssignmentFilter{Mode: core.TaskAssignmentUnassigned}, nil
	}
	userID := *value
	if userID == "me" {
		userID = principalUserID
	}
	canonical, err := CanonicalID(userID)
	if err != nil {
		return core.TaskAssignmentFilter{}, err
	}
	return core.TaskAssignmentFilter{Mode: core.TaskAssignmentUser, UserID: canonical}, nil
}

func taskAssignmentScope(value core.TaskAssignmentFilter) (string, error) {
	switch value.Mode {
	case core.TaskAssignmentAll:
		if value.UserID == "" {
			return "all", nil
		}
	case core.TaskAssignmentUnassigned:
		if value.UserID == "" {
			return "unassigned", nil
		}
	case core.TaskAssignmentUser:
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
