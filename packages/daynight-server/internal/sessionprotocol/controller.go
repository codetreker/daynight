package sessionprotocol

import "encoding/json"

func DecodeRegistration(data []byte) (Registration, error) {
	return decode[Registration](data, nested(schema{"protocol": enum(Protocol), "registrationId": identifier, "claimId": identifier, "workerId": identifier, "worktreeId": identifier, "provider": enum("codex", "claude", "copilot"), "controllerId": identifier, "controllerInstanceId": identifier}))
}
func DecodeGrant(data []byte) (Grant, error) {
	value, err := decode[Grant](data, nested(schema{
		"protocol": enum(Protocol), "claimId": identifier, "controllerId": identifier, "controllerInstanceId": identifier, "executionGeneration": sequence,
		"kind": enum("bootstrap", "reconnect"), "previousGeneration": optional(sequence), "stopProof": optional(nested(schema{"recordId": identifier, "previousControllerInstanceId": identifier, "stoppedAt": timestamp})),
	}))
	if err != nil {
		return Grant{}, err
	}
	if (value.PreviousGeneration == nil) != (value.StopProof == nil) {
		return Grant{}, errInvalid
	}
	return value, nil
}

var stateSchema = schema{
	"controls": nested(controlsSchema), "turnStartedAt": optional(turnStartedAt),
	"cleanupInteractionIds": many(identifier, 0, 1000, "$"), "nativeSessionId": optional(key), "initialInputState": initialState, "synchronized": boolean, "activity": activity, "currentTurnId": optional(key), "capabilities": nested(capabilitiesSchema),
}

func DecodeState(data []byte) (State, error) { return decode[State](data, nested(stateSchema)) }
func DecodeSourceEvent(data []byte) (SourceEvent, error) {
	value, err := decode[SourceEvent](data, nested(schema{"sourceSeq": sequence, "kind": enum("state", "timeline_upsert", "resource", "gap"), "payload": func(json.RawMessage) bool { return true }}))
	if err != nil {
		return SourceEvent{}, err
	}
	switch value.Kind {
	case "state":
		_, err = DecodeState(value.Payload)
	case "timeline_upsert":
		_, err = DecodeSourceTimeline(value.Payload)
	case "resource":
		_, err = DecodeResource(value.Payload)
	case "gap":
		if !validateObject(value.Payload, schema{"reason": text}) {
			err = errInvalid
		}
	}
	if err != nil {
		return SourceEvent{}, err
	}
	return value, nil
}

var reconciliationSchema = schema{"operationId": identifier, "state": enum("not_submitted", "dispatching", "provider_accepted", "confirmed", "failed", "rejected", "expired", "unknown"), "providerResult": providerResult, "error": optional(nested(errorSchema))}

func DecodeController(data []byte) (ControllerMessage, error) {
	if len(data) > MaxFrameBytes || !validUnicode(data) {
		return ControllerMessage{}, errInvalid
	}
	var kind struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(data, &kind) != nil {
		return ControllerMessage{}, errInvalid
	}
	var fields schema
	if kind.Type == "hello" {
		fields = extend(fenceSchema, schema{"type": enum("hello"), "protocol": enum(Protocol), "schemaVersion": version, "projectionVersion": version, "controllerId": identifier, "controllerInstanceId": identifier, "provider": enum("codex", "claude", "copilot"), "sourceEpoch": identifier, "lastAckedSourceSeq": zeroSequence})
	} else {
		extras := map[string]schema{
			"events":            {"batchId": identifier, "sourceEpoch": identifier, "events": many(func(data json.RawMessage) bool { _, err := DecodeSourceEvent(data); return err == nil }, 1, MaxBatchEvents, "")},
			"source_reset":      {"previousSourceEpoch": identifier, "newSourceEpoch": identifier, "reason": text},
			"operation_begin":   {"operationId": identifier},
			"operation_receipt": {"operation": func(data json.RawMessage) bool { _, err := DecodeOperation(data); return err == nil }},
			"reconcile":         {"operations": many(nested(reconciliationSchema), 0, MaxBatchEvents, ""), "final": boolean},
			"heartbeat":         {},
		}
		extra, found := extras[kind.Type]
		if !found {
			return ControllerMessage{}, errInvalid
		}
		fields = extend(extend(fenceSchema, schema{"type": enum(kind.Type), "protocol": enum(Protocol), "connectionEpoch": sequence}), extra)
	}
	var value ControllerMessage
	var err error
	if kind.Type == "hello" {
		value, err = decodeVersioned[ControllerMessage](data, fields)
	} else {
		value, err = decode[ControllerMessage](data, nested(fields))
	}
	if err != nil {
		return ControllerMessage{}, err
	}
	value.Raw = append(json.RawMessage(nil), data...)
	return value, nil
}
