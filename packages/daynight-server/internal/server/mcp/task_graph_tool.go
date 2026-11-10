package mcp

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/taskwork"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type graphInput struct {
	ProjectID   string `json:"projectId"`
	TaskID      string `json:"taskId"`
	DependsOnly bool   `json:"dependsOnly"`
	View        string `json:"view"`
}

type graphReader interface {
	Graph(context.Context, model.Principal, string, string) (model.TaskGraph, error)
	ObserveGraph(context.Context, model.Principal, string, string) (taskservice.ObservedGraph, error)
}

type graphNode struct {
	Session           *sp.TaskSessionObservation `json:"session,omitempty"`
	Relation          string                     `json:"relation,omitempty"`
	ID                string                     `json:"id"`
	TitlePreview      string                     `json:"titlePreview"`
	TitleTruncated    bool                       `json:"titleTruncated"`
	Status            model.TaskStatus           `json:"status"`
	DependsOn         []string                   `json:"dependsOn"`
	ExternalDependsOn []string                   `json:"externalDependsOn"`
	BlockedBy         []string                   `json:"blockedBy"`
	RequiredPlatform  *model.TaskPlatform        `json:"requiredPlatform"`
	AssignedTo        *string                    `json:"assignedTo"`
	AllowAgents       bool                       `json:"allowAgents"`
	Ready             bool                       `json:"ready"`
	CreatedAt         time.Time                  `json:"createdAt"`
	UpdatedAt         time.Time                  `json:"updatedAt"`
	StartedAt         *time.Time                 `json:"startedAt"`
	CompletedAt       *time.Time                 `json:"completedAt"`
	CancelledAt       *time.Time                 `json:"cancelledAt"`
}

type graphData struct {
	SessionSummary *taskwork.Aggregation `json:"sessionSummary,omitempty"`
	Partial        *bool                 `json:"partial,omitempty"`
	Projection     string                `json:"projection"`
	Project        Project               `json:"project"`
	ObservedAt     time.Time             `json:"observedAt"`
	Summary        graphSummary          `json:"summary"`
	Tasks          []any                 `json:"tasks"`
	ReturnedNodes  int                   `json:"returnedNodes"`
	TotalNodes     int                   `json:"totalNodes"`
}

type graphSummary struct {
	Total      int64 `json:"total"`
	Proposed   int64 `json:"proposed"`
	Todo       int64 `json:"todo"`
	InProgress int64 `json:"inProgress"`
	Done       int64 `json:"done"`
	Cancelled  int64 `json:"cancelled"`
	Ready      int64 `json:"ready"`
	Blocked    int64 `json:"blocked"`
}

type dependencyNode struct {
	ID                string   `json:"id"`
	DependsOn         []string `json:"dependsOn"`
	ExternalDependsOn []string `json:"externalDependsOn"`
}

func graphTool(ctx context.Context, actor RequestActor, in graphInput, reader graphReader) (ToolResult, error) {
	var graph model.TaskGraph
	var observed taskservice.ObservedGraph
	var err error
	if in.DependsOnly {
		graph, err = reader.Graph(ctx, actor.Principal, in.ProjectID, in.TaskID)
	} else {
		observed, err = reader.ObserveGraph(ctx, actor.Principal, in.ProjectID, in.TaskID)
		graph = observed.Graph
	}
	if err != nil {
		return ToolResult{}, err
	}
	view := in.View
	if view == "" {
		view = "summary"
	}
	s := graph.Summary
	result := graphData{Projection: view, Project: MapProject(graph.Project), ObservedAt: graph.ObservedAt.UTC(),
		Summary: graphSummary{Total: s.Total, Proposed: s.Proposed, Todo: s.Todo, InProgress: s.InProgress, Done: s.Done, Cancelled: s.Cancelled, Ready: s.Ready, Blocked: s.Blocked},
		Tasks:   make([]any, 0, len(graph.Tasks)), ReturnedNodes: len(graph.Tasks), TotalNodes: len(graph.Tasks)}
	for _, task := range graph.Tasks {
		deps := append([]string{}, task.DependsOn...)
		ext := append([]string{}, task.ExternalDependsOn...)
		var item any
		if in.DependsOnly {
			item = dependencyNode{task.ID, deps, ext}
		} else {
			observation := observed.Sessions[task.ID]
			item = graphNode{Session: &observation, Relation: observed.Relations[task.ID], ID: task.ID, TitlePreview: task.TitlePreview, TitleTruncated: task.TitleTruncated, Status: task.Status,
				DependsOn: deps, ExternalDependsOn: ext, BlockedBy: append([]string{}, task.BlockedBy...),
				RequiredPlatform: task.RequiredPlatform, AssignedTo: task.AssignedTo, AllowAgents: task.AllowAgents, Ready: task.Ready,
				CreatedAt: task.CreatedAt.UTC(), UpdatedAt: task.UpdatedAt.UTC(), StartedAt: utcTime(task.StartedAt), CompletedAt: utcTime(task.CompletedAt), CancelledAt: utcTime(task.CancelledAt)}
		}
		result.Tasks = append(result.Tasks, item)
	}
	if in.DependsOnly {
		return ToolResult{Data: result}, nil
	}
	result.SessionSummary = &observed.Aggregation
	result.Partial = &observed.Partial
	return ToolResult{Data: result, Observation: &ReadObservation{ObservedAt: observed.ObservedAt, Partial: observed.Partial}, Refs: map[string]any{"projectId": in.ProjectID, "taskId": in.TaskID}}, nil
}
