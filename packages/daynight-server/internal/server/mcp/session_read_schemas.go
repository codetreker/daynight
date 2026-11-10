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
func readString() sessionReadSchema            { return sessionReadSchema{"type": "string"} }
func readUUID() sessionReadSchema              { return sessionReadSchema{"type": "string", "format": "uuid"} }
func readBool() sessionReadSchema              { return sessionReadSchema{"type": "boolean"} }
func readEnum(values ...any) sessionReadSchema { return sessionReadSchema{"enum": values} }
func readNullable(value sessionReadSchema) sessionReadSchema {
	return sessionReadSchema{"anyOf": []any{value, sessionReadSchema{"type": "null"}}}
}
func readSequence() sessionReadSchema {
	return sessionReadSchema{"type": "string", "pattern": "^[1-9][0-9]{0,18}$"}
}
func readBytes() sessionReadSchema {
	return sessionReadSchema{"type": "string", "pattern": "^(0|[1-9][0-9]{0,18})$"}
}
func readHash() sessionReadSchema {
	return sessionReadSchema{"type": "string", "pattern": "^[a-f0-9]{64}$"}
}
func readCursor() sessionReadSchema {
	return sessionReadSchema{"type": "string", "minLength": 1, "maxLength": 4096, "pattern": "^[A-Za-z0-9_-]+$"}
}
func readTimestamp() sessionReadSchema {
	return sessionReadSchema{"type": "string", "format": "date-time"}
}
func readArray(item sessionReadSchema, max int) sessionReadSchema {
	return sessionReadSchema{"type": "array", "items": item, "maxItems": max}
}

func sessionReadObservationSchema() sessionReadSchema {
	p := sessionReadSchema{"schemaVersion": readEnum(1), "observation": readEnum("observed", "unavailable", "unsupported"), "registration": readEnum("registered", "not_registered", "not_applicable", "unknown"), "agentControlMode": readEnum("web", "herdr", nil), "contentKind": readEnum("native_timeline", "terminal_recording", nil), "indicator": readEnum("working", "notice", "warning", nil), "reason": readString(), "needsAttention": readNullable(readBool()), "send": readObject(sessionReadSchema{"allowed": readNullable(readBool()), "mode": readEnum("start", "steer", nil), "reason": readString()}), "error": readNullable(readObject(sessionReadSchema{"code": readString(), "message": readString()}))}
	for _, key := range []string{"sessionId", "claimId"} {
		p[key] = readNullable(readUUID())
	}
	for _, key := range []string{"nativeSessionId", "executionGeneration", "connectionEpoch", "provider", "activity", "connectionState", "lifecycle", "currentTurnId"} {
		p[key] = readNullable(readString())
	}
	for _, key := range []string{"observedAt", "lastSeenAt", "freshUntil"} {
		p[key] = readNullable(readTimestamp())
	}
	return readObject(p)
}
func sessionReadInspectionSchema() sessionReadSchema {
	fence := readObject(sessionReadSchema{"sessionId": readUUID(), "claimId": readUUID(), "executionGeneration": readSequence(), "connectionEpoch": readBytes()})
	return readObject(sessionReadSchema{"schemaVersion": readEnum(1), "contentReadVersion": readEnum(0, 1), "projectId": readUUID(), "taskId": readUUID(), "sessionId": readUUID(), "currentBinding": readBool(), "fence": fence, "source": readEnum("live", "archive", "unavailable"), "session": sessionReadObservationSchema()})
}
func sessionReadBodySchema() sessionReadSchema {
	part := sessionReadSchema{"oneOf": []any{readObject(sessionReadSchema{"type": readEnum("text"), "text": readString()}), readObject(sessionReadSchema{"type": readEnum("resource"), "resourceId": readUUID(), "label": readString()})}}
	option := readObject(sessionReadSchema{"id": readString(), "label": readString()})
	fieldVariants := []any{}
	for _, kind := range []string{"text", "boolean", "number", "select", "multiselect"} {
		p := sessionReadSchema{"fieldId": readString(), "label": readString(), "required": readBool(), "type": readEnum(kind)}
		switch kind {
		case "text":
			p["sensitive"] = readBool()
		case "number":
			p["min"] = readNullable(sessionReadSchema{"type": "number"})
			p["max"] = readNullable(sessionReadSchema{"type": "number"})
		case "select", "multiselect":
			p["options"] = readArray(option, 1000)
		}
		fieldVariants = append(fieldVariants, readObject(p))
	}
	interactionVariants := []any{}
	for _, kind := range []string{"approval", "question", "form"} {
		p := sessionReadSchema{"interactionId": readUUID(), "revision": readSequence(), "state": readEnum("pending", "resolved", "expired"), "title": readString(), "kind": readEnum(kind)}
		switch kind {
		case "approval":
			p["detail"] = readString()
			p["actions"] = readArray(readEnum("allow_once", "allow_session", "reject"), 1000)
		case "question":
			p["canDismiss"] = readBool()
			p["questions"] = readArray(readObject(sessionReadSchema{"questionId": readString(), "label": readString(), "options": readArray(option, 1000), "multiple": readBool(), "allowCustom": readBool(), "required": readBool(), "sensitive": readBool()}), 1000)
		case "form":
			p["canDismiss"] = readBool()
			p["fields"] = readArray(sessionReadSchema{"oneOf": fieldVariants}, 1000)
		}
		interactionVariants = append(interactionVariants, readObject(p))
	}
	extras := map[string]sessionReadSchema{
		"user_message": {"content": readArray(part, 1000)}, "assistant_message": {"content": readArray(part, 1000)}, "reasoning": {"text": readString()},
		"tool_call":   {"callId": readString(), "name": readString(), "input": readString(), "output": readArray(part, 1000), "status": readEnum("running", "completed", "failed"), "truncated": readBool()},
		"interaction": {"interaction": sessionReadSchema{"oneOf": interactionVariants}}, "error": {"code": readString(), "message": readString()}, "compaction": {"summary": readString()},
		"todo": {"items": readArray(readObject(sessionReadSchema{"id": readString(), "text": readString(), "status": readEnum("pending", "in_progress", "completed")}), 1000)},
	}
	variants := []any{}
	for _, kind := range []string{"user_message", "assistant_message", "reasoning", "tool_call", "interaction", "error", "compaction", "todo"} {
		p := extras[kind]
		p["entryId"] = readUUID()
		p["entrySeq"] = readSequence()
		p["revision"] = readSequence()
		p["kind"] = readEnum(kind)
		variants = append(variants, readObject(p))
	}
	return sessionReadSchema{"oneOf": variants}
}
func sessionReadPageSchema() sessionReadSchema {
	ref := readObject(sessionReadSchema{"cursor": readCursor(), "sha256": readHash(), "byteLength": readBytes()})
	resource := readObject(sessionReadSchema{"resourceId": readUUID(), "status": readEnum("pending", "available", "unavailable", "failed"), "name": readString(), "mediaType": readNullable(readString()), "byteLength": readNullable(readBytes()), "sha256": readNullable(readHash())})
	item := readObject(sessionReadSchema{"entryId": readUUID(), "entrySeq": readSequence(), "revision": readSequence(), "kind": readEnum("user_message", "assistant_message", "reasoning", "tool_call", "interaction", "error", "compaction", "todo"), "role": readEnum("user", "assistant", nil), "timestamp": readNullable(readString()), "body": readNullable(sessionReadBodySchema()), "truncated": readBool(), "contentRef": readNullable(ref), "resources": readArray(resource, 20), "resourcesTruncated": readBool()})
	item["oneOf"] = []any{sessionReadSchema{"properties": sessionReadSchema{"truncated": readEnum(false), "contentRef": sessionReadSchema{"type": "null"}, "body": sessionReadSchema{"type": "object"}}}, sessionReadSchema{"properties": sessionReadSchema{"truncated": readEnum(true), "contentRef": sessionReadSchema{"type": "object"}, "body": sessionReadSchema{"type": "null"}}}}
	return readObject(sessionReadSchema{"sessionId": readUUID(), "historyEpoch": readString(), "source": readEnum("live", "archive"), "items": readArray(item, 200), "beforeCursor": readNullable(readCursor()), "hasMoreBefore": readBool(), "coverage": readObject(sessionReadSchema{"state": readEnum("complete", "partial"), "reason": readNullable(readString())}), "observedAt": readTimestamp()})
}
func sessionReadToolDefinition(name string) *sdk.Tool {
	input := sessionReadSchema{"projectId": readUUID(), "taskId": readUUID()}
	optional := []string{}
	var data sessionReadSchema
	switch name {
	case "current":
		data = readObject(sessionReadSchema{"status": readEnum("registered", "not_registered", "not_applicable"), "claimId": readNullable(readUUID()), "agentControlMode": readEnum("web", "herdr", nil), "session": readNullable(sessionReadInspectionSchema())})
	case "list":
		input["cursor"] = readCursor()
		input["limit"] = sessionReadSchema{"type": "integer", "minimum": 1, "maximum": 200, "default": 20}
		optional = []string{"cursor", "limit"}
		archive := readObject(sessionReadSchema{"state": readEnum("unavailable", "pending", "ready", "failed"), "sha256": readNullable(readHash()), "byteLength": readNullable(readBytes()), "completeness": readEnum("complete", "partial", nil)})
		data = readObject(sessionReadSchema{"items": readArray(readObject(sessionReadSchema{"sessionId": readUUID(), "claimId": readUUID(), "executionGeneration": readSequence(), "agentControlMode": readEnum("web", "herdr"), "contentKind": readEnum("native_timeline", "terminal_recording"), "createdAt": readTimestamp(), "endedAt": readNullable(readTimestamp()), "currentBinding": readBool(), "archive": archive}), 200), "nextCursor": readNullable(readCursor())})
	case "show":
		input["sessionId"] = readUUID()
		data = sessionReadInspectionSchema()
	case "read":
		input["sessionId"] = readUUID()
		input["before"] = readCursor()
		input["limit"] = sessionReadSchema{"type": "integer", "minimum": 1, "maximum": 200, "default": 20}
		input["conversation"] = readBool()
		optional = []string{"before", "limit", "conversation"}
		data = sessionReadPageSchema()
	case "entry":
		input["sessionId"] = readUUID()
		input["cursor"] = readCursor()
		data = readObject(sessionReadSchema{"sessionId": readUUID(), "historyEpoch": readString(), "source": readEnum("live", "archive"), "entryId": readUUID(), "revision": readSequence(), "sha256": readHash(), "byteLength": readBytes(), "offset": readBytes(), "fragment": sessionReadSchema{"type": "string", "maxLength": 32768}, "nextCursor": readNullable(readCursor()), "eof": readBool(), "observedAt": readTimestamp()})
	}
	meta := readObject(sessionReadSchema{"requestId": readString(), "observedAt": readTimestamp(), "partial": readBool(), "refs": readObject(sessionReadSchema{"projectId": readUUID(), "taskId": readUUID(), "sessionId": readUUID()}, "sessionId")}, "observedAt", "partial", "refs")
	err := readObject(sessionReadSchema{"code": readString(), "message": readString(), "requestId": readString(), "writeOutcome": readString(), "phase": readString(), "refs": sessionReadSchema{"type": "object"}}, "writeOutcome", "phase", "refs")
	output := readObject(sessionReadSchema{"data": data, "meta": meta, "error": err}, "data", "meta", "error")
	output["oneOf"] = []any{sessionReadSchema{"required": []string{"data", "meta"}, "not": sessionReadSchema{"required": []string{"error"}}}, sessionReadSchema{"required": []string{"error"}, "not": sessionReadSchema{"required": []string{"data"}}}}
	description := map[string]string{"current": "Read the current Task Session association without falling back to history.", "list": "List the Task's Sessions, newest first, with stable cursor pagination.", "show": "Inspect one exact Task Session's identity, state and readable source.", "read": "Read recent or earlier messages from one Task Session. Conversation filtering applies to this page only. Large entries expose a contentRef for task_session_entry.", "entry": "Read the next UTF-8 chunk of an exact Session entry. Preserve cursor, revision, byte length and SHA-256 when assembling its canonical JSON."}[name]
	return &sdk.Tool{Name: "task_session_" + name, Description: description, InputSchema: readObject(input, optional...), OutputSchema: output, Annotations: &sdk.ToolAnnotations{ReadOnlyHint: true}}
}
