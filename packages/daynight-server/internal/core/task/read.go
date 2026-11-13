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
	TagFilter store.TagFilter
	Type      model.TaskType
	Parent    *string
	model.PageRequest
	AssignedTo         *string
	Status             *model.TaskStatus
	Ready, AllowAgents *bool
	CompatiblePlatform *model.TaskPlatform
	PlatformSpecific   *bool
	AutomaticCandidate bool
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

// ResourceFilter normalizes the public typed resource selection.
func ResourceFilter(kind model.TaskType, parent *string) (model.TaskType, *string, error) {
	if kind == "" {
		kind = model.TaskTypeTask
	}
	if kind != model.TaskTypeTask && kind != model.TaskTypeGoal {
		return "", nil, invalidInput("Task type is invalid.")
	}
	if parent == nil {
		return kind, nil, nil
	}
	value := *parent
	if value != "none" {
		var err error
		value, err = model.CanonicalID(value)
		if err != nil {
			return "", nil, err
		}
		if kind == model.TaskTypeGoal {
			return "", nil, invalidInput("Goal cannot have a parent.")
		}
	}
	return kind, &value, nil
}

func SelectList(projectID, principalUserID string, request ListRequest) (ListSelection, error) {
	filter, err := NormalizeTagFilter(request.TagFilter)
	if err != nil {
		return ListSelection{}, err
	}
	kind, parent, err := ResourceFilter(request.Type, request.Parent)
	if err != nil {
		return ListSelection{}, err
	}
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
	scope := query.ListScope{TagFilterIdentity: TagFilterIdentity(filter), Type: kind, Parent: parent, Kind: "tasks", ProjectID: projectID, Ready: request.Ready, AllowAgents: request.AllowAgents, CompatiblePlatform: request.CompatiblePlatform, PlatformSpecific: request.PlatformSpecific, AutomaticCandidate: request.AutomaticCandidate, AssignedTo: assignedTo}
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
	return ListSelection{Scope: scope, Query: store.TaskQuery{TagFilter: filter, Type: request.Type, Parent: parent, Page: page, Status: request.Status, Ready: request.Ready, AllowAgents: request.AllowAgents, CompatiblePlatform: request.CompatiblePlatform, PlatformSpecific: request.PlatformSpecific, AutomaticCandidate: request.AutomaticCandidate, Worker: worker, AssignedTo: assignedTo}}, nil
}

// ReadFault classifies a task read refusal without hiding unrelated failures.
func ReadFault(err error) *model.Fault {
	if errors.Is(err, model.ErrTaskDeleted) {
		return &model.Fault{Code: "task_deleted", Message: "Task was deleted.", Cause: err}
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
