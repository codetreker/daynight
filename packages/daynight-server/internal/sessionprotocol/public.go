package sessionprotocol

import "encoding/json"

var operationSchema = extend(fenceSchema, schema{
	"protocol": enum(Protocol), "operationId": identifier, "kind": enum("send_message", "cancel", "interaction_response", "update_setting", "execute_command", "refresh_controls"),
	"state":          enum("accepted", "offered", "dispatching", "provider_accepted", "confirmed", "failed", "rejected", "expired", "unknown"),
	"providerResult": providerResult, "error": optional(nested(errorSchema)),
})

func DecodeOperation(data []byte) (Operation, error) {
	return decode[Operation](data, nested(operationSchema))
}

var resourceSchema = schema{
	"resourceId": identifier, "status": enum("pending", "available", "failed", "unavailable"), "name": key,
	"mediaType":  optional(pattern(`^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$`)),
	"byteLength": optional(zeroSequence), "sha256": optional(pattern(`^[a-f0-9]{64}$`)), "error": optional(text),
}

func DecodeResource(data []byte) (Resource, error) {
	result, err := decode[Resource](data, nested(resourceSchema))
	if err != nil {
		return Resource{}, err
	}
	if result.MediaType != nil && len(*result.MediaType) > 256 {
		return Resource{}, errInvalid
	}
	if result.Status == "available" && (result.SHA256 == nil || result.MediaType == nil || result.ByteLength == nil || result.Error != nil) {
		return Resource{}, errInvalid
	}
	return result, nil
}

func validateIdentity(data json.RawMessage) bool {
	fields := schema{"projectId": identifier, "taskId": identifier, "workerId": identifier, "worktreeId": identifier, "controllerId": identifier, "controllerInstanceId": identifier, "agentControlMode": enum("web"), "provider": enum("codex", "claude", "copilot"), "nativeSessionId": optional(key)}
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(data, &raw)
	if _, ok := raw["ownerUserId"]; ok {
		for _, k := range []string{"projectId", "taskId", "workerId", "worktreeId"} {
			delete(fields, k)
		}
		fields["ownerUserId"] = identifier
	}
	return validateObject(data, fields)
}

var snapshotSchema = extend(fenceSchema, schema{
	"controls": nested(controlsSchema), "turnStartedAt": optional(turnStartedAt),
	"protocol": enum(Protocol), "schemaVersion": version, "projectionVersion": version, "connectionEpoch": zeroSequence,
	"identity":        validateIdentity,
	"sessionRevision": sequence, "historyEpoch": key, "lastEventSeq": zeroSequence, "lastTimelineSeq": zeroSequence,
	"cleanupInteractionIds": many(identifier, 0, 1000, "$"), "initialInputState": initialState, "synchronized": boolean, "lifecycle": enum("active", "draining", "archived"),
	"connectionState": enum("connected", "disconnected", "synchronizing"), "activity": activity, "currentTurnId": optional(key),
	"capabilities": nested(capabilitiesSchema), "operations": nested(schema{"canSend": boolean, "canCancel": boolean, "canRespond": boolean}),
})

func DecodeSnapshot(data []byte) (Snapshot, error) {
	result, err := decodeVersioned[Snapshot](data, snapshotSchema)
	if err != nil {
		return Snapshot{}, err
	}
	if (result.TestExecutionID != "") != (result.Identity.OwnerUserID != "") || (result.InitialInputState == "not_required" && result.TestExecutionID == "") {
		return Snapshot{}, errInvalid
	}
	writes := result.Operations.CanSend || result.Operations.CanCancel || result.Operations.CanRespond
	writable := (result.Lifecycle == "active" || result.Lifecycle == "draining" && !result.Operations.CanSend && !result.Operations.CanCancel && len(result.CleanupInteractionIDs) > 0) && result.ConnectionState == "connected" && result.Synchronized
	if (result.ConnectionEpoch == "0" && (result.ConnectionState == "connected" || writes)) || (writes && !writable) {
		return Snapshot{}, errInvalid
	}
	if result.Operations.CanSend && (!result.Capabilities.Send || (result.Identity.NativeSessionID == nil && !(result.TestExecutionID != "" && result.InitialInputState == "not_required" && result.Activity == "idle")) || (result.InitialInputState != "provider_accepted" && result.InitialInputState != "confirmed" && result.InitialInputState != "not_required") || !(result.Activity == "idle" || (result.Activity == "working" && result.Capabilities.Steer && result.CurrentTurnID != nil))) {
		return Snapshot{}, errInvalid
	}
	if result.Operations.CanCancel && (!result.Capabilities.Cancel || result.CurrentTurnID == nil) {
		return Snapshot{}, errInvalid
	}
	if result.Operations.CanRespond && !result.Capabilities.Respond {
		return Snapshot{}, errInvalid
	}
	return result, nil
}

var optionSchema = schema{"id": key, "label": text}
var options = many(nested(optionSchema), 0, 1000, "id")

func validateFormField(data json.RawMessage) bool {
	var kind struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(data, &kind) != nil {
		return false
	}
	base := schema{"fieldId": key, "label": text, "required": boolean, "type": enum(kind.Type)}
	switch kind.Type {
	case "text":
		return validateObject(data, extend(base, schema{"sensitive": boolean}))
	case "boolean":
		return validateObject(data, base)
	case "select", "multiselect":
		return validateObject(data, extend(base, schema{"options": many(nested(optionSchema), 1, 1000, "id")}))
	case "number":
		if !validateObject(data, extend(base, schema{"min": optional(number), "max": optional(number)})) {
			return false
		}
		var bounds struct {
			Min *float64 `json:"min"`
			Max *float64 `json:"max"`
		}
		_ = json.Unmarshal(data, &bounds)
		return bounds.Min == nil || bounds.Max == nil || *bounds.Min <= *bounds.Max
	default:
		return false
	}
}
func validateQuestion(data json.RawMessage) bool {
	if !validateObject(data, schema{"questionId": key, "label": text, "options": options, "multiple": boolean, "allowCustom": boolean, "required": boolean, "sensitive": boolean}) {
		return false
	}
	var value struct {
		Options     []json.RawMessage `json:"options"`
		AllowCustom bool              `json:"allowCustom"`
	}
	_ = json.Unmarshal(data, &value)
	return len(value.Options) > 0 || value.AllowCustom
}
func validateInteractionValue(data json.RawMessage) bool {
	var value struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal(data, &value) != nil {
		return false
	}
	base := schema{"interactionId": identifier, "revision": sequence, "state": enum("pending", "resolved", "expired"), "title": text, "kind": enum(value.Kind)}
	switch value.Kind {
	case "approval":
		return validateObject(data, extend(base, schema{"detail": emptyText, "actions": many(enum("allow_once", "allow_session", "reject"), 1, 1000, "$")}))
	case "question":
		return validateObject(data, extend(base, schema{"questions": many(validateQuestion, 1, 1000, "questionId"), "canDismiss": boolean}))
	case "form":
		return validateObject(data, extend(base, schema{"fields": many(validateFormField, 1, 1000, "fieldId"), "canDismiss": boolean}))
	default:
		return false
	}
}
func validateMessagePart(data json.RawMessage) bool {
	var value struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(data, &value) != nil {
		return false
	}
	switch value.Type {
	case "text":
		return validateObject(data, schema{"type": enum("text"), "text": emptyText})
	case "resource":
		return validateObject(data, schema{"type": enum("resource"), "resourceId": identifier, "label": text})
	default:
		return false
	}
}

var timelineExtras = map[string]schema{
	"user_message":      {"content": many(validateMessagePart, 0, 1000, "")},
	"assistant_message": {"content": many(validateMessagePart, 0, 1000, "")},
	"reasoning":         {"text": emptyText},
	"tool_call":         {"callId": key, "name": key, "input": emptyText, "output": many(validateMessagePart, 0, 1000, ""), "status": enum("running", "completed", "failed"), "truncated": boolean},
	"interaction":       {"interaction": validateInteractionValue},
	"error":             {"code": key, "message": text},
	"compaction":        {"summary": emptyText},
	"todo":              {"items": many(nested(schema{"id": key, "text": text, "status": enum("pending", "in_progress", "completed")}), 0, 1000, "id")},
}

func decodeTimeline(data []byte, source bool) (TimelineEntry, error) {
	var value struct {
		Kind string `json:"kind"`
	}
	if !validUnicode(data) || json.Unmarshal(data, &value) != nil {
		return TimelineEntry{}, errInvalid
	}
	extra, found := timelineExtras[value.Kind]
	if !found {
		return TimelineEntry{}, errInvalid
	}
	base := schema{"entryId": identifier, "revision": sequence, "kind": enum(value.Kind)}
	if !source {
		base["entrySeq"] = sequence
	}
	if !validateObject(data, extend(base, extra)) {
		return TimelineEntry{}, errInvalid
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(data, &fields)
	return TimelineEntry{EntryID: stringField(fields["entryId"]), EntrySeq: stringField(fields["entrySeq"]), Revision: stringField(fields["revision"]), Kind: value.Kind, Data: fields}, nil
}
func DecodeTimeline(data []byte) (TimelineEntry, error)       { return decodeTimeline(data, false) }
func DecodeSourceTimeline(data []byte) (TimelineEntry, error) { return decodeTimeline(data, true) }

type Event struct {
	ControllerFence
	Protocol     string          `json:"protocol"`
	EventSeq     string          `json:"eventSeq"`
	HistoryEpoch string          `json:"historyEpoch"`
	Kind         string          `json:"kind"`
	Payload      json.RawMessage `json:"payload"`
}

// DecodeEvent is also used to verify persisted public events before streaming.
func DecodeEvent(data []byte) (Event, error) {
	value, err := decode[Event](data, nested(extend(fenceSchema, schema{"protocol": enum(Protocol), "connectionEpoch": zeroSequence, "eventSeq": sequence, "historyEpoch": key, "kind": enum("timeline_upsert", "snapshot", "operation", "resource", "gap"), "payload": func(json.RawMessage) bool { return true }})))
	if err != nil {
		return Event{}, err
	}
	if value.ConnectionEpoch == "0" && value.Kind != "snapshot" {
		return Event{}, errInvalid
	}
	switch value.Kind {
	case "timeline_upsert":
		_, err = DecodeTimeline(value.Payload)
	case "resource":
		_, err = DecodeResource(value.Payload)
	case "gap":
		if !validateObject(value.Payload, schema{"reason": text, "cursor": optional(key)}) {
			err = errInvalid
		}
	case "snapshot":
		var snapshot Snapshot
		snapshot, err = DecodeSnapshot(value.Payload)
		if err == nil && (snapshot.ControllerFence != value.ControllerFence || snapshot.HistoryEpoch != value.HistoryEpoch) {
			err = errInvalid
		}
	case "operation":
		var operation Operation
		operation, err = DecodeOperation(value.Payload)
		if err == nil && operation.Fence != value.Fence {
			err = errInvalid
		}
	}
	if err != nil {
		return Event{}, err
	}
	return value, nil
}
