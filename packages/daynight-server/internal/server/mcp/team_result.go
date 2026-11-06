package mcp

import (
	"encoding/json"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

const teamItemLargeResultBytes = 8 << 20

type toolResultPolicy struct {
	name       string
	maxBytes   int
	mirrorText bool
}

func resultPolicy(name string, raw json.RawMessage) toolResultPolicy {
	policy := toolResultPolicy{name: name, maxBytes: 128 << 20}
	switch name {
	case "team_list", "team_member_list", "team_projects", "team_item_read":
		policy.mirrorText = true
		policy.maxBytes = teamListBudget
	}
	if name == "team_item_read" {
		var in struct {
			Action   string `json:"action"`
			MaxBytes int    `json:"maxBytes"`
		}
		if json.Unmarshal(raw, &in) == nil && in.Action == "chunk" && in.MaxBytes > 8192 && in.MaxBytes <= 524288 {
			policy.maxBytes = teamItemLargeResultBytes
		}
	}
	return policy
}

func toolCallResult(encoded json.RawMessage, failure bool, mirror bool) *sdk.CallToolResult {
	text := "Completed."
	if mirror {
		text = string(encoded)
	}
	return &sdk.CallToolResult{IsError: failure, Content: []sdk.Content{&sdk.TextContent{Text: text}}, StructuredContent: encoded}
}

func mirroredResultSize(value envelope) (int, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return 0, err
	}
	return completeToolResultSize(toolCallResult(encoded, value.Error != nil, true))
}

// The SDK adds the complete-result marker and server identity after handlers
// return for the newer protocol. Size against that complete representation.
// https://github.com/modelcontextprotocol/go-sdk/blob/eeddd84db4054984ba4d2d2504851a5001182d53/mcp/server.go#L2042-L2045
func completeToolResultSize(result *sdk.CallToolResult) (int, error) {
	type fields sdk.CallToolResult
	value := fields(*result)
	value.Meta = sdk.Meta{sdk.MetaKeyServerInfo: serverImplementation()}
	wire, err := json.Marshal(struct {
		fields
		ResultType string `json:"resultType"`
	}{value, "complete"})
	return len(wire), err
}

func (p toolResultPolicy) encode(value envelope) (*sdk.CallToolResult, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return p.encodeJSON(encoded, value.Error != nil)
}

func (p toolResultPolicy) encodeJSON(encoded json.RawMessage, failure bool) (*sdk.CallToolResult, error) {
	result := toolCallResult(encoded, failure, p.mirrorText)
	if p.mirrorText {
		size, err := completeToolResultSize(result)
		if err != nil {
			return nil, err
		}
		if size > p.maxBytes {
			return nil, errors.New("encoded tool result exceeds limit")
		}
	} else if len(encoded) > p.maxBytes {
		return nil, errors.New("encoded output exceeds limit")
	}
	return result, nil
}

func validItemReadReference(name string, refs map[string]any) bool {
	kind := map[string]string{"team_list": "team", "team_member_list": "member", "team_projects": "project"}[name]
	if kind == "" {
		return true
	}
	arguments, ok := refs["readArguments"].(map[string]any)
	if !ok || refs["readTool"] != "team_item_read" || arguments["kind"] != kind || arguments["action"] != "inspect" {
		return false
	}
	cursor, ok := refs["cursorAfterItem"].(string)
	if !ok || cursor == "" || len(cursor) > 2048 {
		return false
	}
	team, ok := arguments["team"].(string)
	if !ok {
		return false
	}
	if _, err := model.CanonicalID(team); err != nil || refs["teamId"] != team {
		return false
	}
	for _, key := range []string{"userId", "projectId"} {
		if (kind == "member" && key == "userId") || (kind == "project" && key == "projectId") {
			id, ok := arguments[key].(string)
			if !ok {
				return false
			}
			if _, err := model.CanonicalID(id); err != nil || refs[key] != id {
				return false
			}
		}
	}
	return true
}

func (e *Entry) errorResultFor(output *jsonschema.Schema, actor RequestActor, failure envelopeError, policy toolResultPolicy) *sdk.CallToolResult {
	if !policy.mirrorText {
		return e.errorResult(output, actor, failure)
	}
	if failure.WriteOutcome != "" && failure.WriteOutcome != "confirmed" && failure.WriteOutcome != "not_committed" && failure.WriteOutcome != "unknown" {
		failure.WriteOutcome = ""
	}
	if failure.Code == "payload_too_large" && !validItemReadReference(policy.name, failure.Refs) {
		failure.Code = "internal_error"
		failure.Message = "The complete item read reference could not be constructed."
		failure.Phase = "output"
		failure.Refs = nil
	}
	result, err := policy.encode(envelope{Error: &failure})
	if err == nil {
		encoded, marshalErr := json.Marshal(result.StructuredContent)
		if marshalErr == nil && validateJSON(output, encoded) == nil {
			return result
		}
	}
	e.logger.ErrorContext(actor.Context, "MCP error output violates schema or capacity", "component", "mcp", "request_id", actor.RequestID, "error_code", failure.Code)
	failure.Code = "internal_error"
	failure.Message = "The tool result could not be constructed."
	failure.Phase = "output"
	failure.Refs = nil
	encoded, _ := json.Marshal(envelope{Error: &failure})
	return toolCallResult(encoded, true, true)
}

func teamLogReferences(name string, refs map[string]any) []any {
	switch name {
	case "team_list", "team_member_list", "team_projects", "team_item_read":
	default:
		return nil
	}
	var attrs []any
	for _, field := range []struct{ key, attr string }{{"teamId", "team_id"}, {"userId", "member_user_id"}, {"projectId", "project_id"}} {
		if value, ok := refs[field.key].(string); ok {
			if id, err := model.CanonicalID(value); err == nil && id == value {
				attrs = append(attrs, field.attr, id)
			}
		}
	}
	if name == "team_item_read" {
		if value, ok := refs["returnedBytes"].(string); ok {
			if count, err := ParseBytes(value); err == nil && count <= 524288 {
				attrs = append(attrs, "returned_bytes", count)
			}
		}
	}
	return attrs
}
