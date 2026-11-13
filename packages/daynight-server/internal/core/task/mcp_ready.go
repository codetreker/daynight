package task

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type MCPReadyRequest struct {
	TagFilter          store.TagFilter
	Parent             *string
	Limit              int
	AllowAgents        *bool
	CompatiblePlatform *model.TaskPlatform
	View               string
}

func SelectMCPReady(request MCPReadyRequest) (store.TaskPriorityQuery, error) {
	filter, err := NormalizeTagFilter(request.TagFilter)
	if err != nil {
		return store.TaskPriorityQuery{}, err
	}
	kind, parent, err := ResourceFilter(model.TaskTypeTask, request.Parent)
	if err != nil {
		return store.TaskPriorityQuery{}, err
	}
	if request.Limit < 1 || request.Limit > 20 {
		return store.TaskPriorityQuery{}, invalidInput("Limit must be between 1 and 20.")
	}
	if request.CompatiblePlatform != nil && !request.CompatiblePlatform.Valid() {
		return store.TaskPriorityQuery{}, invalidInput("Compatible platform must be windows, linux or macos.")
	}
	if request.View != "" && request.View != "summary" && request.View != "full" {
		return store.TaskPriorityQuery{}, invalidInput("Task view is invalid.")
	}
	status, ready := model.TaskTodo, true
	return store.TaskPriorityQuery{
		TagFilter: filter, Type: kind, Parent: parent,
		AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentAll},
		Status:     &status, Ready: &ready, AllowAgents: request.AllowAgents,
		CompatiblePlatform: request.CompatiblePlatform, Limit: request.Limit,
	}, nil
}
