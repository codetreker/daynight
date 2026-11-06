package mcp

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed thread_tools.json
var threadToolsJSON []byte

type threadOperations interface {
	List(context.Context, model.Principal, string, string, taskservice.ThreadListRequest) (taskservice.ThreadPageDocument, error)
	Post(context.Context, model.Principal, string, string, taskservice.CreateThreadMessage) (taskservice.ThreadMessageDocument, error)
}

type threadTools struct{ threads threadOperations }

type threadReadInput struct {
	ProjectID string  `json:"projectId"`
	TaskID    string  `json:"taskId"`
	BeforeID  *string `json:"beforeId"`
	AfterID   *string `json:"afterId"`
	Count     *int    `json:"count"`
	Details   bool    `json:"details"`
}

type threadPostInput struct {
	ProjectID string  `json:"projectId"`
	TaskID    string  `json:"taskId"`
	Body      string  `json:"body"`
	ReplyTo   *string `json:"replyTo"`
	ClaimID   *string `json:"claimId"`
}

// RegisterThreadTools exposes complete Thread operations through the MCP wrapper.
func RegisterThreadTools(e *Entry, threads threadOperations) error {
	var tools []*sdk.Tool
	if err := json.Unmarshal(threadToolsJSON, &tools); err != nil {
		return fmt.Errorf("decode Thread tools: %w", err)
	}
	byName := make(map[string]*sdk.Tool, len(tools))
	for _, tool := range tools {
		byName[tool.Name] = tool
	}
	h := &threadTools{threads: threads}
	if err := RegisterTypedTool(e, byName["task_thread_read"], BudgetControl, h.read, "projectId", "taskId", "beforeId", "afterId"); err != nil {
		return err
	}
	return RegisterTypedTool(e, byName["task_thread_post"], BudgetControl, h.post, "projectId", "taskId", "body", "replyTo", "claimId")
}

func (h *threadTools) read(ctx context.Context, actor RequestActor, in threadReadInput) (ToolResult, error) {
	count := 20
	if in.Count != nil {
		count = *in.Count
	}
	refs := map[string]any{"projectId": in.ProjectID, "taskId": in.TaskID}
	doc, err := h.threads.List(ctx, actor.Principal, in.ProjectID, in.TaskID, taskservice.ThreadListRequest{BeforeID: in.BeforeID, AfterID: in.AfterID, Count: count, Details: in.Details})
	if err != nil {
		return ToolResult{Refs: refs}, err
	}
	return ToolResult{Data: json.RawMessage(doc.JSON), Refs: refs}, nil
}

func (h *threadTools) post(ctx context.Context, actor RequestActor, in threadPostInput) (ToolResult, error) {
	refs := map[string]any{"projectId": in.ProjectID, "taskId": in.TaskID}
	if in.ReplyTo != nil {
		refs["replyTo"] = *in.ReplyTo
	}
	if in.ClaimID != nil {
		refs["claimId"] = *in.ClaimID
	}
	if threadPostBodySize(in) > httpx.MaxJSONBody {
		return ToolResult{Refs: refs}, &model.Fault{Code: "invalid_input", Message: "Request body must be valid JSON within the 1 MiB limit."}
	}
	doc, err := h.threads.Post(ctx, actor.Principal, in.ProjectID, in.TaskID, taskservice.CreateThreadMessage{Body: in.Body, ReplyTo: in.ReplyTo, ClaimID: in.ClaimID})
	if err != nil {
		var failed *taskservice.ThreadMessageError
		if errors.As(err, &failed) && failed.MessageID != "" {
			refs["candidateMessageId"] = failed.MessageID
		}
		return ToolResult{Refs: refs}, err
	}
	refs["messageId"] = doc.Message.ID
	return ToolResult{Data: json.RawMessage(doc.JSON), Outcome: "changed", WriteOutcome: "confirmed", Refs: refs}, nil
}

// threadPostBodySize counts the UTF-8 bytes of the equivalent REST JSON body.
// JSON.stringify escapes controls and quotes but does not escape HTML characters.
func threadPostBodySize(in threadPostInput) int {
	size := len(`{"body":}`) + threadJSONStringSize(in.Body)
	if in.ReplyTo != nil {
		size += len(`,"replyTo":`) + threadJSONStringSize(*in.ReplyTo)
	}
	if in.ClaimID != nil {
		size += len(`,"claimId":`) + threadJSONStringSize(*in.ClaimID)
	}
	return size
}

func threadJSONStringSize(value string) int {
	size := 2
	for i := 0; i < len(value); i++ {
		switch value[i] {
		case '"', '\\', '\b', '\f', '\n', '\r', '\t':
			size += 2
		default:
			if value[i] < 0x20 {
				size += 6
			} else {
				size++
			}
		}
	}
	return size
}
