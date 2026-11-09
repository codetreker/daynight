package mcp

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/taskwork"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed task_work_tool.json
var taskWorkToolDefinition []byte

type taskWorkReader interface {
	WorkList(context.Context, model.Principal, string, taskcore.WorkRequest) (taskwork.Page, error)
}
type workInput struct {
	ProjectID     string  `json:"projectId"`
	AssignedTo    *string `json:"assignedTo"`
	Limit         int     `json:"limit"`
	Cursor        *string `json:"cursor"`
	GroupID       *string `json:"groupId"`
	TargetsCursor *string `json:"targetsCursor"`
}

// RegisterTaskWorkTools publishes the shared work overview and target paging use case.
func RegisterTaskWorkTools(entry *Entry, reader taskWorkReader) error {
	if entry == nil || reader == nil {
		return fmt.Errorf("MCP work tool requires an entry and observation service")
	}
	var tool sdk.Tool
	if err := json.Unmarshal(taskWorkToolDefinition, &tool); err != nil {
		return err
	}
	return registerTypedReadTool(entry, &tool, BudgetControl, func(ctx context.Context, actor RequestActor, in workInput) (ToolResult, error) {
		refs := map[string]any{"projectId": in.ProjectID}
		if in.GroupID != nil {
			refs["groupId"] = *in.GroupID
		}
		overhead, err := workResponseOverhead(actor, refs)
		if err != nil {
			return ToolResult{}, err
		}
		if overhead >= taskwork.MaxResponseBytes {
			return ToolResult{}, &model.Fault{Code: "resource_limit_exceeded", Message: "The work overview response envelope exceeds its limit."}
		}
		page, err := reader.WorkList(ctx, actor.Principal, in.ProjectID, taskcore.WorkRequest{AssignedTo: in.AssignedTo, Limit: in.Limit, Cursor: in.Cursor, GroupID: in.GroupID, TargetsCursor: in.TargetsCursor, ResponseOverhead: overhead})
		if err != nil {
			return ToolResult{}, err
		}
		return ToolResult{Data: page, Observation: &ReadObservation{ObservedAt: page.ObservedAt, Partial: page.Partial}, Refs: refs}, nil
	})
}

// The page budget includes the actual request ID and SDK protocol envelope.
// Observation timestamps reserve all RFC3339Nano digits, and false is the
// longer partial spelling. Legacy batches reserve delimiters per result.
// The dedicated work use case owns page admission; other reads stay complete.
func workResponseOverhead(actor RequestActor, refs map[string]any) (int, error) {
	size, err := taskprotocol.EncodeMCPDataResponse(io.Discard, json.RawMessage("null"), actor.RequestID, "", actor.rpcResponseID, actor.rpcModern, math.MaxInt64)
	if err != nil {
		return 0, err
	}
	stamp := time.Date(9999, 12, 31, 23, 59, 59, 999999999, time.UTC)
	partial := false
	original, err := json.Marshal(taskprotocol.MCPMeta{RequestID: actor.RequestID})
	if err != nil {
		return 0, err
	}
	observation, err := json.Marshal(envelopeMeta{RequestID: actor.RequestID, ObservedAt: &stamp, Partial: &partial, Refs: refs})
	if err != nil {
		return 0, err
	}
	overhead := int(size) - len("null") + len(observation) - len(original) + 1
	if actor.rpcBatch {
		overhead += 2
	}
	return overhead, nil
}
