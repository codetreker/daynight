package mcp

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed task_search.json
var taskSearchToolDefinition []byte

// TaskSearchOperation is the same read-only search used by the HTTP adapter.
type TaskSearchOperation func(context.Context, model.Principal, string, tasksearch.Request) (tasksearch.Page, error)

type searchInput struct {
	tagFilterInput
	ProjectID          string              `json:"projectId"`
	Query              string              `json:"query"`
	Type               model.TaskType      `json:"type"`
	ParentID           *string             `json:"parentId"`
	AssignedTo         *string             `json:"assignedTo"`
	Status             *model.TaskStatus   `json:"status"`
	Ready              *bool               `json:"ready"`
	AllowAgents        *bool               `json:"allowAgents"`
	CompatiblePlatform *model.TaskPlatform `json:"compatiblePlatform"`
	Limit              int                 `json:"limit"`
	Cursor             *string             `json:"cursor"`
}

type searchItem struct {
	ID        string                          `json:"id"`
	Type      model.TaskType                  `json:"type"`
	ParentID  *string                         `json:"parentId"`
	ProjectID string                          `json:"projectId"`
	Title     string                          `json:"title"`
	Status    model.TaskStatus                `json:"status"`
	Context   *tasksearch.Context             `json:"context"`
	Match     tasksearch.Match                `json:"match"`
	Tags      []taskprotocol.RESTTagReference `json:"tags"`
}

type searchData struct {
	ProjectID  string       `json:"projectId"`
	Total      int64        `json:"total"`
	Items      []searchItem `json:"items"`
	NextCursor *string      `json:"nextCursor"`
}

// RegisterTaskSearchTool exposes the shared ranked search through MCP.
func RegisterTaskSearchTool(entry *Entry, search TaskSearchOperation) error {
	if entry == nil || search == nil {
		return fmt.Errorf("task search dependencies are required")
	}
	var tool sdk.Tool
	if err := json.Unmarshal(taskSearchToolDefinition, &tool); err != nil {
		return fmt.Errorf("decode task search tool: %w", err)
	}
	if tool.Name != "task_search" {
		return fmt.Errorf("invalid task search tool definition")
	}
	return entry.registerReadTool(&tool, func(json.RawMessage) BudgetClass { return BudgetControl }, func(ctx context.Context, actor RequestActor, raw json.RawMessage) (ToolResult, error) {
		if err := queryBusinessLimit(raw); err != nil {
			return ToolResult{}, err
		}
		if err := ValidateUnicodeFields(raw, "projectId", "query", "type", "parentId", "assignedTo", "status", "compatiblePlatform", "tagIds", "tagMatch", "cursor"); err != nil {
			return ToolResult{}, err
		}
		var in searchInput
		if err := json.Unmarshal(raw, &in); err != nil {
			return ToolResult{}, &model.Fault{Code: "invalid_input", Message: "Tool arguments could not be decoded."}
		}
		in.ParentID = queryParent(raw, in.ParentID)
		if in.Limit == 0 {
			in.Limit = 50
		}
		operation, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		page, err := search(operation, actor.Principal, in.ProjectID, tasksearch.Request{
			TagFilter: in.filter(), Type: in.Type, Parent: in.ParentID, Query: in.Query,
			AssignedTo: in.AssignedTo, Status: in.Status, Ready: in.Ready, AllowAgents: in.AllowAgents,
			CompatiblePlatform: in.CompatiblePlatform, Limit: in.Limit, Cursor: in.Cursor,
		})
		if err != nil {
			return ToolResult{}, searchCompletionError(ctx, operation, err)
		}
		data := searchData{ProjectID: page.ProjectID, Total: page.Total, Items: make([]searchItem, 0, len(page.Items)), NextCursor: page.NextCursor}
		for _, item := range page.Items {
			data.Items = append(data.Items, searchItem{ID: item.ID, Type: item.Type, ParentID: item.ParentID,
				ProjectID: item.ProjectID, Title: item.Title, Status: item.Status, Context: item.Context,
				Match: item.Match, Tags: taskprotocol.RESTTags(item.Tags)})
		}
		encoded, err := json.Marshal(data)
		if err == nil {
			err = operation.Err()
		}
		if err != nil {
			return ToolResult{}, searchCompletionError(ctx, operation, err)
		}
		return ToolResult{Data: json.RawMessage(encoded)}, nil
	})
}

// A timeout must not conceal a failed transaction completion or caller cancellation.
func searchCompletionError(caller, operation context.Context, err error) error {
	var transaction *store.TransactionError
	transactionFailed := errors.As(err, &transaction) && (transaction.Phase != "operation" || transaction.CleanupFailed || transaction.Outcome != store.TransactionNotCommitted)
	if !transactionFailed && caller.Err() == nil && errors.Is(operation.Err(), context.DeadlineExceeded) && errors.Is(err, context.DeadlineExceeded) {
		return &model.Fault{Code: "search_timeout", Message: "Search timed out.", Cause: err}
	}
	return err
}
