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
	ReadAdmitted(context.Context, mcptransfer.Actor, mcpdownload.Input, func(context.Context) error) (map[string]any, error)
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
		if input.Action == "" || input.Action == "inspect" {
			return BudgetContent
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
		principal := mcptransfer.Actor{Principal: actor.Principal, AuthorityKind: actor.AuthorityRef.Kind, AuthorityID: actor.AuthorityRef.ID}
		var result map[string]any
		var err error
		if input.Action == "open" {
			if actor.admitContent == nil {
				return ToolResult{}, errors.New("content admission unavailable")
			}
			result, err = downloads.ReadAdmitted(ctx, principal, input, actor.admitContent)
		} else {
			result, err = downloads.Read(ctx, principal, input)
		}
		if err != nil {
			refs := map[string]any{"projectId": input.ProjectID, "taskId": input.TaskID}
			if input.TransferID != "" {
				refs["transferId"] = input.TransferID
			}
			return ToolResult{Refs: refs}, err
		}
		return ToolResult{Data: result}, nil
	})
}
