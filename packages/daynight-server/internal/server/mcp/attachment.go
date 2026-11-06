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
	ListBounded(context.Context, model.Principal, string, string, model.PageRequest, int) (attachmentcore.Page, error)
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
			// Legacy paths can exceed the current write limit.
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
	page, err := attachments.ListBounded(ctx, actor.Principal, project, task, model.PageRequest{Limit: limit, Cursor: input.Cursor}, 8192)
	if err != nil {
		return ToolResult{}, err
	}
	if len(page.Items) > 0 && len(page.Oversized) > 0 && page.Oversized[0] && page.Items[0].Path == "" {
		// Re-read at most one item under the large permit. The cursor is applied
		// again in a new snapshot, so a changed first row becomes the observation.
		page, err = attachments.ListBounded(ctx, actor.Principal, project, task, model.PageRequest{Limit: 1, Cursor: input.Cursor}, 4<<20)
		if err != nil {
			return ToolResult{}, err
		}
	}
	result := attachmentPage{Items: make([]attachmentWire, 0, len(page.Items))}
	base, err := json.Marshal(envelope{Data: result, Meta: &envelopeMeta{RequestID: actor.RequestID}})
	if err != nil {
		return ToolResult{}, err
	}
	itemBytes := 0
	for i, item := range page.Items {
		if i < len(page.Oversized) && page.Oversized[i] {
			if i == 0 {
				return oversizedAttachment(actor, project, task, item)
			}
			break
		}
		wire := attachmentWire{item.Path, item.ContentType, Decimal(item.SizeBytes), item.CreatedAt.UTC(), item.UpdatedAt.UTC()}
		encoded, err := json.Marshal(wire)
		if err != nil {
			return ToolResult{}, err
		}
		candidateBytes := itemBytes + len(encoded)
		if i > 0 {
			candidateBytes++
		}
		var cursor *string
		if i < len(page.Items)-1 || page.NextCursor != nil {
			trimmed, err := attachmentcore.MakePage(store.AttachmentPage{Items: page.Items[:i+1], HasMore: true}, project, task)
			if err != nil {
				return ToolResult{}, err
			}
			cursor = trimmed.NextCursor
		}
		cursorJSON, err := json.Marshal(cursor)
		if err != nil {
			return ToolResult{}, err
		}
		// The empty page already contains nextCursor:null and [] for items.
		if len(base)+candidateBytes+len(cursorJSON)-len("null") > 16<<10 {
			if i == 0 {
				return oversizedAttachment(actor, project, task, item)
			}
			break
		}
		result.Items = append(result.Items, wire)
		result.NextCursor = cursor
		itemBytes = candidateBytes
	}
	return ToolResult{Data: result}, nil
}

func oversizedAttachment(actor RequestActor, project, task string, item model.Attachment) (ToolResult, error) {
	refs := map[string]any{"projectId": project, "taskId": task}
	if item.Path == "" {
		return ToolResult{Refs: refs}, &model.Fault{Code: "resource_conflict", Message: "Attachment path exceeds the MCP input limit and cannot be referenced by this tool."}
	}
	continuation, err := attachmentcore.MakePage(store.AttachmentPage{Items: []model.Attachment{item}, HasMore: true}, project, task)
	if err != nil {
		return ToolResult{}, err
	}
	refs["path"], refs["readTool"], refs["nextCursor"] = item.Path, "task_attachment_read", continuation.NextCursor
	return ToolResult{Refs: refs}, &model.Fault{Code: "resource_conflict", Message: "Attachment exceeds the page budget; inspect it and continue with nextCursor."}
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
