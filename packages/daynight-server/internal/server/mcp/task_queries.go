package mcp

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed task_queries.json
var taskQueryToolDefinitions []byte

type taskQueryService interface {
	graphReader
	MCPList(context.Context, model.Principal, string, taskcore.MCPListRequest, func(store.TaskPriorityItem, string, bool) bool) error
	MCPReady(context.Context, model.Principal, string, taskcore.MCPReadyRequest) ([]store.TaskPriorityItem, error)
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
func RegisterTaskQueryTools(entry *Entry, tasks *taskservice.Tasks) error {
	return registerTaskQueryTools(entry, tasks)
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
	var itemErr error
	err := tasks.MCPList(ctx, actor.Principal, in.ProjectID, taskcore.MCPListRequest{All: in.All, Status: in.Status, AssignedTo: in.AssignedTo, Ready: in.Ready, AllowAgents: in.AllowAgents, CompatiblePlatform: in.CompatiblePlatform, Limit: in.Limit, Cursor: in.Cursor, View: in.View}, func(value store.TaskPriorityItem, cursor string, more bool) bool {
		task := value.Task
		var item any
		if in.View == "summary" {
			summary := MapTaskSummary(task)
			summary.BlockedByCount = value.BlockedByCount
			summary.TitleTruncated = summary.TitleTruncated || value.TitleTruncated
			item = summary
		} else {
			item = taskListFull{TaskFull: MapTaskFull(task)}
		}
		encodedItem, err := json.Marshal(item)
		if err != nil {
			itemErr = err
			return false
		}
		data.Items = append(data.Items, encodedItem)
		data.NextCursor = nil
		if more {
			data.NextCursor = &cursor
		}
		return true
	})
	if err != nil {
		return ToolResult{}, err
	}
	if itemErr != nil {
		return ToolResult{}, itemErr
	}
	return ToolResult{Data: data}, nil
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
