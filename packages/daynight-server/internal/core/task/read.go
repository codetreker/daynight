package task

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type ListRequest struct {
	model.PageRequest
	AssignedTo         *string
	Status             *model.TaskStatus
	Ready, AllowAgents *bool
	CompatiblePlatform *model.TaskPlatform
	PlatformSpecific   *bool
	WorkerID           *string
}

type ListSelection struct {
	Scope query.ListScope
	Query store.TaskQuery
}

func AssignmentFilter(value *string, principalUserID string) (model.TaskAssignmentFilter, error) {
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

func SelectList(projectID, principalUserID string, request ListRequest) (ListSelection, error) {
	if request.Status != nil && !request.Status.Valid() {
		return ListSelection{}, invalidInput("Task status is invalid.")
	}
	if request.CompatiblePlatform != nil && !request.CompatiblePlatform.Valid() {
		return ListSelection{}, invalidInput("Compatible platform must be windows, linux or macos.")
	}
	assignedTo, err := AssignmentFilter(request.AssignedTo, principalUserID)
	if err != nil {
		return ListSelection{}, err
	}
	scope := query.ListScope{Kind: "tasks", ProjectID: projectID, Ready: request.Ready, AllowAgents: request.AllowAgents, CompatiblePlatform: request.CompatiblePlatform, PlatformSpecific: request.PlatformSpecific, AssignedTo: assignedTo}
	var worker *store.WorkerQuery
	if request.WorkerID != nil {
		workerID, err := model.CanonicalID(*request.WorkerID)
		if err != nil {
			return ListSelection{}, err
		}
		worker = &store.WorkerQuery{UserID: principalUserID, WorkerID: workerID}
		scope.WorkerID, scope.WorkerUserID = &worker.WorkerID, &worker.UserID
	}
	if request.Status != nil {
		status := string(*request.Status)
		scope.Status = &status
	}
	page, err := query.ListPage(request.PageRequest, scope)
	if err != nil {
		return ListSelection{}, err
	}
	return ListSelection{Scope: scope, Query: store.TaskQuery{Page: page, Status: request.Status, Ready: request.Ready, AllowAgents: request.AllowAgents, CompatiblePlatform: request.CompatiblePlatform, PlatformSpecific: request.PlatformSpecific, Worker: worker, AssignedTo: assignedTo}}, nil
}

// ReadFault classifies a task read refusal without hiding unrelated failures.
func ReadFault(err error) *model.Fault {
	if fault := PropertyFault(err); fault != nil {
		return fault
	}
	if errors.Is(err, model.ErrNotFound) {
		return NotFound(err)
	}
	return nil
}

// ReadDAO supplies task facts from the caller's authorized snapshot.
type ReadDAO interface {
	Task(context.Context, string, string) (model.Task, error)
	Tasks(context.Context, string, store.TaskQuery) (store.TaskPage, error)
}

func ReadTask(ctx context.Context, reader ReadDAO, projectID, taskID string) (model.Task, *model.Fault, error) {
	result, err := reader.Task(ctx, projectID, taskID)
	if fault := ReadFault(err); fault != nil {
		return model.Task{}, fault, nil
	}
	return result, nil, err
}

func ReadList(ctx context.Context, reader ReadDAO, projectID string, selection ListSelection) (store.TaskPage, *model.Fault, error) {
	result, err := reader.Tasks(ctx, projectID, selection.Query)
	if fault := PropertyFault(err); fault != nil {
		return store.TaskPage{}, fault, nil
	}
	return result, nil, err
}

type ListPage struct {
	Items      []model.Task
	NextCursor *string
}

func ProjectList(selection ListSelection, result store.TaskPage) (ListPage, error) {
	response := ListPage{Items: result.Items}
	if result.HasMore {
		last := result.Items[len(result.Items)-1]
		cursor, err := query.EncodeListCursor(selection.Scope, last.CreatedAt, last.ID)
		if err != nil {
			return ListPage{}, fmt.Errorf("encode task cursor: %w", err)
		}
		response.NextCursor = &cursor
	}
	return response, nil
}
