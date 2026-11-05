package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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
		result, err = snapshot.TaskDAO().Task(ctx, projectID, id)
		if validation := propertyValidationFault(err); validation != nil {
			missing = validation
			return nil
		}
		if errors.Is(err, model.ErrNotFound) {
			missing = taskNotFound(err)
			return nil
		}
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
	if request.Status != nil && !request.Status.Valid() {
		return TaskPage{}, invalidInput("Task status is invalid.")
	}
	if request.CompatiblePlatform != nil && !request.CompatiblePlatform.Valid() {
		return TaskPage{}, invalidInput("Compatible platform must be windows, linux or macos.")
	}
	assignedTo, err := taskAssignmentFilter(request.AssignedTo, principal.UserID)
	if err != nil {
		return TaskPage{}, err
	}
	scope := query.ListScope{Kind: "tasks", ProjectID: projectID, Ready: request.Ready, AllowAgents: request.AllowAgents, CompatiblePlatform: request.CompatiblePlatform, AssignedTo: assignedTo}
	var worker *store.WorkerQuery
	if request.WorkerID != nil {
		workerID, err := model.CanonicalID(*request.WorkerID)
		if err != nil {
			return TaskPage{}, err
		}
		worker = &store.WorkerQuery{UserID: principal.UserID, WorkerID: workerID}
		scope.WorkerID, scope.WorkerUserID = &worker.WorkerID, &worker.UserID
	}
	if request.Status != nil {
		status := string(*request.Status)
		scope.Status = &status
	}
	page, err := query.ListPage(request.PageRequest, scope)
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
		result, err = snapshot.TaskDAO().Tasks(ctx, projectID, store.TaskQuery{Page: page, Status: request.Status, Ready: request.Ready, AllowAgents: request.AllowAgents, CompatiblePlatform: request.CompatiblePlatform, Worker: worker, AssignedTo: assignedTo})
		if validation := propertyValidationFault(err); validation != nil {
			missing = validation
			return nil
		}
		return err
	})
	if err != nil {
		return TaskPage{}, fmt.Errorf("list tasks: %w", err)
	}
	if missing != nil {
		return TaskPage{}, missing
	}
	response := TaskPage{Items: result.Items}
	if result.HasMore {
		last := result.Items[len(result.Items)-1]
		cursor, err := query.EncodeListCursor(scope, last.CreatedAt, last.ID)
		if err != nil {
			return TaskPage{}, fmt.Errorf("encode task cursor: %w", err)
		}
		response.NextCursor = &cursor
	}
	return response, nil
}
