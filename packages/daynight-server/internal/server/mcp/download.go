package mcp

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed download_tools.json
var downloadToolsJSON []byte

type downloadReader interface {
	Read(context.Context, mcptransfer.Actor, mcpdownload.Input) (map[string]any, error)
}

// RegisterDownloadTool exposes authorized attachment snapshots to MCP.
func RegisterDownloadTool(e *Entry, downloads downloadReader) error {
	if downloads == nil {
		return errors.New("download service is required")
	}
	var definitions []*sdk.Tool
	if err := json.Unmarshal(downloadToolsJSON, &definitions); err != nil {
		return fmt.Errorf("decode download tool: %w", err)
	}
	if len(definitions) != 1 || definitions[0].Name != "task_attachment_read" {
		return errors.New("invalid download tool definition")
	}
	return e.registerReadTool(definitions[0], func(raw json.RawMessage) BudgetClass {
		var input struct {
			Action string `json:"action"`
		}
		_ = json.Unmarshal(raw, &input)
		if input.Action == "inline" || input.Action == "chunk" {
			return BudgetLarge
		}
		return BudgetControl
	}, func(ctx context.Context, actor RequestActor, raw json.RawMessage) (ToolResult, error) {
		if err := ValidateUnicodeFields(raw, "projectId", "taskId", "path", "action", "transferId", "offset", "format"); err != nil {
			return ToolResult{}, err
		}
		var input mcpdownload.Input
		if err := json.Unmarshal(raw, &input); err != nil {
			return ToolResult{}, &model.Fault{Code: "invalid_input", Message: "Tool arguments could not be decoded."}
		}
		if len(input.Path) > 4096 {
			return ToolResult{}, &model.Fault{Code: "invalid_input", Message: "Attachment path exceeds the MCP read limit."}
		}
		result, err := downloads.Read(ctx, mcptransfer.Actor{Principal: actor.Principal, AuthorityKind: actor.AuthorityRef.Kind, AuthorityID: actor.AuthorityRef.ID}, input)
		if err != nil {
			refs := map[string]any{"projectId": input.ProjectID, "taskId": input.TaskID}
			if input.TransferID != "" {
				refs["transferId"] = input.TransferID
			}
			return ToolResult{Refs: refs}, err
		}
		if input.Action == "" || input.Action == "inspect" || input.Action == "open" {
			encoded, err := json.Marshal(envelope{Data: result, Meta: &envelopeMeta{RequestID: actor.RequestID}})
			if err != nil {
				return ToolResult{}, err
			}
			if len(encoded) > 16<<10 {
				refs := map[string]any{"projectId": input.ProjectID, "taskId": input.TaskID}
				if input.TransferID != "" {
					refs["transferId"] = input.TransferID
				}
				return ToolResult{Refs: refs}, &model.Fault{Code: "payload_too_large", Message: "Attachment metadata exceeds the MCP response limit."}
			}
		}
		return ToolResult{Data: result}, nil
	})
}
