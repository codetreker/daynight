package mcp

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed task_queries.json
var taskQueryToolDefinitions []byte

type taskQueryService interface {
	graphReader
	ObservedMCPList(context.Context, model.Principal, string, taskcore.MCPListRequest) (taskservice.ObservedMCPPage, error)
	MCPReady(context.Context, model.Principal, string, taskcore.MCPReadyRequest) ([]store.TaskPriorityItem, error)
}

type taskQueryObservations interface {
	ObservedMCPList(context.Context, model.Principal, string, taskcore.MCPListRequest) (taskservice.ObservedMCPPage, error)
	ObserveGraph(context.Context, model.Principal, string, string) (taskservice.ObservedGraph, error)
}

type listInput struct {
	ProjectID          string              `json:"projectId"`
	Limit              int                 `json:"limit"`
	Cursor             *string             `json:"cursor"`
	All                bool                `json:"all"`
	Status             *model.TaskStatus   `json:"status"`
	AssignedTo         *string             `json:"assignedTo"`
	Ready              *bool               `json:"ready"`
	AllowAgents        *bool               `json:"allowAgents"`
	CompatiblePlatform *model.TaskPlatform `json:"compatiblePlatform"`
	View               string              `json:"view"`
}

type readyInput struct {
	ProjectID          string              `json:"projectId"`
	Limit              int                 `json:"limit"`
	AllowAgents        *bool               `json:"allowAgents"`
	CompatiblePlatform *model.TaskPlatform `json:"compatiblePlatform"`
	View               string              `json:"view"`
}

type listData struct {
	Items      []json.RawMessage `json:"items"`
	NextCursor *string           `json:"nextCursor"`
	Projection string            `json:"projection"`
}

type readyData struct {
	Items      []any  `json:"items"`
	Projection string `json:"projection"`
}

type taskListFull struct {
	TaskFull
	Description *string `json:"description,omitempty"`
}

// RegisterTaskQueryTools publishes only fully implemented task query tools.
func RegisterTaskQueryTools(entry *Entry, tasks *taskservice.Tasks, observations taskQueryObservations) error {
	return registerTaskQueryTools(entry, struct {
		*taskservice.Tasks
		taskQueryObservations
	}{tasks, observations})
}

func registerTaskQueryTools(entry *Entry, tasks taskQueryService) error {
	var definitions []sdk.Tool
	if err := json.Unmarshal(taskQueryToolDefinitions, &definitions); err != nil {
		return err
	}
	if len(definitions) != 3 {
		return fmt.Errorf("invalid task tool definitions")
	}
	for i := range definitions {
		tool := &definitions[i]
		var err error
		switch tool.Name {
		case "task_list":
			err = registerTaskListTool(entry, tool, func(ctx context.Context, actor RequestActor, raw json.RawMessage) (ToolResult, error) {
				var in listInput
				if err := json.Unmarshal(raw, &in); err != nil {
					return ToolResult{}, &model.Fault{Code: "invalid_input", Message: "Tool arguments could not be decoded."}
				}
				return listTool(ctx, actor, in, tasks)
			})
		case "task_ready":
			err = registerTaskListTool(entry, tool, func(ctx context.Context, actor RequestActor, raw json.RawMessage) (ToolResult, error) {
				var in readyInput
				if err := json.Unmarshal(raw, &in); err != nil {
					return ToolResult{}, &model.Fault{Code: "invalid_input", Message: "Tool arguments could not be decoded."}
				}
				return readyTool(ctx, actor, in, tasks)
			})
		case "task_graph":
			err = entry.registerReadTool(tool, func(json.RawMessage) BudgetClass { return BudgetControl }, func(ctx context.Context, actor RequestActor, raw json.RawMessage) (ToolResult, error) {
				var in graphInput
				if err := json.Unmarshal(raw, &in); err != nil {
					return ToolResult{}, &model.Fault{Code: "invalid_input", Message: "Tool arguments could not be decoded."}
				}
				return graphTool(ctx, actor, in, tasks)
			})
		default:
			return fmt.Errorf("unexpected task tool %q", tool.Name)
		}
		if err != nil {
			return fmt.Errorf("register %s: %w", tool.Name, err)
		}
	}
	return nil
}

// Full queries acquire the large-object permit before materializing task resources.
func registerTaskListTool(entry *Entry, tool *sdk.Tool, handler ToolHandler) error {
	return entry.registerReadTool(tool, func(raw json.RawMessage) BudgetClass {
		var input struct {
			View string `json:"view"`
		}
		_ = json.Unmarshal(raw, &input)
		if input.View == "full" {
			return BudgetLarge
		}
		return BudgetControl
	}, handler)
}

func listTool(ctx context.Context, actor RequestActor, in listInput, tasks taskQueryService) (ToolResult, error) {
	if in.View == "" {
		in.View = "summary"
	}
	if in.Limit == 0 {
		in.Limit = 50
	}
	data := listData{Items: make([]json.RawMessage, 0, in.Limit), Projection: in.View}
	page, err := tasks.ObservedMCPList(ctx, actor.Principal, in.ProjectID, taskcore.MCPListRequest{All: in.All, Status: in.Status, AssignedTo: in.AssignedTo, Ready: in.Ready, AllowAgents: in.AllowAgents, CompatiblePlatform: in.CompatiblePlatform, Limit: in.Limit, Cursor: in.Cursor, View: in.View})
	if err != nil {
		return ToolResult{}, err
	}
	for _, value := range page.Items {
		task := value.Item.Task
		var item any
		if in.View == "summary" {
			summary := MapTaskSummary(task)
			summary.BlockedByCount = value.Item.BlockedByCount
			summary.TitleTruncated = summary.TitleTruncated || value.Item.TitleTruncated
			item = struct {
				TaskSummary
				Session sp.TaskSessionObservation `json:"session"`
			}{summary, value.Session}
		} else {
			item = struct {
				taskListFull
				Session sp.TaskSessionObservation `json:"session"`
			}{taskListFull{TaskFull: MapTaskFull(task)}, value.Session}
		}
		encoded, err := json.Marshal(item)
		if err != nil {
			return ToolResult{}, err
		}
		data.Items = append(data.Items, encoded)
	}
	data.NextCursor = page.NextCursor
	return ToolResult{Data: data, Observation: &ReadObservation{ObservedAt: page.ObservedAt, Partial: page.Partial}, Refs: map[string]any{"projectId": in.ProjectID}}, nil
}

func readyTool(ctx context.Context, actor RequestActor, in readyInput, tasks taskQueryService) (ToolResult, error) {
	if in.View == "" {
		in.View = "summary"
	}
	if in.Limit == 0 {
		in.Limit = 5
	}
	items, err := tasks.MCPReady(ctx, actor.Principal, in.ProjectID, taskcore.MCPReadyRequest{
		Limit: in.Limit, AllowAgents: in.AllowAgents, CompatiblePlatform: in.CompatiblePlatform, View: in.View,
	})
	if err != nil {
		return ToolResult{}, err
	}
	data := readyData{Items: make([]any, 0, len(items)), Projection: in.View}
	for _, item := range items {
		if in.View == "full" {
			data.Items = append(data.Items, MapTaskFull(item.Task))
		} else {
			summary := MapTaskSummary(item.Task)
			summary.BlockedByCount = item.BlockedByCount
			summary.TitleTruncated = summary.TitleTruncated || item.TitleTruncated
			data.Items = append(data.Items, summary)
		}
	}
	return ToolResult{Data: data}, nil
}
