package mcp

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"

	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed upload_tools.json
var uploadToolsJSON []byte

type uploadOperations interface {
	Execute(context.Context, transfer.Actor, string, string, mcptransfer.UploadInput) (map[string]any, error)
}

type uploadArguments struct {
	ProjectID     string `json:"projectId"`
	TaskID        string `json:"taskId"`
	Action        string `json:"action"`
	Path          string `json:"path"`
	ContentType   string `json:"contentType"`
	TransferID    string `json:"transferId"`
	ChunkID       string `json:"chunkId"`
	Offset        string `json:"offset"`
	ContentBase64 string `json:"contentBase64"`
	SHA256        string `json:"sha256"`
	TotalBytes    string `json:"totalBytes"`
}

// RegisterUploadTools registers the complete attachment upload lifecycle.
func RegisterUploadTools(e *Entry, uploads uploadOperations) error {
	if uploads == nil {
		return errors.New("upload service is required")
	}
	var definitions []*sdk.Tool
	if err := json.Unmarshal(uploadToolsJSON, &definitions); err != nil {
		return fmt.Errorf("decode upload tool: %w", err)
	}
	if len(definitions) != 1 || definitions[0] == nil || definitions[0].Name != "task_attachment_put" {
		return errors.New("invalid upload tool definition")
	}
	handler := typedToolHandler(func(ctx context.Context, actor RequestActor, in uploadArguments) (ToolResult, error) {
		data, err := uploads.Execute(ctx, transfer.Actor{Principal: actor.Principal, AuthorityKind: actor.AuthorityRef.Kind, AuthorityID: actor.AuthorityRef.ID}, in.ProjectID, in.TaskID, mcptransfer.UploadInput{
			Action: in.Action, Path: in.Path, ContentType: in.ContentType, TransferID: in.TransferID,
			ChunkID: in.ChunkID, Offset: in.Offset, ContentBase64: in.ContentBase64, SHA256: in.SHA256, TotalBytes: in.TotalBytes,
		})
		refs := map[string]any{"projectId": in.ProjectID, "taskId": in.TaskID}
		// Only returned facts can identify an accepted operation. Input IDs are
		// included to let clients reconcile a lost or uncertain response.
		if in.TransferID != "" {
			refs["transferId"] = in.TransferID
		}
		if in.Path != "" {
			refs["path"] = in.Path
		}
		if in.ChunkID != "" {
			refs["chunkId"] = in.ChunkID
		}
		for _, key := range []string{"transferId", "operationId", "state", "cleanupState", "nextOffset"} {
			if value, ok := data[key]; ok {
				refs[key] = value
			}
		}
		outcome, _ := data["writeOutcome"].(string)
		phase, _ := data["phase"].(string)
		if outcome == "confirmed" {
			for _, key := range []string{"attachment", "created"} {
				if value, ok := data[key]; ok {
					refs[key] = value
				}
			}
		}
		if err != nil {
			return ToolResult{WriteOutcome: outcome, Phase: phase, Refs: refs}, err
		}
		return ToolResult{Data: data, WriteOutcome: outcome, Refs: refs}, nil
	}, "projectId", "taskId", "action", "path", "contentType", "transferId", "chunkId", "offset", "contentBase64", "sha256", "totalBytes")
	// Transfer transactions are distinct from the target attachment write.
	// Only the upload service can classify the latter's outcome.
	return e.registerToolFor(definitions[0], uploadBudget, handler, false)
}

func uploadBudget(raw json.RawMessage) BudgetClass {
	var input struct {
		Action string `json:"action"`
	}
	_ = json.Unmarshal(raw, &input) // The input schema was validated first.
	switch input.Action {
	case "inline", "chunk", "commit":
		return BudgetContent
	default:
		return BudgetControl
	}
}
