package mcp

import (
	"sort"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type sessionReadSchema = map[string]any

func readObject(properties sessionReadSchema, optional ...string) sessionReadSchema {
	omit := map[string]bool{}
	for _, key := range optional {
		omit[key] = true
	}
	required := []string{}
	for key := range properties {
		if !omit[key] {
			required = append(required, key)
		}
	}
	sort.Strings(required)
	return sessionReadSchema{"type": "object", "properties": properties, "required": required, "additionalProperties": false}
}
func readUUID() sessionReadSchema { return sessionReadSchema{"type": "string", "format": "uuid"} }
func readBool() sessionReadSchema { return sessionReadSchema{"type": "boolean"} }
func readCursor() sessionReadSchema {
	return sessionReadSchema{"type": "string", "minLength": 1, "maxLength": 4096, "pattern": "^[A-Za-z0-9_-]+$"}
}
func sessionReadToolDefinition(name string) *sdk.Tool {
	input := sessionReadSchema{"projectId": readUUID(), "taskId": readUUID()}
	optional := []string{}
	switch name {
	case "list":
		input["cursor"] = readCursor()
		input["limit"] = sessionReadSchema{"type": "integer", "minimum": 1, "maximum": 200, "default": 20}
		optional = []string{"cursor", "limit"}
	case "show":
		input["sessionId"] = readUUID()
	case "read":
		input["sessionId"] = readUUID()
		input["before"] = readCursor()
		input["limit"] = sessionReadSchema{"type": "integer", "minimum": 1, "maximum": 200, "default": 20}
		input["conversation"] = readBool()
		optional = []string{"before", "limit", "conversation"}
	case "entry":
		input["sessionId"] = readUUID()
		input["cursor"] = readCursor()
	}
	description := map[string]string{"current": "Read the current Task Session association without falling back to history.", "list": "List the Task's Sessions, newest first, with stable cursor pagination.", "show": "Inspect one exact Task Session's identity, state and readable source.", "read": "Read recent or earlier messages from one Task Session. Conversation filtering applies to this page only. Large entries expose a contentRef for task_session_entry.", "entry": "Read the next UTF-8 chunk of an exact Session entry. Preserve cursor, revision, byte length and SHA-256 when assembling its canonical JSON."}[name]
	return &sdk.Tool{Name: "task_session_" + name, Description: description, InputSchema: readObject(input, optional...), Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true}}
}
