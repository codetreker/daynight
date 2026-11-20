package mcp

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/taskwork"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type scopedTaskReads struct {
	*taskservice.Tasks
	observations *taskservice.Observations
}

func (s scopedTaskReads) Get(ctx context.Context, p model.Principal, project, task string) (model.Task, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return model.Task{}, err
	}
	return taskservice.NewScopedTasks(s.Tasks, a).Get(ctx, p, project, task)
}

func (s scopedTaskReads) ShowGoalDependencies(ctx context.Context, p model.Principal, project, task string, input model.PageRequest) (taskcore.GoalDependencies, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return taskcore.GoalDependencies{}, err
	}
	return taskservice.NewScopedTasks(s.Tasks, a).ShowGoalDependencies(ctx, p, project, task, input)
}

func (s scopedTaskReads) ObserveGet(ctx context.Context, p model.Principal, project, task string) (taskservice.ObservedTask, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return taskservice.ObservedTask{}, err
	}
	return taskservice.NewScopedObservations(s.observations, a).ObserveGet(ctx, p, project, task)
}

func (s scopedTaskReads) Graph(ctx context.Context, p model.Principal, project, task string) (model.TaskGraph, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return model.TaskGraph{}, err
	}
	tasks := taskservice.NewScopedTasks(s.Tasks, a)
	if scopeadmission.Require(a, scopepolicy.ProjectRead) != nil {
		return tasks.GraphTaskOnly(ctx, p, project, task)
	}
	return tasks.Graph(ctx, p, project, task)
}

func (s scopedTaskReads) ObserveGraph(ctx context.Context, p model.Principal, project, task string) (taskservice.ObservedGraph, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return taskservice.ObservedGraph{}, err
	}
	observations := taskservice.NewScopedObservations(s.observations, a)
	if scopeadmission.Require(a, scopepolicy.ProjectRead) != nil {
		return observations.ObserveGraphTaskOnly(ctx, p, project, task)
	}
	return observations.ObserveGraph(ctx, p, project, task)
}

func (s scopedTaskReads) ObservedMCPList(ctx context.Context, p model.Principal, project string, input taskcore.MCPListRequest) (taskservice.ObservedMCPPage, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return taskservice.ObservedMCPPage{}, err
	}
	return taskservice.NewScopedObservations(s.observations, a).ObservedMCPList(ctx, p, project, input)
}

func (s scopedTaskReads) MCPReady(ctx context.Context, p model.Principal, project string, input taskcore.MCPReadyRequest) ([]store.TaskPriorityItem, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return nil, err
	}
	return taskservice.NewScopedTasks(s.Tasks, a).MCPReady(ctx, p, project, input)
}

func (s scopedTaskReads) WorkList(ctx context.Context, p model.Principal, project string, input taskcore.WorkRequest) (taskwork.Page, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return taskwork.Page{}, err
	}
	return taskservice.NewScopedObservations(s.observations, a).WorkList(ctx, p, project, input)
}

// RegisterScopedTaskReadTools publishes the existing query schemas using the
// policy established by scoped MCP authentication. It registers no mutations.
func RegisterScopedTaskReadTools(e *Entry, tasks *taskservice.Tasks, observations *taskservice.Observations) error {
	if e == nil || e.scopedAuth == nil || tasks == nil || observations == nil {
		return errors.New("scoped Task read tool dependencies are required")
	}
	reader := scopedTaskReads{Tasks: tasks, observations: observations}
	if err := registerTaskQueryTools(e, reader); err != nil {
		return err
	}
	if err := RegisterTaskWorkTools(e, reader); err != nil {
		return err
	}
	if err := registerTaskResourceTools(e, reader, reader, true); err != nil {
		return err
	}
	if err := registerGoalDependencyTools(e, reader, true); err != nil {
		return err
	}
	for _, name := range []string{"task_list", "task_ready", "task_graph", "task_work_list", "task_show", "task_properties", "goal_dependencies_show"} {
		e.scopedTools[name] = true
	}
	return nil
}

type ScopedTaskSearchOperation func(context.Context, model.CredentialAuthorization, string, tasksearch.Request) (tasksearch.Page, error)

func RegisterScopedTaskSearchTool(e *Entry, search ScopedTaskSearchOperation) error {
	if e == nil || e.scopedAuth == nil || search == nil {
		return errors.New("scoped Task search tool dependencies are required")
	}
	if err := RegisterTaskSearchTool(e, func(ctx context.Context, p model.Principal, project string, input tasksearch.Request) (tasksearch.Page, error) {
		a, err := scopedAuthorization(ctx, p)
		if err != nil {
			return tasksearch.Page{}, err
		}
		return search(ctx, a, project, input)
	}); err != nil {
		return err
	}
	e.scopedTools["task_search"] = true
	return nil
}
