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
	Next       *listContinuation `json:"next,omitempty"`
}

type listContinuation struct {
	Tool            string         `json:"tool"`
	Arguments       map[string]any `json:"arguments"`
	FullItemsNotice string         `json:"fullItemsNotice,omitempty"`
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
				return listTool(ctx, actor, in, tasks, false)
			})
		case "task_ready":
			err = registerTaskListTool(entry, tool, func(ctx context.Context, actor RequestActor, raw json.RawMessage) (ToolResult, error) {
				var in readyInput
				if err := json.Unmarshal(raw, &in); err != nil {
					return ToolResult{}, &model.Fault{Code: "invalid_input", Message: "Tool arguments could not be decoded."}
				}
				status, ready := model.TaskTodo, true
				return listTool(ctx, actor, listInput{ProjectID: in.ProjectID, Limit: in.Limit, Status: &status, Ready: &ready, AllowAgents: in.AllowAgents, CompatiblePlatform: in.CompatiblePlatform, View: in.View}, tasks, true)
			})
		case "task_graph":
			err = RegisterTypedTool(entry, tool, BudgetControl, func(ctx context.Context, actor RequestActor, in graphInput) (ToolResult, error) {
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

// Summary queries use bounded DAO projections; full queries materialize one
// complete task at a time under the large-object permit.
func registerTaskListTool(entry *Entry, tool *sdk.Tool, handler ToolHandler) error {
	return entry.registerTool(tool, func(raw json.RawMessage) BudgetClass {
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

func listTool(ctx context.Context, actor RequestActor, in listInput, tasks taskQueryService, readyTool bool) (ToolResult, error) {
	budget := 128 << 20
	if in.View == "" || in.View == "summary" {
		budget = 16 << 10
	}
	return listToolWithBudget(ctx, actor, in, tasks, readyTool, budget)
}

func listToolWithBudget(ctx context.Context, actor RequestActor, in listInput, tasks taskQueryService, readyTool bool, budget int) (ToolResult, error) {
	if in.View == "" {
		in.View = "summary"
	}
	if in.Limit == 0 {
		if readyTool {
			in.Limit = 10
		} else {
			in.Limit = 50
		}
	}
	data := listData{Items: make([]json.RawMessage, 0, in.Limit), Projection: in.View}
	totalItemBytes := 0
	var itemErr error
	var failure ToolResult
	err := tasks.MCPList(ctx, actor.Principal, in.ProjectID, taskcore.MCPListRequest{All: in.All, Status: in.Status, AssignedTo: in.AssignedTo, Ready: in.Ready, AllowAgents: in.AllowAgents, CompatiblePlatform: in.CompatiblePlatform, Limit: in.Limit, Cursor: in.Cursor, View: in.View}, func(value store.TaskPriorityItem, cursor string, more bool) bool {
		task := value.Task
		var item any
		if in.View == "summary" {
			summary := MapTaskSummary(task)
			summary.BlockedByCount = value.BlockedByCount
			summary.TitleTruncated = summary.TitleTruncated || value.TitleTruncated
			item = summary
		} else if readyTool {
			item = MapTaskFull(task)
		} else {
			item = taskListFull{TaskFull: MapTaskFull(task)}
		}
		encodedItem, err := json.Marshal(item)
		if err != nil {
			itemErr = err
			return false
		}
		candidate := listData{Items: []json.RawMessage{}, Projection: in.View}
		if more {
			candidate.NextCursor = &cursor
			if readyTool {
				args := map[string]any{"projectId": in.ProjectID, "status": "todo", "ready": true, "view": in.View, "cursor": cursor}
				if in.AllowAgents != nil {
					args["allowAgents"] = *in.AllowAgents
				}
				if in.CompatiblePlatform != nil {
					args["compatiblePlatform"] = *in.CompatiblePlatform
				}
				candidate.Next = &listContinuation{Tool: "task_list", Arguments: args}
				if in.View == "full" {
					candidate.Next.FullItemsNotice = "task_list full omits descriptions; use task_show with view full for each complete Task."
				}
			}
		}
		base, err := json.Marshal(envelope{Data: candidate, Meta: &envelopeMeta{RequestID: actor.RequestID}})
		if err != nil {
			itemErr = err
			return false
		}
		n := len(data.Items) + 1
		size := len(base) + totalItemBytes + len(encodedItem) + n - 1
		if size > budget {
			if len(data.Items) == 0 {
				failure.Refs = map[string]any{"projectId": in.ProjectID, "taskId": task.ID, "readWith": "task_show", "view": "full"}
				itemErr = &model.Fault{Code: "payload_too_large", Message: "The first task exceeds the output budget; read it with task_show view full."}
			}
			return false
		}
		totalItemBytes += len(encodedItem)
		data.Items = append(data.Items, encodedItem)
		data.NextCursor, data.Next = candidate.NextCursor, candidate.Next
		return true
	})
	if err != nil {
		return ToolResult{}, err
	}
	if itemErr != nil {
		return failure, itemErr
	}
	return ToolResult{Data: data}, nil
}
