package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

// ToolResult carries only completion facts established by the operation.
type ToolResult struct {
	Data         any
	Outcome      string
	WriteOutcome string
	Phase        string
	Refs         map[string]any
}
type ToolHandler func(context.Context, RequestActor, json.RawMessage) (ToolResult, error)

type envelopeMeta struct {
	RequestID string `json:"requestId"`
	Outcome   string `json:"outcome,omitempty"`
}
type envelopeError struct {
	Code         string         `json:"code"`
	Message      string         `json:"message"`
	RequestID    string         `json:"requestId"`
	WriteOutcome string         `json:"writeOutcome,omitempty"`
	Phase        string         `json:"phase,omitempty"`
	Refs         map[string]any `json:"refs,omitempty"`
}
type envelope struct {
	Data  any            `json:"data,omitempty"`
	Meta  *envelopeMeta  `json:"meta,omitempty"`
	Error *envelopeError `json:"error,omitempty"`
}

func resolveSchema(value any) (*jsonschema.Schema, error) {
	b, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(b))
	decoder.UseNumber()
	var document any
	if err = decoder.Decode(&document); err != nil {
		return nil, err
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	if err = compiler.AddResource("urn:daynight:mcp:tool", document); err != nil {
		return nil, err
	}
	return compiler.Compile("urn:daynight:mcp:tool")
}
func validateJSON(schema *jsonschema.Schema, raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var v any
	if err := decoder.Decode(&v); err != nil {
		return err
	}
	return schema.Validate(v)
}

// acceptsErrorEnvelope proves compatibility for a deliberately bounded subset
// of JSON Schema. Unknown constraints are rejected: testing examples cannot
// prove that all error codes, messages, phases and references remain valid.
// The supported oneOf shape is the shared tools.json success/error contract.
func acceptsErrorEnvelope(value any) bool {
	raw, err := json.Marshal(value)
	if err != nil {
		return false
	}
	var root map[string]any
	if json.Unmarshal(raw, &root) != nil || root == nil || !onlySchemaKeys(root, "type", "properties", "required", "additionalProperties", "oneOf") {
		return false
	}
	if root["type"] != "object" || !objectPropertySchemas(root) {
		return false
	}
	if !requiredSubset(root["required"], "error") {
		return false
	}
	properties, ok := schemaProperties(root["properties"])
	if !ok {
		return false
	}
	errorSchema, hasError := properties["error"]
	if hasError {
		if !acceptsErrorObject(errorSchema) {
			return false
		}
	} else if extra, exists := root["additionalProperties"]; exists && !acceptsAny(extra) {
		return false
	}
	if branches, exists := root["oneOf"]; exists && !commonEnvelopeBranches(branches) {
		return false
	}
	return true
}

// Annotation keywords do not change validation. All other unlisted keywords
// are refused instead of guessing at their interaction with the envelope.
func onlySchemaKeys(schema map[string]any, permitted ...string) bool {
	allowed := map[string]bool{"title": true, "description": true, "$comment": true, "default": true, "examples": true, "deprecated": true, "readOnly": true, "writeOnly": true}
	for _, key := range permitted {
		allowed[key] = true
	}
	for key := range schema {
		if !allowed[key] {
			return false
		}
	}
	return true
}

func schemaProperties(value any) (map[string]any, bool) {
	if value == nil {
		return map[string]any{}, true
	}
	properties, ok := value.(map[string]any)
	return properties, ok
}

// objectPropertySchemas checks the tool discovery contract without restricting
// schemas nested beneath a direct property.
func objectPropertySchemas(root map[string]any) bool {
	properties, ok := schemaProperties(root["properties"])
	if !ok {
		return false
	}
	for _, property := range properties {
		if _, ok := property.(map[string]any); !ok {
			return false
		}
	}
	return true
}

func requiredSubset(value any, guaranteed ...string) bool {
	if value == nil {
		return true
	}
	values, ok := value.([]any)
	if !ok {
		return false
	}
	allowed := make(map[string]bool, len(guaranteed))
	for _, key := range guaranteed {
		allowed[key] = true
	}
	for _, v := range values {
		key, ok := v.(string)
		if !ok || !allowed[key] {
			return false
		}
	}
	return true
}

func acceptsAny(value any) bool {
	if b, ok := value.(bool); ok {
		return b
	}
	s, ok := value.(map[string]any)
	return ok && onlySchemaKeys(s)
}

func acceptsType(value any, kind string) bool {
	if acceptsAny(value) {
		return true
	}
	s, ok := value.(map[string]any)
	return ok && onlySchemaKeys(s, "type") && s["type"] == kind
}

func acceptsOutcome(value any) bool {
	if acceptsType(value, "string") {
		return true
	}
	s, ok := value.(map[string]any)
	if !ok || !onlySchemaKeys(s, "enum", "type") {
		return false
	}
	if typ, exists := s["type"]; exists && typ != "string" {
		return false
	}
	values, ok := s["enum"].([]any)
	if !ok {
		return false
	}
	needed := map[string]bool{"confirmed": false, "not_committed": false, "unknown": false}
	for _, value := range values {
		if text, ok := value.(string); ok {
			if _, present := needed[text]; present {
				needed[text] = true
			}
		}
	}
	return needed["confirmed"] && needed["not_committed"] && needed["unknown"]
}

func acceptsErrorObject(value any) bool {
	if acceptsAny(value) {
		return true
	}
	s, ok := value.(map[string]any)
	if !ok || !onlySchemaKeys(s, "type", "properties", "required", "additionalProperties") {
		return false
	}
	if typ, exists := s["type"]; exists && typ != "object" {
		return false
	}
	if !requiredSubset(s["required"], "code", "message", "requestId") {
		return false
	}
	properties, ok := schemaProperties(s["properties"])
	if !ok {
		return false
	}
	for _, field := range []string{"code", "message", "requestId", "writeOutcome", "phase", "refs"} {
		property, present := properties[field]
		if !present {
			if extra, exists := s["additionalProperties"]; exists && !acceptsAny(extra) {
				return false
			}
			continue
		}
		switch field {
		case "writeOutcome":
			if !acceptsOutcome(property) {
				return false
			}
		case "refs":
			if !acceptsType(property, "object") {
				return false
			}
		default:
			if !acceptsType(property, "string") {
				return false
			}
		}
	}
	return true
}

func commonEnvelopeBranches(value any) bool {
	branches, ok := value.([]any)
	if !ok || len(branches) != 2 {
		return false
	}
	seenSuccess, seenError := false, false
	for _, branch := range branches {
		s, ok := branch.(map[string]any)
		if !ok || !onlySchemaKeys(s, "required", "not") {
			return false
		}
		not, ok := s["not"].(map[string]any)
		if !ok || !onlySchemaKeys(not, "required") {
			return false
		}
		switch {
		case requiredExactly(s["required"], "data", "meta") && requiredExactly(not["required"], "error"):
			seenSuccess = true
		case requiredExactly(s["required"], "error") && requiredExactly(not["required"], "data"):
			seenError = true
		default:
			return false
		}
	}
	return seenSuccess && seenError
}

func requiredExactly(value any, keys ...string) bool {
	values, ok := value.([]any)
	if !ok || len(values) != len(keys) || !requiredSubset(value, keys...) {
		return false
	}
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		seen[value.(string)] = true
	}
	return len(seen) == len(keys)
}

// RegisterTool validates the exact schemas advertised to clients before a tool
// becomes discoverable. Class must describe the largest internal materialization.
func (e *Entry) RegisterTool(tool *sdk.Tool, class BudgetClass, handler ToolHandler) error {
	if class != BudgetControl && class != BudgetLarge {
		return errors.New("invalid MCP tool registration")
	}
	return e.registerTool(tool, func(json.RawMessage) BudgetClass { return class }, handler)
}

// registerTool selects a budget after input validation and before business work.
func (e *Entry) registerTool(tool *sdk.Tool, budget func(json.RawMessage) BudgetClass, handler ToolHandler) error {
	if tool == nil || tool.Name == "" || tool.InputSchema == nil || tool.OutputSchema == nil || handler == nil || budget == nil {
		return errors.New("invalid MCP tool registration")
	}
	input, err := resolveSchema(tool.InputSchema)
	if err != nil {
		return fmt.Errorf("input schema: %w", err)
	}
	var inputRoot map[string]any
	inputBytes, _ := json.Marshal(tool.InputSchema)
	_ = json.Unmarshal(inputBytes, &inputRoot)
	if inputRoot["type"] != "object" || !objectPropertySchemas(inputRoot) {
		return errors.New("input schema must have object root and object property schemas")
	}
	output, err := resolveSchema(tool.OutputSchema)
	if err != nil {
		return fmt.Errorf("output schema: %w", err)
	}
	if !acceptsErrorEnvelope(tool.OutputSchema) {
		return errors.New("output schema must accept the common error envelope")
	}
	e.server.AddTool(tool, func(sdkctx context.Context, req *sdk.CallToolRequest) (*sdk.CallToolResult, error) {
		scope, ok := sdkctx.Value(scopeKey{}).(*requestScope)
		if !ok {
			return nil, &jsonrpc.Error{Code: jsonrpc.CodeInternalError, Message: "request scope unavailable"}
		}
		scope.begin()
		e.active.Add(1)
		defer e.active.Done()
		defer scope.end()
		ctx, cancel := context.WithCancel(sdkctx)
		stop := context.AfterFunc(scope.actor.Context, cancel)
		defer stop()
		defer cancel()
		actor := scope.actor
		actor.Context = ctx
		raw := bytes.TrimSpace(req.Params.Arguments)
		if len(raw) == 0 {
			raw = []byte("{}")
		}
		if len(raw) == 0 || raw[0] != '{' {
			return nil, &jsonrpc.Error{Code: jsonrpc.CodeInvalidParams, Message: "arguments must be an object"}
		}
		if err := validateJSON(input, raw); err != nil {
			return e.errorResult(output, actor, envelopeError{Code: "invalid_input", Message: "Tool arguments do not match the input schema.", RequestID: actor.RequestID}), nil
		}
		release, err := actor.Budget.Acquire(ctx, budget(raw))
		if err != nil {
			return e.errorResult(output, actor, envelopeError{Code: "resource_busy", Message: "The tool resource budget is unavailable.", RequestID: actor.RequestID}), nil
		}
		scope.hold(release)
		result, err := handler(ctx, actor, raw)
		if err != nil {
			failure := envelopeError{Code: "internal_error", Message: "The tool could not complete.", RequestID: actor.RequestID, WriteOutcome: result.WriteOutcome, Phase: result.Phase, Refs: result.Refs}
			facts := operation.CompletionFacts(err)
			if failure.Phase == "" {
				failure.Phase = facts.Phase
			}
			if failure.WriteOutcome == "" {
				switch facts.Outcome {
				case store.TransactionCommitted:
					failure.WriteOutcome = "confirmed"
				case store.TransactionNotCommitted:
					failure.WriteOutcome = "not_committed"
				case store.TransactionUnknown:
					failure.WriteOutcome = "unknown"
				}
			}
			if fault, ok := taskservice.ThreadResponseFault(err); ok && !facts.CleanupFailed {
				failure.Code = fault.Code
				failure.Message = fault.Message
			} else if fault, ok := operation.KnownFault(err); ok && httpx.ErrorKind(err) == fault.Code {
				failure.Code = fault.Code
				failure.Message = fault.Message
			}
			e.logger.ErrorContext(ctx, "MCP tool failed", "component", "mcp", "operation", tool.Name, "request_id", actor.RequestID, "error_code", failure.Code, "write_outcome", failure.WriteOutcome, "cleanup_failed", facts.CleanupFailed)
			return e.errorResult(output, actor, failure), nil
		}
		value := envelope{Data: result.Data, Meta: &envelopeMeta{RequestID: actor.RequestID, Outcome: result.Outcome}}
		encoded, err := json.Marshal(value)
		if err == nil && len(encoded) <= 128<<20 {
			err = validateJSON(output, encoded)
		} else if err == nil {
			err = errors.New("encoded output exceeds limit")
		}
		if err != nil {
			if result.WriteOutcome == "" && (result.Outcome == "changed" || result.Outcome == "unchanged") {
				result.WriteOutcome = "confirmed"
			}
			e.logger.ErrorContext(ctx, "MCP output construction failed", "component", "mcp", "operation", tool.Name, "request_id", actor.RequestID, "write_outcome", result.WriteOutcome, "outcome", result.Outcome)
			return e.errorResult(output, actor, envelopeError{Code: "internal_error", Message: "The tool result could not be constructed.", RequestID: actor.RequestID, WriteOutcome: result.WriteOutcome, Phase: "output", Refs: result.Refs}), nil
		}
		e.logger.InfoContext(ctx, "MCP tool completed", "component", "mcp", "operation", tool.Name, "request_id", actor.RequestID, "user_id", actor.Principal.UserID, "credential_id", actor.Principal.CredentialID, "outcome", result.Outcome, "write_outcome", result.WriteOutcome)
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: "Completed."}}, StructuredContent: json.RawMessage(encoded)}, nil
	})
	return nil
}
func (e *Entry) errorResult(output *jsonschema.Schema, actor RequestActor, failure envelopeError) *sdk.CallToolResult {
	if failure.WriteOutcome != "" && failure.WriteOutcome != "confirmed" && failure.WriteOutcome != "not_committed" && failure.WriteOutcome != "unknown" {
		failure.WriteOutcome = ""
	}
	encoded, err := json.Marshal(envelope{Error: &failure})
	if err != nil || validateJSON(output, encoded) != nil {
		e.logger.ErrorContext(actor.Context, "MCP error output violates schema", "component", "mcp", "request_id", actor.RequestID, "error_code", failure.Code, "write_outcome", failure.WriteOutcome)
		// References are supplementary and can themselves be malformed; preserve the
		// request and established completion facts in the fallback envelope.
		failure.Refs = nil
		encoded, err = json.Marshal(envelope{Error: &failure})
		if err != nil || validateJSON(output, encoded) != nil {
			failure.Code = "internal_error"
			failure.Message = "The tool result could not be constructed."
			encoded, _ = json.Marshal(envelope{Error: &failure})
		}
	}
	return &sdk.CallToolResult{IsError: true, Content: []sdk.Content{&sdk.TextContent{Text: failure.Message}}, StructuredContent: json.RawMessage(encoded)}
}

// RegisterTypedTool also decodes validated arguments before invoking a handler.
// A type mismatch is a safe input error and never reaches the business operation.
func RegisterTypedTool[T any](e *Entry, tool *sdk.Tool, class BudgetClass, handler func(context.Context, RequestActor, T) (ToolResult, error), unicodeFields ...string) error {
	if handler == nil {
		return errors.New("MCP tool handler is required")
	}
	return e.RegisterTool(tool, class, func(ctx context.Context, actor RequestActor, raw json.RawMessage) (ToolResult, error) {
		if err := ValidateUnicodeFields(raw, unicodeFields...); err != nil {
			return ToolResult{}, err
		}
		var input T
		if err := json.Unmarshal(raw, &input); err != nil {
			return ToolResult{}, &model.Fault{Code: "invalid_input", Message: "Tool arguments could not be decoded."}
		}
		return handler(ctx, actor, input)
	})
}

// ValidateUnicodeFields checks selected original JSON fields before decoding can
// replace invalid Unicode. Select the fields whose existing business contract
// requires it; arbitrary property JSON is deliberately left untouched.
func ValidateUnicodeFields(raw json.RawMessage, fields ...string) error {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return &model.Fault{Code: "invalid_input", Message: "Tool arguments could not be decoded."}
	}
	for _, field := range fields {
		if value, ok := object[field]; ok && !jsonunicode.Valid(value) {
			return &model.Fault{Code: "invalid_input", Message: "Tool arguments contain invalid Unicode."}
		}
	}
	return nil
}
