package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const (
	maxGraphNodes               = 1000
	maxGraphEdges               = 5000
	graphTitlePreviewCharacters = 160
)

func (s *Tasks) Graph(ctx context.Context, principal model.Principal, projectID, taskID string) (model.TaskGraph, error) {
	if err := requirePrincipal(principal); err != nil {
		return model.TaskGraph{}, err
	}
	projectID, err := CanonicalID(projectID)
	if err != nil {
		return model.TaskGraph{}, err
	}
	taskID, err = CanonicalID(taskID)
	if err != nil {
		return model.TaskGraph{}, err
	}
	var graph model.TaskGraph
	var refusal *model.Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if _, err := RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID); err != nil {
			if errors.As(err, &refusal) {
				return nil
			}
			return err
		}
		var err error
		graph.Project, err = snapshot.ProjectDAO().Project(ctx, projectID)
		if errors.Is(err, model.ErrNotFound) {
			refusal = &model.Fault{Code: "not_found", Message: "Project was not found.", Cause: err}
			return nil
		}
		if err != nil {
			return err
		}
		if err := snapshot.TaskDAO().TaskGraphRoot(ctx, projectID, taskID); err != nil {
			if errors.Is(err, model.ErrNotFound) || errors.Is(err, model.ErrTaskDeleted) {
				refusal = taskNotFound(err)
				return nil
			}
			return err
		}
		size, err := snapshot.TaskDAO().TaskGraphProjectionSize(ctx, projectID, taskID)
		if err != nil {
			return err
		}
		if size.NodeCount > maxGraphNodes || size.EdgeCount > maxGraphEdges {
			refusal = &model.Fault{Code: "graph_limit_exceeded", Message: "Task graph exceeds the supported size.",
				GraphLimit: &model.GraphLimitDetails{NodeCount: size.NodeCount, EdgeCount: size.EdgeCount,
					MaxNodes: maxGraphNodes, MaxEdges: maxGraphEdges}}
			return nil
		}
		graph.Tasks, err = snapshot.TaskDAO().TaskGraphTasks(ctx, projectID, taskID, graphTitlePreviewCharacters)
		if err != nil {
			return err
		}
		graph.Summary = summarizeGraph(graph.Tasks)
		graph.ObservedAt, err = snapshot.ObservedAt(ctx)
		return err
	})
	if err != nil {
		return model.TaskGraph{}, fmt.Errorf("read task graph: %w", err)
	}
	if refusal != nil {
		return model.TaskGraph{}, refusal
	}
	return graph, nil
}

func summarizeGraph(tasks []model.GraphTask) model.TaskGraphSummary {
	summary := model.TaskGraphSummary{Total: int64(len(tasks))}
	for _, task := range tasks {
		switch task.Status {
		case model.TaskTodo:
			summary.Todo++
			if task.Ready {
				summary.Ready++
			} else {
				summary.Blocked++
			}
		case model.TaskInProgress:
			summary.InProgress++
		case model.TaskDone:
			summary.Done++
		}
	}
	return summary
}
