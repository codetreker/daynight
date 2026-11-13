package task

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func (s *Observations) ObserveGet(ctx context.Context, principal model.Principal, projectID, taskID string) (ObservedTask, error) {
	projectID, err := observationIdentity(principal, projectID)
	if err != nil {
		return ObservedTask{}, err
	}
	taskID, err = model.CanonicalID(taskID)
	if err != nil {
		return ObservedTask{}, err
	}
	var result ObservedTask
	var selected store.SnapshotScope
	var page ObservedTaskPage
	err = s.database.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if err := s.authorizeObservation(ctx, snapshot, principal, projectID); err != nil {
			return err
		}
		task, refusal, err := s.operations.task(ctx, snapshot.TaskDAO(), projectID, taskID)
		if err != nil {
			return err
		}
		if refusal != nil {
			return refusal
		}
		values := []model.Task{task}
		if err := decorateGoalProgress(ctx, snapshot.TaskDAO(), projectID, values); err != nil {
			return err
		}
		task = values[0]
		result.Task = task
		result.Epoch, err = snapshot.TaskDAO().TaskCacheEpoch(ctx, projectID)
		if err != nil {
			return err
		}
		page.ObservedAt, err = snapshot.ObservedAt(ctx)
		if err != nil {
			return err
		}
		selected, err = loadSelectedSources(ctx, snapshot, projectID, []model.Task{task})
		return err
	})
	if err != nil {
		return ObservedTask{}, fmt.Errorf("observe task: %w", err)
	}
	observations, _, err := s.observeBatch(ctx, selected, principal, projectID, []model.Task{result.Task}, page.ObservedAt)
	if err != nil {
		return ObservedTask{}, err
	}
	result.Session = observations[taskID]
	return result, nil
}
func (s *Observations) ObserveList(ctx context.Context, principal model.Principal, projectID string, request TaskListRequest) (ObservedTaskPage, error) {
	projectID, err := observationIdentity(principal, projectID)
	if err != nil {
		return ObservedTaskPage{}, err
	}
	selection, err := taskcore.SelectList(projectID, principal.UserID, taskcore.ListRequest{TagFilter: request.TagFilter, Type: request.Type, Parent: request.Parent, PageRequest: request.PageRequest, AssignedTo: request.AssignedTo, Status: request.Status, Ready: request.Ready, AllowAgents: request.AllowAgents, CompatiblePlatform: request.CompatiblePlatform, PlatformSpecific: request.PlatformSpecific, AutomaticCandidate: request.AutomaticCandidate, WorkerID: request.WorkerID})
	if err != nil {
		return ObservedTaskPage{}, err
	}
	result := ObservedTaskPage{Items: []ObservedTask{}}
	var tasks []model.Task
	var selected store.SnapshotScope
	err = s.database.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if err := s.authorizeObservation(ctx, snapshot, principal, projectID); err != nil {
			return err
		}
		if len(selection.Query.TagFilter.TagIDs) != 0 {
			if err := taskcore.RequireTagFilter(ctx, snapshot.TagDAO(), projectID, selection.Query.TagFilter); err != nil {
				return err
			}
		}
		rows, refusal, err := s.operations.list(ctx, snapshot.TaskDAO(), projectID, selection)
		if err != nil {
			return err
		}
		if refusal != nil {
			return refusal
		}
		page, err := taskcore.ProjectList(selection, rows)
		if err != nil {
			return err
		}
		result.NextCursor = page.NextCursor
		tasks = page.Items
		if err := decorateGoalProgress(ctx, snapshot.TaskDAO(), projectID, tasks); err != nil {
			return err
		}
		result.ObservedAt, err = snapshot.ObservedAt(ctx)
		if err != nil {
			return err
		}
		selected, err = loadSelectedSources(ctx, snapshot, projectID, tasks)
		return err
	})
	if err != nil {
		return ObservedTaskPage{}, fmt.Errorf("observe tasks: %w", err)
	}
	observations, partial, err := s.observeBatch(ctx, selected, principal, projectID, tasks, result.ObservedAt)
	if err != nil {
		return ObservedTaskPage{}, err
	}
	result.Partial = partial
	for _, task := range tasks {
		result.Items = append(result.Items, ObservedTask{Task: task, Session: observations[task.ID]})
	}
	return result, nil
}
func (s *Observations) ObserveGraph(ctx context.Context, principal model.Principal, projectID, taskID string) (ObservedGraph, error) {
	projectID, err := observationIdentity(principal, projectID)
	if err != nil {
		return ObservedGraph{}, err
	}
	taskID, err = model.CanonicalID(taskID)
	if err != nil {
		return ObservedGraph{}, err
	}
	var result ObservedGraph
	var tasks []executionIdentity
	var selected store.SnapshotScope
	err = s.database.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if err := s.authorizeObservation(ctx, snapshot, principal, projectID); err != nil {
			return err
		}
		project, err := snapshot.ProjectDAO().Project(ctx, projectID)
		if err != nil {
			return err
		}
		graph, refusal, err := s.operations.graph(ctx, snapshot.TaskDAO(), snapshot.ObservedAt, projectID, taskID, project)
		if err != nil {
			return err
		}
		if refusal != nil {
			return refusal
		}
		result.Graph = graph
		result.ObservedAt, err = snapshot.ObservedAt(ctx)
		if err != nil {
			return err
		}
		tasks = make([]executionIdentity, len(graph.Tasks))
		for i, task := range graph.Tasks {
			tasks[i] = executionIdentity{ID: task.ID, Version: task.Version}
		}
		selected, err = loadSelectedExecutionSources(ctx, snapshot, projectID, tasks)
		return err
	})
	if err != nil {
		return ObservedGraph{}, fmt.Errorf("observe task graph: %w", err)
	}
	result.Sessions, result.Partial, err = s.observeExecutionBatch(ctx, selected, principal, projectID, tasks, result.ObservedAt)
	if err != nil {
		return ObservedGraph{}, err
	}
	result.Relations = taskcore.GraphRelations(result.Graph, taskID)
	result.Aggregation = taskcore.NewSessionAggregation(result.ObservedAt)
	for _, task := range result.Graph.Tasks {
		if task.Status == model.TaskInProgress && result.Relations[task.ID] == "member" {
			taskcore.AddSessionObservation(&result.Aggregation, result.Sessions[task.ID])
		}
	}
	return result, nil
}
func (s *Observations) ObservedMCPList(ctx context.Context, principal model.Principal, projectID string, request taskcore.MCPListRequest) (ObservedMCPPage, error) {
	projectID, err := observationIdentity(principal, projectID)
	if err != nil {
		return ObservedMCPPage{}, err
	}
	selection, err := taskcore.SelectMCPList(projectID, principal.UserID, request)
	if err != nil {
		return ObservedMCPPage{}, err
	}
	result := ObservedMCPPage{Items: []ObservedMCPItem{}}
	var tasks []model.Task
	var selected store.SnapshotScope
	var items []store.TaskPriorityItem
	err = s.database.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if err := s.authorizeObservation(ctx, snapshot, principal, projectID); err != nil {
			return err
		}
		if len(selection.TagFilter().TagIDs) != 0 {
			if err := taskcore.RequireTagFilter(ctx, snapshot.TagDAO(), projectID, selection.TagFilter()); err != nil {
				return err
			}
		}
		page, err := s.operations.mcpList(ctx, snapshot.TaskDAO(), projectID, selection)
		if err != nil {
			return err
		}
		if request.View == "full" {
			if err := expandPriorityPage(ctx, snapshot.TaskDAO(), projectID, page.Items); err != nil {
				return err
			}
		}
		tasks = make([]model.Task, len(page.Items))
		for i := range page.Items {
			tasks[i] = page.Items[i].Task
		}
		items = page.Items
		if page.HasMore && len(tasks) > 0 {
			cursor, err := page.CursorAfter(selection, tasks[len(tasks)-1])
			if err != nil {
				return err
			}
			result.NextCursor = &cursor
		}
		result.ObservedAt, err = snapshot.ObservedAt(ctx)
		if err != nil {
			return err
		}
		selected, err = loadSelectedSources(ctx, snapshot, projectID, tasks)
		return err
	})
	if err != nil {
		return ObservedMCPPage{}, fmt.Errorf("observe MCP tasks: %w", err)
	}
	observations, partial, err := s.observeBatch(ctx, selected, principal, projectID, tasks, result.ObservedAt)
	if err != nil {
		return ObservedMCPPage{}, err
	}
	result.Partial = partial
	for _, item := range items {
		result.Items = append(result.Items, ObservedMCPItem{Item: item, Session: observations[item.Task.ID]})
	}
	return result, nil
}
