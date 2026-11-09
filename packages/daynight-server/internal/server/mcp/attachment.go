package mcp

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed attachment_tools.json
var attachmentToolsJSON []byte

type attachmentOperations interface {
	List(context.Context, model.Principal, string, string, model.PageRequest) (attachmentcore.Page, error)
	Delete(context.Context, model.Principal, string, string, string) error
}

type attachmentInput struct {
	ProjectID string  `json:"projectId"`
	TaskID    string  `json:"taskId"`
	Path      string  `json:"path"`
	Limit     *int    `json:"limit"`
	Cursor    *string `json:"cursor"`
}

type attachmentWire struct {
	Path        string    `json:"path"`
	ContentType string    `json:"contentType"`
	SizeBytes   string    `json:"sizeBytes"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type attachmentPage struct {
	Items      []attachmentWire `json:"items"`
	NextCursor *string          `json:"nextCursor"`
}

// RegisterAttachmentTools exposes the shared attachment use case to MCP.
func RegisterAttachmentTools(e *Entry, attachments attachmentOperations) error {
	if attachments == nil {
		return errors.New("attachment service is required")
	}
	var definitions []*sdk.Tool
	if err := json.Unmarshal(attachmentToolsJSON, &definitions); err != nil {
		return fmt.Errorf("decode attachment tools: %w", err)
	}
	for _, definition := range definitions {
		name := definition.Name
		handler := func(ctx context.Context, actor RequestActor, raw json.RawMessage) (ToolResult, error) {
			if err := ValidateUnicodeFields(raw, "projectId", "taskId", "path", "cursor"); err != nil {
				return ToolResult{}, err
			}
			var input attachmentInput
			if err := json.Unmarshal(raw, &input); err != nil {
				return ToolResult{}, &model.Fault{Code: "invalid_input", Message: "Tool arguments could not be decoded."}
			}
			if name == "task_attachment_list" {
				return listAttachments(ctx, actor, attachments, input)
			}
			return removeAttachment(ctx, actor, attachments, input)
		}
		var err error
		switch name {
		case "task_attachment_list":
			err = e.registerReadTool(definition, func(json.RawMessage) BudgetClass { return BudgetLarge }, handler)
		case "task_attachment_remove":
			err = e.RegisterTool(definition, BudgetControl, handler)
		default:
			return errors.New("unknown attachment tool")
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func listAttachments(ctx context.Context, actor RequestActor, attachments attachmentOperations, input attachmentInput) (ToolResult, error) {
	project, err := model.CanonicalID(input.ProjectID)
	if err != nil {
		return ToolResult{}, err
	}
	task, err := model.CanonicalID(input.TaskID)
	if err != nil {
		return ToolResult{}, err
	}
	limit := 50
	if input.Limit != nil {
		limit = *input.Limit
	}
	page, err := attachments.List(ctx, actor.Principal, project, task, model.PageRequest{Limit: limit, Cursor: input.Cursor})
	if err != nil {
		return ToolResult{}, err
	}
	result := attachmentPage{Items: make([]attachmentWire, 0, len(page.Items)), NextCursor: page.NextCursor}
	for _, item := range page.Items {
		result.Items = append(result.Items, attachmentWire{item.Path, item.ContentType, Decimal(item.SizeBytes), item.CreatedAt.UTC(), item.UpdatedAt.UTC()})
	}
	return ToolResult{Data: result}, nil
}

func removeAttachment(ctx context.Context, actor RequestActor, attachments attachmentOperations, input attachmentInput) (ToolResult, error) {
	address, err := attachmentcore.NewAddress(input.ProjectID, input.TaskID, input.Path)
	if err != nil {
		return ToolResult{WriteOutcome: "not_committed"}, err
	}
	refs := map[string]any{"projectId": address.ProjectID, "taskId": address.TaskID, "path": address.RelativePath}
	if err := attachments.Delete(ctx, actor.Principal, address.ProjectID, address.TaskID, address.RelativePath); err != nil {
		outcome := "not_committed"
		if attachmentservice.FileEffectPossible(err) {
			outcome = "unknown"
			if operation.CompletionFacts(err).Outcome == store.TransactionCommitted {
				outcome = "confirmed"
			}
		}
		return ToolResult{WriteOutcome: outcome, Refs: refs}, err
	}
	return ToolResult{Data: map[string]any{"projectId": address.ProjectID, "taskId": address.TaskID, "path": address.RelativePath, "removed": true}, Outcome: "changed", WriteOutcome: "confirmed", Refs: refs}, nil
}
