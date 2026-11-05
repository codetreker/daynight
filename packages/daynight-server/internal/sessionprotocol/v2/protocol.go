package v2

import (
	"encoding/json"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"reflect"
)

var envelopeSchema = fields{"protocol": literal(Protocol), "schemaVersion": literal(float64(2)), "projectionVersion": literal(float64(1)), "type": func(v any) bool { _, ok := v.(string); return ok }, "sessionId": uuid, "claimId": uuid, "executionGeneration": positive, "agentControlMode": enums("herdr", "web"), "contentKind": enums("terminal_recording", "native_timeline"), "payload": func(any) bool { return true }}
var leaseSchema = fields{"leaseId": uuid, "holderUserId": uuid, "browserClientId": uuid, "controlEpoch": positive, "expiresAt": timestamp}
var action = enums("acquire_control", "renew_control", "release_control", "resolve_initial_assignment", "resume_automation", "paste", "keys")
var keys = enums("Enter", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "Ctrl+C", "Ctrl+D", "Ctrl+U")

// DecodeMessage validates the complete union, including receipt digest integrity.
// A valid decoded stop proof remains an assertion that its consumer must verify.
func DecodeMessage(data []byte) (Message, error) {
	var out Message
	if len(data) > MaxMetadataBytes {
		return out, invalid("invalid_payload")
	}
	value, err := strictJSON(data)
	if err != nil {
		return out, err
	}
	m := mapAt(value)
	if m == nil {
		return out, invalid("invalid_payload")
	}
	if m["protocol"] != Protocol || m["schemaVersion"] != float64(2) || m["projectionVersion"] != float64(1) {
		return out, invalid("unsupported_protocol")
	}
	if !enums("terminal_recording", "native_timeline")(m["contentKind"]) {
		return out, invalid("unsupported_content_kind")
	}
	if !object(value, envelopeSchema) {
		return out, invalid("invalid_payload")
	}
	if m["type"] == "native_snapshot" {
		if m["agentControlMode"] != "web" || m["contentKind"] != "native_timeline" {
			return out, invalid("unsupported_content_kind")
		}
		raw, _ := json.Marshal(m["payload"])
		snapshot, e := sp.DecodeSnapshot(raw)
		if e != nil {
			return out, invalid("invalid_payload")
		}
		if snapshot.SessionID != m["sessionId"] || snapshot.ClaimID != m["claimId"] || snapshot.ExecutionGeneration != m["executionGeneration"] || snapshot.TestExecutionID != "" {
			return out, invalid("stale_fence")
		}
		envelope := map[string]any{}
		for k, v := range m {
			if k != "payload" {
				envelope[k] = v
			}
		}
		out.Envelope, err = decodeValue[Envelope](envelope)
		if err != nil {
			return Message{}, err
		}
		out.Payload = NativeSnapshot{Snapshot: snapshot}
		return out, nil
	}
	if m["agentControlMode"] != "herdr" || m["contentKind"] != "terminal_recording" {
		return out, invalid("unsupported_content_kind")
	}
	if !validPayload(stringAt(m["type"]), m["payload"], stringAt(m["executionGeneration"])) {
		return out, invalid("invalid_payload")
	}
	raw, err := CanonicalJSON(m)
	if err != nil {
		return out, err
	}
	if err = json.Unmarshal(raw, &out.Envelope); err != nil {
		return Message{}, err
	}
	p := m["payload"]
	switch out.Type {
	case "registration":
		out.Payload, err = decodeValue[Registration](p)
	case "automation_recovery_prepare":
		out.Payload, err = decodeValue[AutomationRecoveryPrepare](p)
	case "automation_recovery":
		out.Payload, err = decodeValue[AutomationRecovery](p)
	case "automation_recovery_state":
		out.Payload, err = decodeValue[AutomationRecoveryState](p)
	case "registration_ack":
		out.Payload, err = decodeValue[RegistrationAck](p)
	case "snapshot":
		out.Payload, err = decodeValue[Snapshot](p)
	case "control_state":
		out.Payload, err = decodeValue[ControlState](p)
	case "control_request":
		out.Payload, err = decodeValue[ControlRequest](p)
	case "control_dispatch":
		out.Payload, err = decodeValue[ControlDispatch](p)
		if err == nil {
			dispatch := out.Payload.(ControlDispatch)
			digest, e := ControlRequestDigest(dispatch.ActorUserID, dispatch.Request)
			if e != nil || digest != dispatch.RequestDigest {
				return Message{}, invalid("source_corrupt")
			}
		}
	case "control_ack":
		out.Payload, err = decodeValue[ControlAck](p)
	case "recording_responsibility":
		out.Payload, err = decodeValue[RecordingResponsibility](p)
	case "recording_evidence":
		out.Payload, err = decodeValue[RecordingEvidence](p)
	case "operation":
		fields := mapAt(p)
		payload := fields["payload"]
		copy := map[string]any{}
		for k, v := range fields {
			if k != "payload" {
				copy[k] = v
			}
		}
		operation, e := decodeValue[Operation](copy)
		err = e
		if fields["kind"] == "paste" {
			operation.Payload, err = decodeValue[Paste](payload)
		} else {
			operation.Payload, err = decodeValue[Keys](payload)
		}
		out.Payload = operation
	case "operation_result":
		out.Payload, err = decodeValue[OperationResult](p)
	case "generation_ledger":
		out.Payload, err = decodeValue[GenerationLedger](p)
	case "finalization":
		out.Payload, err = decodeValue[Finalization](p)
	case "archive_status":
		out.Payload, err = decodeValue[ArchiveStatus](p)
	case "receipt":
		out.Payload, err = decodeValue[Receipt](p)
		if err == nil {
			want := stringAt(mapAt(p)["dispositionDigest"])
			delete(mapAt(p), "dispositionDigest")
			canonical, e := CanonicalJSON(m)
			if e != nil || HashBytes(canonical) != want {
				return Message{}, invalid("source_corrupt")
			}
		}
	}
	if err != nil {
		return Message{}, invalid("invalid_payload")
	}
	return out, nil
}
func validPayload(kind string, v any, generation string) bool {
	m := mapAt(v)
	switch kind {
	case "registration":
		if !object(v, fields{"registrationId": uuid, "mode": enums("register", "reconnect"), "owner": nested(ownerSchema), "binding": nested(bindingSchema), "connectionEpoch": nullable(positive), "capabilities": nested(fields{"observe": boolean, "control": boolean, "archive": boolean})}) {
			return false
		}
		c := mapAt(m["capabilities"])
		return (m["mode"] == "register") == (m["connectionEpoch"] == nil) && !(c["control"] == true && c["observe"] == false)
	case "automation_recovery_prepare", "automation_recovery", "automation_recovery_state":
		return validAutomationRecovery(kind, v, generation)
	case "registration_ack":
		return object(v, fields{"registrationId": uuid, "connectionEpoch": positive})
	case "snapshot":
		return object(v, fields{"connectionEpoch": positive, "segmentId": uuid, "segmentOrdinal": positive, "binding": nested(bindingSchema), "frame": validFrame, "recorded": boolean})
	case "control_state":
		if !object(v, fields{"connectionEpoch": positive, "controlEpoch": positive, "state": enums("automation", "manual", "suspended", "closing", "closed"), "lease": nullable(nested(leaseSchema)), "initialAssignment": enums("pending", "dispatching", "transport_completed", "unknown", "unconfirmed"), "availableActions": arrayOf(action, 0, 7, "$"), "unavailableReason": nullable(errorCode)}) {
			return false
		}
		if (m["state"] == "manual") != (m["lease"] != nil) {
			return false
		}
		if m["lease"] != nil && mapAt(m["lease"])["controlEpoch"] != m["controlEpoch"] {
			return false
		}
		if m["state"] == "automation" && enums("unknown", "unconfirmed")(m["initialAssignment"]) || m["state"] == "manual" && m["initialAssignment"] == "dispatching" {
			return false
		}
		actions := m["availableActions"].([]any)
		if enums("closing", "closed")(m["state"]) && len(actions) > 0 {
			return false
		}
		for _, a := range actions {
			if enums("paste", "keys")(a) && m["state"] != "manual" {
				return false
			}
		}
		return true
	case "control_request":
		if !object(v, fields{"operationId": uuid, "connectionEpoch": positive, "controlEpoch": positive, "action": enums("acquire_control", "renew_control", "release_control", "resolve_initial_assignment", "resume_automation"), "browserClientId": uuid, "leaseId": nullable(uuid), "draftHandled": boolean, "initialUnknownDisposition": nullable(enums("delivered_continue"))}) {
			return false
		}
		if m["action"] == "resolve_initial_assignment" {
			return m["leaseId"] == nil && m["draftHandled"] == false && m["initialUnknownDisposition"] == "delivered_continue"
		}
		if m["action"] == "resume_automation" {
			return m["leaseId"] == nil && m["draftHandled"] == true && m["initialUnknownDisposition"] == nil
		}
		return m["draftHandled"] == false && m["initialUnknownDisposition"] == nil && ((m["action"] == "acquire_control") == (m["leaseId"] == nil))
	case "control_dispatch":
		return object(v, fields{"actorUserId": uuid, "requestDigest": hash, "request": func(value any) bool { return validPayload("control_request", value, generation) }})
	case "control_ack":
		return object(v, fields{"requestDigest": hash, "durable": literal(true), "controlState": func(value any) bool { return validPayload("control_state", value, generation) }, "result": func(value any) bool {
			return validPayload("operation_result", value, generation) && enums("transport_completed", "rejected", "unknown")(mapAt(value)["state"])
		}})
	case "recording_responsibility":
		return object(v, fields{"responsibilityId": uuid, "recordingEnabled": boolean})
	case "recording_evidence":
		return object(v, fields{"responsibilityId": uuid, "evidenceId": uuid, "revision": positive, "selectedFrameCount": decimal, "registeredFrameCount": decimal, "captureError": nullable(errorCode), "closed": boolean, "journalSha256": hash, "sourceSha256": hash}) && decimalValue(stringAt(m["registeredFrameCount"])) <= decimalValue(stringAt(m["selectedFrameCount"]))
	case "operation":
		if !object(v, fields{"operationId": uuid, "connectionEpoch": positive, "segmentId": uuid, "binding": nested(bindingSchema), "controlEpoch": positive, "leaseId": uuid, "leaseSeq": positive, "kind": enums("paste", "keys"), "payload": func(any) bool { return true }}) {
			return false
		}
		if m["kind"] == "paste" {
			return object(m["payload"], fields{"text": validPaste})
		}
		return object(m["payload"], fields{"key": keys})
	case "operation_result":
		if !object(v, fields{"operationId": uuid, "state": enums("queued", "dispatching", "transport_completed", "rejected", "unknown"), "errorCode": nullable(errorCode)}) {
			return false
		}
		if m["state"] == "rejected" {
			return m["errorCode"] != nil
		}
		if m["state"] == "unknown" {
			return m["errorCode"] == "input_unknown"
		}
		return m["errorCode"] == nil
	case "generation_ledger":
		return object(v, fields{"runs": func(v any) bool { return validRuns(v, generation, m["finalizationId"] != nil) }, "finalizationId": nullable(uuid)})
	case "finalization":
		return object(v, fields{"finalizationId": uuid, "claimTerminal": literal(true), "runs": func(v any) bool { return validRuns(v, generation, true) }})
	case "archive_status":
		return validArchiveStatus(v)
	case "receipt":
		return validReceipt(v)
	default:
		return false
	}
}
func bodyFields(m map[string]any, present bool) bool {
	if !present {
		return m["sha256"] == nil && m["byteLength"] == nil && m["completeness"] == nil
	}
	return hash(m["sha256"]) && positive(m["byteLength"]) && decimalValue(stringAt(m["byteLength"])) <= MaxArchiveBytes && completeness(m["completeness"])
}
func validArchiveStatus(v any) bool {
	if !object(v, fields{"state": enums("pending", "ready", "failed", "unavailable"), "sha256": nullable(hash), "byteLength": nullable(positive), "completeness": nullable(completeness), "errorCode": nullable(errorCode), "finalizationId": nullable(uuid)}) {
		return false
	}
	m := mapAt(v)
	switch m["state"] {
	case "ready":
		return bodyFields(m, true) && m["errorCode"] == nil && m["finalizationId"] != nil
	case "unavailable":
		return bodyFields(m, false) && unavailableReason(m["errorCode"]) && m["finalizationId"] != nil
	case "failed":
		return bodyFields(m, false) && m["errorCode"] != nil
	default:
		return bodyFields(m, false)
	}
}
func validReceipt(v any) bool {
	evidenceSchema := fields{"recordingEnabled": boolean, "selectedFrameCount": decimal, "registeredFrameCount": decimal, "captureError": nullable(errorCode)}
	if !object(v, fields{"finalizationId": uuid, "disposition": enums("ready", "unavailable"), "dispositionDigest": hash, "reason": nullable(unavailableReason), "sha256": nullable(hash), "byteLength": nullable(positive), "completeness": nullable(completeness), "evidence": nullable(nested(evidenceSchema))}) {
		return false
	}
	m := mapAt(v)
	if m["disposition"] == "ready" {
		return bodyFields(m, true) && m["reason"] == nil && m["evidence"] == nil
	}
	return bodyFields(m, false) && validNoRecordingEvidence(m["evidence"], m["reason"])
}

func validNoRecordingEvidence(value, reason any) bool {
	evidence := mapAt(value)
	return unavailableReason(reason) && object(value, fields{"recordingEnabled": boolean, "selectedFrameCount": decimal, "registeredFrameCount": decimal, "captureError": nullable(errorCode)}) && evidence["selectedFrameCount"] == "0" && evidence["registeredFrameCount"] == "0" && evidence["captureError"] == nil && reflect.DeepEqual(evidence["recordingEnabled"], reason == "ended_before_first_sample")
}

// ReceiptDigest computes the disposition identity from the entire original fence
// and receipt, omitting only dispositionDigest. It does not hash archive content.
func ReceiptDigest(message Message) (string, error) {
	if message.Type != "receipt" {
		return "", invalid("invalid_payload")
	}
	if _, ok := message.Payload.(Receipt); !ok {
		return "", invalid("invalid_payload")
	}
	raw, err := CanonicalJSON(message)
	if err != nil {
		return "", err
	}
	// The canonical encoder has already validated this fixed typed union.
	value, _ := strictJSON(raw)
	m := mapAt(value)
	delete(mapAt(m["payload"]), "dispositionDigest")
	canonical, _ := CanonicalJSON(m)
	return HashBytes(canonical), nil
}
