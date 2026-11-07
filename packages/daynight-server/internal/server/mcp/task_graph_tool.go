package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type graphInput struct {
	ProjectID   string `json:"projectId"`
	TaskID      string `json:"taskId"`
	DependsOnly bool   `json:"dependsOnly"`
	View        string `json:"view"`
}

type graphReader interface {
	Graph(context.Context, model.Principal, string, string) (model.TaskGraph, error)
}

type graphNode struct {
	ID                string              `json:"id"`
	TitlePreview      string              `json:"titlePreview"`
	TitleTruncated    bool                `json:"titleTruncated"`
	Status            model.TaskStatus    `json:"status"`
	DependsOn         []string            `json:"dependsOn"`
	ExternalDependsOn []string            `json:"externalDependsOn"`
	BlockedBy         []string            `json:"blockedBy"`
	RequiredPlatform  *model.TaskPlatform `json:"requiredPlatform"`
	AssignedTo        *string             `json:"assignedTo"`
	AllowAgents       bool                `json:"allowAgents"`
	Ready             bool                `json:"ready"`
	CreatedAt         time.Time           `json:"createdAt"`
	UpdatedAt         time.Time           `json:"updatedAt"`
	StartedAt         *time.Time          `json:"startedAt"`
	CompletedAt       *time.Time          `json:"completedAt"`
	CancelledAt       *time.Time          `json:"cancelledAt"`
}

type graphData struct {
	Projection    string              `json:"projection"`
	Project       Project             `json:"project"`
	ObservedAt    time.Time           `json:"observedAt"`
	Summary       graphSummary        `json:"summary"`
	Tasks         []any               `json:"tasks"`
	Truncated     bool                `json:"truncated,omitempty"`
	ReturnedNodes int                 `json:"returnedNodes"`
	TotalNodes    int                 `json:"totalNodes"`
	ReadFull      *graphFullReference `json:"readFull,omitempty"`
}

type graphFullReference struct {
	Tool      string     `json:"tool"`
	Arguments graphInput `json:"arguments"`
}

type graphSummary struct {
	Total      int64 `json:"total"`
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
	graph, err := reader.Graph(ctx, actor.Principal, in.ProjectID, in.TaskID)
	if err != nil {
		var fault *model.Fault
		if errors.As(err, &fault) && fault.GraphLimit != nil {
			limit := fault.GraphLimit
			return ToolResult{Refs: map[string]any{"nodeCount": limit.NodeCount, "edgeCount": limit.EdgeCount, "maxNodes": limit.MaxNodes, "maxEdges": limit.MaxEdges}}, err
		}
		return ToolResult{}, err
	}
	view := in.View
	if view == "" {
		view = "summary"
	}
	s := graph.Summary
	result := graphData{Projection: view, Project: MapProject(graph.Project), ObservedAt: graph.ObservedAt.UTC(),
		Summary: graphSummary{Total: s.Total, Todo: s.Todo, InProgress: s.InProgress, Done: s.Done, Cancelled: s.Cancelled, Ready: s.Ready, Blocked: s.Blocked},
		Tasks:   make([]any, 0, len(graph.Tasks)), ReturnedNodes: len(graph.Tasks), TotalNodes: len(graph.Tasks)}
	if view == "summary" {
		result.Truncated = true
		result.TotalNodes = len(graph.Tasks)
		result.ReadFull = &graphFullReference{Tool: "task_graph", Arguments: graphInput{ProjectID: in.ProjectID, TaskID: in.TaskID, DependsOnly: in.DependsOnly, View: "full"}}
	}
	for _, task := range graph.Tasks {
		deps := append([]string{}, task.DependsOn...)
		ext := append([]string{}, task.ExternalDependsOn...)
		var item any
		if in.DependsOnly {
			item = dependencyNode{task.ID, deps, ext}
		} else {
			item = graphNode{ID: task.ID, TitlePreview: task.TitlePreview, TitleTruncated: task.TitleTruncated, Status: task.Status,
				DependsOn: deps, ExternalDependsOn: ext, BlockedBy: append([]string{}, task.BlockedBy...),
				RequiredPlatform: task.RequiredPlatform, AssignedTo: task.AssignedTo, AllowAgents: task.AllowAgents, Ready: task.Ready,
				CreatedAt: task.CreatedAt.UTC(), UpdatedAt: task.UpdatedAt.UTC(), StartedAt: utcTime(task.StartedAt), CompletedAt: utcTime(task.CompletedAt), CancelledAt: utcTime(task.CancelledAt)}
		}
		if view == "summary" {
			encodedItem, err := json.Marshal(item)
			if err != nil {
				return ToolResult{}, err
			}
			// Measure the exact envelope overhead, reserving room for explicit truncation metadata.
			result.ReturnedNodes = len(result.Tasks) + 1
			base, err := json.Marshal(envelope{Data: result, Meta: &envelopeMeta{RequestID: actor.RequestID}})
			if err != nil {
				return ToolResult{}, err
			}
			// base currently contains prior nodes; use its actual size and the new separator.
			extra := len(encodedItem)
			if len(result.Tasks) > 0 {
				extra++
			}
			if len(base)+extra > 16<<10 {
				result.ReturnedNodes = len(result.Tasks)
				break
			}
		}
		result.Tasks = append(result.Tasks, item)
	}
	if view == "summary" && len(result.Tasks) == len(graph.Tasks) {
		result.Truncated = false
		result.ReturnedNodes = len(result.Tasks)
		result.TotalNodes = len(graph.Tasks)
		result.ReadFull = nil
	}
	if view == "summary" {
		encoded, err := json.Marshal(envelope{Data: result, Meta: &envelopeMeta{RequestID: actor.RequestID}})
		if err != nil {
			return ToolResult{}, err
		}
		if len(encoded) > 16<<10 {
			return ToolResult{Refs: map[string]any{"projectId": in.ProjectID, "taskId": in.TaskID, "view": "full"}}, &model.Fault{Code: "payload_too_large", Message: "The graph summary exceeds the output budget; request view full to read it."}
		}
	}
	return ToolResult{Data: result}, nil
}
