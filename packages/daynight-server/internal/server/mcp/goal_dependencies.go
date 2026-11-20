package mcp

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	protocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/goaldependencies"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed goal_dependencies_tools.json
var goalDependencyTools []byte

type goalDependencyOperations interface {
	ShowGoalDependencies(context.Context, model.Principal, string, string, model.PageRequest) (taskcore.GoalDependencies, error)
	EditGoalDependencies(context.Context, model.Principal, string, string, taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error)
}

// RegisterGoalDependencyTools publishes bounded Goal relationship reads and edits.
func RegisterGoalDependencyTools(entry *Entry, service goalDependencyOperations) error {
	return registerGoalDependencyTools(entry, service, taskToolsAll)
}

func registerGoalDependencyTools(entry *Entry, service goalDependencyOperations, selection taskToolSelection) error {
	if entry == nil || service == nil || service == (*taskservice.Tasks)(nil) {
		return fmt.Errorf("MCP Goal dependency tools require an entry and Tasks service")
	}
	var definitions []*sdk.Tool
	if err := json.Unmarshal(goalDependencyTools, &definitions); err != nil {
		return err
	}
	for _, tool := range definitions {
		name := tool.Name
		read := name == "goal_dependencies_show"
		if selection == taskToolsRead && !read || selection == taskToolsWrite && read {
			continue
		}
		handler := func(ctx context.Context, actor RequestActor, raw json.RawMessage) (ToolResult, error) {
			return goalDependencyTool(ctx, actor, name, raw, service)
		}
		var err error
		if name == "goal_dependencies_show" {
			err = entry.registerReadTool(tool, func(json.RawMessage) BudgetClass { return BudgetControl }, handler)
		} else if name == "goal_dependencies_edit" {
			err = entry.RegisterTool(tool, BudgetControl, handler)
		} else {
			return fmt.Errorf("unknown Goal dependency tool %q", name)
		}
		if err != nil {
			return fmt.Errorf("register %s: %w", name, err)
		}
	}
	return nil
}

// RegisterScopedGoalDependencyWriteTools publishes only Goal relationship edits.
// Read tools have their own scoped registration.
func RegisterScopedGoalDependencyWriteTools(entry *Entry, service *taskservice.Tasks) error {
	if entry == nil || entry.scopedAuth == nil || service == nil {
		return fmt.Errorf("scoped Goal dependency write dependencies are required")
	}
	if err := registerGoalDependencyTools(entry, service, taskToolsWrite); err != nil {
		return err
	}
	entry.scopedTools["goal_dependencies_edit"] = true
	return nil
}

func goalDependencyTool(ctx context.Context, actor RequestActor, name string, raw json.RawMessage, service goalDependencyOperations) (ToolResult, error) {
	if !jsonunicode.Valid(raw) {
		return ToolResult{}, &model.Fault{Code: "invalid_input", Message: "Tool arguments contain invalid Unicode."}
	}
	allowed := []string{"projectId", "goalId", "cursor", "limit"}
	if name == "goal_dependencies_edit" {
		allowed = []string{"projectId", "goalId", "ifRevision", "mode", "add", "remove", "prerequisites"}
	}
	fields, err := jsonobject.Decode(raw, "tool arguments", allowed...)
	if err != nil {
		return ToolResult{}, &model.Fault{Code: "invalid_input", Message: err.Error()}
	}
	var identity struct {
		ProjectID string  `json:"projectId"`
		GoalID    string  `json:"goalId"`
		Cursor    *string `json:"cursor"`
		Limit     int     `json:"limit"`
	}
	if err := json.Unmarshal(raw, &identity); err != nil {
		return ToolResult{}, &model.Fault{Code: "invalid_input", Message: "Tool arguments could not be decoded."}
	}
	refs := map[string]any{"projectId": identity.ProjectID, "goalId": identity.GoalID}
	if name == "goal_dependencies_show" {
		result, err := service.ShowGoalDependencies(ctx, actor.Principal, identity.ProjectID, identity.GoalID, model.PageRequest{Limit: identity.Limit, Cursor: identity.Cursor})
		if err != nil {
			return ToolResult{Refs: refs}, err
		}
		return ToolResult{Data: protocol.MapRelationships(result)}, nil
	}
	delete(fields, "projectId")
	delete(fields, "goalId")
	body, err := json.Marshal(fields)
	if err != nil {
		return ToolResult{}, err
	}
	edit, err := protocol.DecodeEdit(body)
	if err != nil {
		return ToolResult{Refs: refs}, err
	}
	if actor.Authorization != nil {
		if actor.Authorization.Principal != actor.Principal {
			return ToolResult{}, fmt.Errorf("Goal authorization identity mismatch")
		}
		ctx = taskservice.WithTaskWriteAuthorization(ctx, *actor.Authorization, false)
	}
	receipt, err := service.EditGoalDependencies(ctx, actor.Principal, identity.ProjectID, identity.GoalID, edit)
	if err != nil {
		return ToolResult{Refs: refs}, err
	}
	outcome := "unchanged"
	if receipt.Changed {
		outcome = "changed"
	}
	return ToolResult{Data: protocol.MapReceipt(receipt), Outcome: outcome, WriteOutcome: "confirmed", Refs: refs}, nil
}
