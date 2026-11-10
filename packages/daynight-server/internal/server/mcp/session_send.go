package mcp

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed session_send_tools.json
var sessionSendDefinitions []byte

type sessionSendOperations interface {
	Submit(context.Context, model.Principal, string, string, string, sp.Command) (sp.Operation, error)
	TaskOperation(context.Context, model.Principal, string, string, string, string) (sessioncore.TaskOperationResult, error)
}

type sessionOperationInput struct {
	ProjectID   string `json:"projectId"`
	TaskID      string `json:"taskId"`
	SessionID   string `json:"sessionId"`
	OperationID string `json:"operationId"`
}
type sessionSendInput struct {
	sessionOperationInput
	ClaimID             string  `json:"claimId"`
	ExecutionGeneration string  `json:"executionGeneration"`
	ExpectedTurnID      *string `json:"expectedTurnId"`
	Text                string  `json:"text"`
}

func (in sessionOperationInput) refs() map[string]any {
	return map[string]any{"projectId": in.ProjectID, "taskId": in.TaskID, "sessionId": in.SessionID, "operationId": in.OperationID}
}

// SessionSendModule publishes ordinary Task sends and original-operation reads.
// A caller owns its operation ID and recovery. No adapter retries a submission.
func SessionSendModule(service sessionSendOperations) SessionToolModule {
	return func(entry *Entry) error {
		if service == nil {
			return fmt.Errorf("MCP Session send tools require a service")
		}
		var definitions []*sdk.Tool
		if err := json.Unmarshal(sessionSendDefinitions, &definitions); err != nil {
			return err
		}
		for _, tool := range definitions {
			var err error
			switch tool.Name {
			case "task_session_send":
				err = RegisterTypedTool(entry, tool, BudgetContent, func(ctx context.Context, actor RequestActor, in sessionSendInput) (ToolResult, error) {
					return sendTaskSession(ctx, actor, service, in)
				}, "text", "expectedTurnId")
			case "task_session_operation":
				err = registerTypedReadTool(entry, tool, BudgetControl, func(ctx context.Context, actor RequestActor, in sessionOperationInput) (ToolResult, error) {
					result, err := service.TaskOperation(ctx, actor.Principal, in.ProjectID, in.TaskID, in.SessionID, in.OperationID)
					var refusal *model.Fault
					if errors.Is(err, model.ErrNotFound) || errors.As(err, &refusal) && refusal.Code == "not_found" {
						err = &model.Fault{Code: "not_found", Message: "Operation was not found. Its send outcome is unknown; query the original operation ID without resending.", Cause: err}
					}
					return ToolResult{Data: result, Refs: in.refs(), SuccessMetadata: true}, err
				})
			default:
				return fmt.Errorf("unsupported Session send tool %q", tool.Name)
			}
			if err != nil {
				return err
			}
		}
		return nil
	}
}

func sendTaskSession(ctx context.Context, actor RequestActor, service sessionSendOperations, in sessionSendInput) (ToolResult, error) {
	result := ToolResult{SuccessMetadata: true, Refs: in.refs(), WriteOutcome: "not_committed", Phase: "prepare"}
	payload, err := sp.MarshalWire(sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: in.Text}}, ExpectedTurnID: in.ExpectedTurnID})
	if err != nil {
		return result, err
	}
	command := sp.Command{Fence: sp.Fence{SessionID: in.SessionID, ClaimID: in.ClaimID, ExecutionGeneration: in.ExecutionGeneration}, Protocol: sp.Protocol, RequestID: "mcp-" + in.OperationID, OperationID: in.OperationID, Kind: "send_message", Payload: payload}
	raw, err := sp.MarshalWire(command)
	if err == nil && len(raw) <= sp.MaxFrameBytes {
		command, err = sp.DecodeCommand(raw)
	} else if err == nil {
		err = fmt.Errorf("encoded command exceeds limit")
	}
	if err != nil {
		return result, &model.Fault{Code: "invalid_input", Message: "Message text or encoded command is invalid or exceeds its limit.", Cause: err}
	}
	receipt, err := service.Submit(ctx, actor.Principal, in.ProjectID, in.TaskID, in.SessionID, command)
	if err != nil {
		facts := operation.CompletionFacts(err)
		result.Phase = facts.Phase
		if result.Phase == "" {
			result.Phase = "operation"
		}
		switch facts.Outcome {
		case store.TransactionCommitted:
			result.WriteOutcome = "confirmed"
		case store.TransactionNotCommitted:
			result.WriteOutcome = "not_committed"
		default:
			result.WriteOutcome = "unknown"
			if facts.Outcome == "" {
				if _, known := operation.KnownFault(err); known {
					result.WriteOutcome = "not_committed"
				}
			}
		}
		return result, err
	}
	result.Data = map[string]any{"operation": receipt}
	result.WriteOutcome, result.Phase = "confirmed", "commit"
	return result, nil
}
