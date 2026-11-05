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
	canonical, err := model.CanonicalID(userID)
	if err != nil {
		return model.TaskAssignmentFilter{}, err
	}
	return model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: canonical}, nil
}
