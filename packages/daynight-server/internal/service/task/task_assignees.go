package task

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/projection"
)

type TaskAssigneesRequest struct {
	UserIDs []string
}

func (s *Tasks) Assignees(ctx context.Context, principal model.Principal, projectID string, request TaskAssigneesRequest) (model.TaskAssignees, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.TaskAssignees{}, err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return model.TaskAssignees{}, err
	}
	userIDs, err := projection.AssigneeUserIDs(request.UserIDs)
	if err != nil {
		return model.TaskAssignees{}, err
	}
	var result model.TaskAssignees
	var refusal *model.Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if _, err := projectcore.RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID); err != nil {
			if errors.As(err, &refusal) {
				return nil
			}
			return err
		}
		var err error
		result, err = taskcore.ReadAssignees(ctx, snapshot.TaskDAO(), projectID, userIDs)
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
