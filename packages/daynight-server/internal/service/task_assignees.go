package service

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const MaxTaskAssigneeResolution = 100

type TaskAssigneesRequest struct {
	UserIDs []string
}

func taskAssigneeUserIDs(userIDs []string) ([]string, error) {
	if userIDs == nil {
		return nil, nil
	}
	if len(userIDs) < 1 || len(userIDs) > MaxTaskAssigneeResolution {
		return nil, invalidInput("Task assignee resolution requires between 1 and 100 user IDs.")
	}
	canonical := make([]string, len(userIDs))
	for index, userID := range userIDs {
		value, err := CanonicalID(userID)
		if err != nil {
			return nil, err
		}
		canonical[index] = value
	}
	slices.Sort(canonical)
	for index := 1; index < len(canonical); index++ {
		if canonical[index] == canonical[index-1] {
			return nil, invalidInput("Task assignee user IDs must not repeat.")
		}
	}
	return canonical, nil
}

func (s *Tasks) Assignees(ctx context.Context, principal model.Principal, projectID string, request TaskAssigneesRequest) (model.TaskAssignees, error) {
	if err := requirePrincipal(principal); err != nil {
		return model.TaskAssignees{}, err
	}
	projectID, err := CanonicalID(projectID)
	if err != nil {
		return model.TaskAssignees{}, err
	}
	userIDs, err := taskAssigneeUserIDs(request.UserIDs)
	if err != nil {
		return model.TaskAssignees{}, err
	}
	var result model.TaskAssignees
	var refusal *model.Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if _, err := RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID); err != nil {
			if errors.As(err, &refusal) {
				return nil
			}
			return err
		}
		var err error
		if userIDs == nil {
			result, err = snapshot.TaskDAO().TaskAssignees(ctx, projectID)
		} else {
			result, err = snapshot.TaskDAO().ResolveTaskAssignees(ctx, projectID, userIDs)
		}
		return err
	})
	if err != nil {
		return model.TaskAssignees{}, fmt.Errorf("read task assignees: %w", err)
	}
	if refusal != nil {
		return model.TaskAssignees{}, refusal
	}
	return result, nil
}
