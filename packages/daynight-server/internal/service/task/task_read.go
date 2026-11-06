package task

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func (s *Tasks) Get(ctx context.Context, principal model.Principal, projectID, id string) (model.Task, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.Task{}, err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return model.Task{}, err
	}
	id, err = model.CanonicalID(id)
	if err != nil {
		return model.Task{}, err
	}
	var result model.Task
	var missing *model.Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if _, err := projectcore.RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID); err != nil {
			if errors.As(err, &missing) {
				return nil
			}
			return err
		}
		var err error
		result, missing, err = taskcore.ReadTask(ctx, snapshot.TaskDAO(), projectID, id)
		return err
	})
	if err != nil {
		return model.Task{}, fmt.Errorf("get task: %w", err)
	}
	if missing != nil {
		return model.Task{}, missing
	}
	return result, nil
}

func (s *Tasks) List(ctx context.Context, principal model.Principal, projectID string, request TaskListRequest) (TaskPage, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return TaskPage{}, err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return TaskPage{}, err
	}
	selection, err := taskcore.SelectList(projectID, principal.UserID, taskcore.ListRequest{
		PageRequest: request.PageRequest, AssignedTo: request.AssignedTo, Status: request.Status, Ready: request.Ready,
		AllowAgents: request.AllowAgents, CompatiblePlatform: request.CompatiblePlatform, WorkerID: request.WorkerID,
	})
	if err != nil {
		return TaskPage{}, err
	}
	var result store.TaskPage
	var missing *model.Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if _, err := projectcore.RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID); err != nil {
			if errors.As(err, &missing) {
				return nil
			}
			return err
		}
		var err error
		result, missing, err = taskcore.ReadList(ctx, snapshot.TaskDAO(), projectID, selection)
		return err
	})
	if err != nil {
		return TaskPage{}, fmt.Errorf("list tasks: %w", err)
	}
	if missing != nil {
		return TaskPage{}, missing
	}
	page, err := taskcore.ProjectList(selection, result)
	if err != nil {
		return TaskPage{}, err
	}
	return TaskPage{Items: page.Items, NextCursor: page.NextCursor}, nil
}
