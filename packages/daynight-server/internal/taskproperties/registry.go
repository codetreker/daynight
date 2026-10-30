package taskproperties

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

type ValidationError struct {
	Path  string
	Rule  string
	Cause error
}

func (e *ValidationError) Error() string { return e.Rule }
func (e *ValidationError) Unwrap() error { return e.Cause }

type Definition struct {
	Name        string                                         `json:"-"`
	Description string                                         `json:"description"`
	ReadOnly    bool                                           `json:"readOnly"`
	Schema      json.RawMessage                                `json:"schema"`
	Normalize   func(json.RawMessage) (json.RawMessage, error) `json:"-"`
	kind        string
}

var definitions = map[string]Definition{
	"pullRequests": {Name: "pullRequests", Description: "Pull requests associated with this task; ordered URL and title text without URL validation.", Schema: pullRequestsSchema(), Normalize: normalizePullRequests, kind: "array"},
	"worker":       {Name: "worker", Description: "Execution ownership maintained by the service; absent when no claim is retained.", ReadOnly: true, Schema: workerSchema(), Normalize: normalizeWorker, kind: "object"},
}

func Definitions() map[string]Definition {
	result := maps.Clone(definitions)
	for name, definition := range result {
		definition.Schema = bytes.Clone(definition.Schema)
		result[name] = definition
	}
	return result
}

func propertyNames() []string {
	names := slices.Collect(maps.Keys(definitions))
	slices.Sort(names)
	return names
}

func validation(path, rule string, cause error) error {
	return &ValidationError{Path: path, Rule: rule, Cause: cause}
}

func definition(name string) (Definition, error) {
	value, ok := definitions[name]
	if !ok {
		return Definition{}, validation("properties", "properties contains an unknown attribute", nil)
	}
	return value, nil
}

func CheckWritable(name string) error {
	value, err := definition(name)
	if err != nil {
		return err
	}
	if value.ReadOnly {
		return validation("properties."+value.Name, "properties."+value.Name+" is read-only and managed by execution operations", nil)
	}
	return nil
}

func NormalizeValue(name string, raw json.RawMessage, public bool) (json.RawMessage, error) {
	value, err := definition(name)
	if err != nil {
		return nil, err
	}
	if public {
		if err := CheckWritable(name); err != nil {
			return nil, err
		}
	}
	path := "properties." + name
	if err := strictValue(raw); err != nil {
		return nil, validation(path, path+" must contain exactly one JSON value without duplicate fields", err)
	}
	normalized, err := value.Normalize(raw)
	if err != nil {
		return nil, validation(path, err.Error(), err)
	}
	return normalized, nil
}

func Normalize(properties core.TaskProperties, public bool) (core.TaskProperties, error) {
	result := make(core.TaskProperties, len(properties))
	for _, name := range slices.Sorted(maps.Keys(properties)) {
		value, err := NormalizeValue(name, properties[name], public)
		if err != nil {
			return nil, err
		}
		result[name] = value
	}
	return result, nil
}

func Clone(properties core.TaskProperties) core.TaskProperties {
	result := make(core.TaskProperties, len(properties))
	for name, value := range properties {
		result[name] = bytes.Clone(value)
	}
	return result
}

func Equal(left, right core.TaskProperties) bool {
	return maps.EqualFunc(left, right, func(a, b json.RawMessage) bool { return bytes.Equal(a, b) })
}

func ParseInput(name, input string) (json.RawMessage, error) {
	value, err := definition(name)
	if err != nil {
		return nil, err
	}
	if err := CheckWritable(name); err != nil {
		return nil, err
	}
	return parseDefinitionInput(value, input)
}

func parseDefinitionInput(value Definition, input string) (json.RawMessage, error) {
	raw := json.RawMessage(input)
	if value.kind == "string" {
		var text string
		if json.Unmarshal(raw, &text) != nil || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			text = input
		}
		encoded, err := json.Marshal(text)
		if err != nil {
			return nil, err
		}
		raw = encoded
	}
	path := "properties." + value.Name
	if err := strictValue(raw); err != nil {
		return nil, validation(path, path+" must contain exactly one JSON value without duplicate fields", err)
	}
	normalized, err := value.Normalize(raw)
	if err != nil {
		return nil, validation(path, err.Error(), err)
	}
	return normalized, nil
}

func strictValue(raw []byte) error {
	if !json.Valid(raw) {
		return errors.New("invalid JSON value")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var consume func() error
	consume = func() error {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delim, composite := token.(json.Delim)
		if !composite {
			return nil
		}
		switch delim {
		case '{':
			seen := make(map[string]bool)
			for decoder.More() {
				token, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := token.(string)
				if !ok || seen[key] {
					return errors.New("duplicate JSON field")
				}
				seen[key] = true
				if err := consume(); err != nil {
					return err
				}
			}
		case '[':
			for decoder.More() {
				if err := consume(); err != nil {
					return err
				}
			}
		default:
			return errors.New("unexpected JSON delimiter")
		}
		closing, err := decoder.Token()
		if err != nil {
			return err
		}
		if delim == '{' && closing != json.Delim('}') || delim == '[' && closing != json.Delim(']') {
			return errors.New("invalid JSON closing delimiter")
		}
		return nil
	}
	if err := consume(); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("multiple JSON values")
	}
	return nil
}

func schemaJSON(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(fmt.Errorf("encode property definition: %w", err))
	}
	return encoded
}

func objectSchema(properties map[string]any, required ...string) map[string]any {
	return map[string]any{"type": "object", "additionalProperties": false, "properties": properties, "required": required}
}

func textSchema() map[string]any { return map[string]any{"type": "string"} }
func workerTextSchema() map[string]any {
	return map[string]any{"type": "string", "minLength": 1, "pattern": `[^\s]`, "not": map[string]any{"pattern": "\u0000"}, "description": "Nonblank UTF-8 text without NUL."}
}
func uuidSchema() map[string]any { return map[string]any{"type": "string", "format": "uuid"} }
func enumSchema(values ...string) map[string]any {
	return map[string]any{"type": "string", "enum": values}
}
func nullableSchema(value map[string]any) map[string]any {
	return map[string]any{"anyOf": []any{value, map[string]any{"type": "null"}}}
}
func pullRequestsSchema() json.RawMessage {
	return schemaJSON(map[string]any{"type": "array", "items": objectSchema(map[string]any{"url": textSchema(), "title": textSchema()}, "url", "title")})
}
func workerSchema() json.RawMessage {
	properties := map[string]any{
		"claimId": uuidSchema(), "state": enumSchema("active", "released", "completed"), "userId": uuidSchema(), "workerId": uuidSchema(),
		"machine":  objectSchema(map[string]any{"id": uuidSchema(), "name": workerTextSchema()}, "id", "name"),
		"platform": enumSchema("windows", "linux", "macos"), "agent": enumSchema("codex", "copilot", "claude"),
		"agentControlMode": enumSchema("herdr", "web"), "worktreeId": uuidSchema(),
		"phase":           enumSchema("preparing", "executing", "verifying", "completing", "waiting", "paused"),
		"herdr":           nullableSchema(objectSchema(map[string]any{"session": workerTextSchema(), "workspaceId": workerTextSchema(), "paneId": workerTextSchema()}, "session", "workspaceId", "paneId")),
		"nativeSessionId": nullableSchema(workerTextSchema()),
		"claimedAt":       map[string]any{"type": "string", "format": "date-time", "description": "Nonzero RFC3339 timestamp."},
	}
	schema := objectSchema(properties, "claimId", "state", "userId", "workerId", "machine", "platform", "agent", "agentControlMode", "worktreeId", "phase", "herdr", "nativeSessionId", "claimedAt")
	schema["allOf"] = []any{map[string]any{"if": map[string]any{"properties": map[string]any{"agentControlMode": map[string]any{"const": "web"}}}, "then": map[string]any{"properties": map[string]any{"herdr": map[string]any{"type": "null"}}}}}
	return schemaJSON(schema)
}
