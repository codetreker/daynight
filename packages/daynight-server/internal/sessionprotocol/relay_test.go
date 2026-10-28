package sessionprotocol

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestReconciliationPreservesExplicitTerminalJournalReceipts(t *testing.T) {
	for _, state := range []string{"rejected", "expired"} {
		message := ControllerMessage{Type: "reconcile", Protocol: Protocol, ControllerFence: ControllerFence{Fence: Fence{SessionID: relayID, ClaimID: relayID, ExecutionGeneration: "2"}, ConnectionEpoch: "3"}, Final: true, Operations: []Reconciliation{{OperationID: relayID, State: state}}}
		parsed, err := DecodeController(relayJSON(t, message))
		if err != nil || len(parsed.Operations) != 1 || parsed.Operations[0].State != state {
			t.Fatalf("terminal journal receipt %s: %#v %v", state, parsed, err)
		}
	}
}

func relayJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func relayObject(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var object map[string]any
	if err := json.Unmarshal(data, &object); err != nil {
		t.Fatal(err)
	}
	return object
}
func relayTimeline(kind string, extra map[string]any) map[string]any {
	result := map[string]any{"entryId": relayID, "entrySeq": "1", "revision": "1", "kind": kind}
	for key, value := range extra {
		result[key] = value
	}
	return result
}
func relayInteraction(kind string, extra map[string]any) map[string]any {
	result := map[string]any{"interactionId": relayID, "revision": "1", "state": "pending", "title": "Request", "kind": kind}
	for key, value := range extra {
		result[key] = value
	}
	return result
}
func relayApproval() map[string]any {
	return relayInteraction("approval", map[string]any{"detail": "", "actions": []any{"allow_once", "reject"}})
}
func relayQuestion() map[string]any {
	return map[string]any{"questionId": "choice", "label": "Choose", "options": []any{map[string]any{"id": "a", "label": "A"}}, "multiple": false, "allowCustom": false, "required": true, "sensitive": false}
}

func TestRelayTimelineVariantsAndServerAssignedSequence(t *testing.T) {
	textPart := map[string]any{"type": "text", "text": ""}
	resourcePart := map[string]any{"type": "resource", "resourceId": relayID, "label": "Output"}
	fields := []any{
		map[string]any{"fieldId": "text", "label": "Text", "required": true, "type": "text", "sensitive": true},
		map[string]any{"fieldId": "number", "label": "Number", "required": false, "type": "number", "min": -1.5, "max": 2},
		map[string]any{"fieldId": "bool", "label": "Enabled", "required": false, "type": "boolean"},
		map[string]any{"fieldId": "select", "label": "Select", "required": true, "type": "select", "options": []any{map[string]any{"id": "a", "label": "A"}}},
		map[string]any{"fieldId": "multi", "label": "Multi", "required": true, "type": "multiselect", "options": []any{map[string]any{"id": "a", "label": "A"}}},
	}
	examples := []map[string]any{
		relayTimeline("user_message", map[string]any{"content": []any{textPart, resourcePart}}),
		relayTimeline("assistant_message", map[string]any{"content": []any{}}),
		relayTimeline("reasoning", map[string]any{"text": ""}),
		relayTimeline("tool_call", map[string]any{"callId": "call", "name": "read", "input": "", "output": []any{textPart, resourcePart}, "status": "completed", "truncated": false}),
		relayTimeline("interaction", map[string]any{"interaction": relayApproval()}),
		relayTimeline("interaction", map[string]any{"interaction": relayInteraction("question", map[string]any{"questions": []any{relayQuestion()}, "canDismiss": true})}),
		relayTimeline("interaction", map[string]any{"interaction": relayInteraction("form", map[string]any{"fields": fields, "canDismiss": false})}),
		relayTimeline("error", map[string]any{"code": "provider_error", "message": "Failed"}),
		relayTimeline("compaction", map[string]any{"summary": ""}),
		relayTimeline("todo", map[string]any{"items": []any{map[string]any{"id": "task", "text": "Work", "status": "pending"}}}),
	}
	for _, value := range examples {
		data := relayJSON(t, value)
		entry, err := DecodeTimeline(data)
		if err != nil {
			t.Fatalf("valid timeline rejected: %s: %v", data, err)
		}
		if !reflect.DeepEqual(relayObject(t, relayJSON(t, entry)), relayObject(t, data)) {
			t.Fatal("timeline changed")
		}
		delete(value, "entrySeq")
		source, err := DecodeSourceTimeline(relayJSON(t, value))
		if err != nil {
			t.Fatal(err)
		}
		if source.EntrySeq != "" {
			t.Fatal("source claims server ordering")
		}
		if !reflect.DeepEqual(relayObject(t, relayJSON(t, source)), relayObject(t, relayJSON(t, value))) {
			t.Fatal("source changed")
		}
		source.EntrySeq = "9007199254740993"
		if _, err := DecodeTimeline(relayJSON(t, source)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRelayRejectsInvalidNestedTimelineValues(t *testing.T) {
	badParts := []any{nil, 5, map[string]any{"type": "file", "path": "/tmp/secret"}, map[string]any{"type": "text", "text": "\x00"}, map[string]any{"type": "resource", "resourceId": relayID, "label": " "}}
	for _, part := range badParts {
		if _, err := DecodeTimeline(relayJSON(t, relayTimeline("user_message", map[string]any{"content": []any{part}}))); err == nil {
			t.Fatalf("accepted part: %v", part)
		}
	}
	cases := []any{nil, 4, map[string]any{}, relayInteraction("unknown", map[string]any{}), relayInteraction("approval", map[string]any{"detail": "", "actions": []any{}}), relayInteraction("approval", map[string]any{"detail": "", "actions": []any{"allow_once", "allow_once"}}), relayInteraction("approval", map[string]any{"detail": "", "actions": []any{"allow_all"}})}
	badQuestions := []any{nil, 3, map[string]any{}, relayQuestion()}
	badQuestions[3].(map[string]any)["options"] = []any{}
	for _, question := range badQuestions {
		cases = append(cases, relayInteraction("question", map[string]any{"questions": []any{question}, "canDismiss": false}))
	}
	cases = append(cases, relayInteraction("question", map[string]any{"questions": []any{relayQuestion(), relayQuestion()}, "canDismiss": false}))
	baseField := func(kind string, extras map[string]any) map[string]any {
		v := map[string]any{"fieldId": "f", "label": "Field", "required": true, "type": kind}
		for k, x := range extras {
			v[k] = x
		}
		return v
	}
	badFields := []any{nil, 3, map[string]any{}, baseField("unknown", nil), baseField("number", map[string]any{"min": 2, "max": 1}), baseField("number", map[string]any{"min": "0", "max": nil}), baseField("select", map[string]any{"options": []any{}}), baseField("text", map[string]any{"sensitive": "true"})}
	for _, field := range badFields {
		cases = append(cases, relayInteraction("form", map[string]any{"fields": []any{field}, "canDismiss": false}))
	}
	for _, interaction := range cases {
		if _, err := DecodeTimeline(relayJSON(t, relayTimeline("interaction", map[string]any{"interaction": interaction}))); err == nil {
			t.Fatalf("accepted interaction: %v", interaction)
		}
	}
	for _, value := range []any{nil, 3, map[string]any{}, relayTimeline("unknown", map[string]any{}), relayTimeline("todo", map[string]any{"items": []any{map[string]any{"id": "a", "text": "A", "status": "pending"}, map[string]any{"id": "a", "text": "A", "status": "pending"}}})} {
		if _, err := DecodeTimeline(relayJSON(t, value)); err == nil {
			t.Fatalf("accepted timeline: %v", value)
		}
	}
}

func TestRelayPublicEventVariantsAndFences(t *testing.T) {
	base := relayObject(t, []byte(`{`+relayFence+`,"eventSeq":"1","historyEpoch":"history"}`))
	snapshot := relayObject(t, commandFixture(t, "snapshot"))
	for _, field := range []string{"sessionId", "claimId", "executionGeneration", "connectionEpoch"} {
		snapshot[field] = base[field]
	}
	snapshot["historyEpoch"] = "history"
	operation := relayObject(t, commandFixture(t, "operation"))
	for _, field := range []string{"sessionId", "claimId", "executionGeneration"} {
		operation[field] = base[field]
	}
	examples := map[string]any{"snapshot": snapshot, "operation": operation, "resource": relayObject(t, commandFixture(t, "resource")), "timeline_upsert": relayTimeline("reasoning", map[string]any{"text": "Thought"}), "gap": map[string]any{"reason": "History unavailable", "cursor": nil}}
	for kind, payload := range examples {
		base["kind"] = kind
		base["payload"] = payload
		if _, err := DecodeEvent(relayJSON(t, base)); err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		base["payload"] = nil
		if _, err := DecodeEvent(relayJSON(t, base)); err == nil {
			t.Fatalf("accepted null %s", kind)
		}
	}
	for _, field := range []string{"sessionId", "claimId", "executionGeneration", "connectionEpoch", "historyEpoch"} {
		original := snapshot[field]
		if field == "sessionId" || field == "claimId" {
			snapshot[field] = "00000000-0000-4000-8000-000000000002"
		} else {
			snapshot[field] = "2"
		}
		base["kind"] = "snapshot"
		base["payload"] = snapshot
		if _, err := DecodeEvent(relayJSON(t, base)); err == nil {
			t.Fatalf("accepted snapshot mismatch %s", field)
		}
		snapshot[field] = original
	}
	operation["claimId"] = "00000000-0000-4000-8000-000000000002"
	base["kind"] = "operation"
	base["payload"] = operation
	if _, err := DecodeEvent(relayJSON(t, base)); err == nil {
		t.Fatal("accepted operation mismatch")
	}
	base["protocol"] = "unknown"
	if _, err := DecodeEvent(relayJSON(t, base)); err == nil {
		t.Fatal("accepted protocol")
	}
}

func TestRelaySnapshotAndResourceWriteGates(t *testing.T) {
	original := relayObject(t, commandFixture(t, "snapshot"))
	modifications := []map[string]any{
		{"connectionEpoch": "0"}, {"lifecycle": "archived"}, {"connectionState": "disconnected"}, {"synchronized": false},
		{"initialInputState": "not_submitted"}, {"activity": "initializing"}, {"currentTurnId": nil},
		{"capabilities": map[string]any{"send": false, "steer": true, "cancel": true, "respond": true}},
		{"capabilities": map[string]any{"send": true, "steer": true, "cancel": false, "respond": true}},
		{"capabilities": map[string]any{"send": true, "steer": true, "cancel": true, "respond": false}},
	}
	for _, mods := range modifications {
		snapshot := relayObject(t, relayJSON(t, original))
		snapshot["activity"] = "working"
		snapshot["currentTurnId"] = "turn"
		snapshot["operations"] = map[string]any{"canSend": true, "canCancel": true, "canRespond": true}
		for k, v := range mods {
			snapshot[k] = v
		}
		if _, err := DecodeSnapshot(relayJSON(t, snapshot)); err == nil {
			t.Fatalf("accepted invalid snapshot gate: %v", mods)
		}
	}
	original["connectionEpoch"] = "0"
	original["connectionState"] = "disconnected"
	original["operations"] = map[string]any{"canSend": false, "canCancel": false, "canRespond": false}
	if _, err := DecodeSnapshot(relayJSON(t, original)); err != nil {
		t.Fatal("registration must be readable", err)
	}
	delete(original, "protocol")
	if _, err := DecodeSnapshot(relayJSON(t, original)); err == nil {
		t.Fatal("missing protocol")
	}
	resource := relayObject(t, commandFixture(t, "resource"))
	for _, field := range []string{"mediaType", "byteLength", "sha256"} {
		copy := relayObject(t, relayJSON(t, resource))
		copy[field] = nil
		if _, err := DecodeResource(relayJSON(t, copy)); err == nil {
			t.Fatalf("available missing %s", field)
		}
	}
	resource["mediaType"] = strings.Repeat("a", 257) + "/plain"
	if _, err := DecodeResource(relayJSON(t, resource)); err == nil {
		t.Fatal("unbounded media type")
	}
	resource["mediaType"] = "text/plain; charset=UTF-8"
	if _, err := DecodeResource(relayJSON(t, resource)); err == nil {
		t.Fatal("accepted unsafe media type")
	}
}

func TestRelayControllerVariantsAndLimits(t *testing.T) {
	base := relayObject(t, []byte(`{`+relayFence+`}`))
	hello := relayObject(t, []byte(`{"type":"hello","protocol":"daynight.session.v1","schemaVersion":1,"projectionVersion":1,"sessionId":"`+relayID+`","claimId":"`+relayID+`","executionGeneration":"1","controllerId":"`+relayID+`","controllerInstanceId":"`+relayID+`","provider":"claude","sourceEpoch":"`+relayID+`","lastAckedSourceSeq":"0"}`))
	if _, err := DecodeController(relayJSON(t, hello)); err != nil {
		t.Fatal(err)
	}
	examples := map[string]map[string]any{
		"heartbeat": {}, "operation_begin": {"operationId": relayID}, "operation_receipt": {"operation": relayObject(t, commandFixture(t, "operation"))},
		"source_reset": {"previousSourceEpoch": relayID, "newSourceEpoch": relayID, "reason": "Projection reset"},
		"reconcile":    {"final": true, "operations": []any{map[string]any{"operationId": relayID, "state": "not_submitted", "providerResult": nil, "error": nil}, map[string]any{"operationId": relayID, "state": "failed", "providerResult": "handled", "error": map[string]any{"code": "native_error", "message": "Native failed"}}}},
	}
	for kind, extra := range examples {
		message := relayObject(t, relayJSON(t, base))
		message["type"] = kind
		for k, v := range extra {
			message[k] = v
		}
		if _, err := DecodeController(relayJSON(t, message)); err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
	}
	state := map[string]any{"nativeSessionId": nil, "initialInputState": "not_submitted", "synchronized": false, "activity": "initializing", "currentTurnId": nil, "capabilities": map[string]any{"send": false, "steer": false, "cancel": false, "respond": false}}
	for kind, payload := range map[string]any{"state": state, "gap": map[string]any{"reason": "History lost"}, "resource": relayObject(t, commandFixture(t, "resource"))} {
		event := map[string]any{"sourceSeq": "1", "kind": kind, "payload": payload}
		if _, err := DecodeSourceEvent(relayJSON(t, event)); err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		event["payload"] = nil
		if _, err := DecodeSourceEvent(relayJSON(t, event)); err == nil {
			t.Fatalf("accepted null %s", kind)
		}
	}
	for _, data := range [][]byte{nil, []byte(`null`), []byte(`42`), []byte(`{"type":"other"}`), []byte(strings.Repeat(" ", MaxFrameBytes+1))} {
		if _, err := DecodeController(data); err == nil {
			t.Fatalf("accepted invalid %q", data[:min(len(data), 50)])
		}
	}
	base["type"] = "events"
	base["batchId"] = relayID
	base["sourceEpoch"] = relayID
	for _, events := range []any{nil, []any{}, make([]any, 101)} {
		base["events"] = events
		if _, err := DecodeController(relayJSON(t, base)); err == nil {
			t.Fatal("accepted invalid batch")
		}
	}
	hello["schemaVersion"] = 2
	if _, err := DecodeController(relayJSON(t, hello)); err == nil {
		t.Fatal("accepted incompatible schema")
	}
}

func TestRelayGrantRecoveryProof(t *testing.T) {
	value := map[string]any{"protocol": Protocol, "claimId": relayID, "controllerId": relayID, "controllerInstanceId": relayID, "executionGeneration": "2", "kind": "reconnect", "previousGeneration": "1", "stopProof": map[string]any{"recordId": relayID, "previousControllerInstanceId": relayID, "stoppedAt": "2026-10-27T10:20:30.123Z"}}
	if _, err := DecodeGrant(relayJSON(t, value)); err != nil {
		t.Fatal(err)
	}
	value["stopProof"].(map[string]any)["stoppedAt"] = "not-a-date"
	if _, err := DecodeGrant(relayJSON(t, value)); err == nil {
		t.Fatal("accepted invalid proof time")
	}
}

func TestRelayNumericVersionIsAValueNotALexicalFence(t *testing.T) {
	data := strings.Replace(string(commandFixture(t, "snapshot")), `"schemaVersion": 1`, `"schemaVersion": 1.0`, 1)
	data = strings.Replace(data, `"projectionVersion": 1`, `"projectionVersion": 1e0`, 1)
	if _, err := DecodeSnapshot([]byte(data)); err != nil {
		t.Fatal("numeric schema versions must match JSON/TypeScript semantics", err)
	}
	hello := []byte(`{"type":"hello","protocol":"daynight.session.v1","schemaVersion":1.0,"projectionVersion":1e0,"sessionId":"` + relayID + `","claimId":"` + relayID + `","executionGeneration":"1","controllerId":"` + relayID + `","controllerInstanceId":"` + relayID + `","provider":"codex","sourceEpoch":"` + relayID + `","lastAckedSourceSeq":"0"}`)
	if _, err := DecodeController(hello); err != nil {
		t.Fatal("numeric hello versions must match JSON/TypeScript semantics", err)
	}
}

func TestRelaySourceCannotProduceUnparseablePublicState(t *testing.T) {
	state := map[string]any{"nativeSessionId": nil, "initialInputState": "not_submitted", "synchronized": false, "activity": "initializing", "currentTurnId": nil, "capabilities": map[string]any{"send": false, "steer": false, "cancel": false, "respond": false}}
	for _, field := range []string{"nativeSessionId", "currentTurnId"} {
		state[field] = " \u2003 "
		if _, err := DecodeState(relayJSON(t, state)); err == nil {
			t.Fatalf("accepted whitespace %s", field)
		}
		state[field] = nil
	}
	if _, err := DecodeSourceEvent(relayJSON(t, map[string]any{"sourceSeq": "1", "kind": "gap", "payload": map[string]any{"reason": " \u2003 "}})); err == nil {
		t.Fatal("accepted whitespace gap")
	}
	if _, err := DecodeController([]byte(`{` + relayFence + `,"type":"source_reset","previousSourceEpoch":"` + relayID + `","newSourceEpoch":"` + relayID + `","reason":" "}`)); err == nil {
		t.Fatal("accepted whitespace reset reason")
	}
}

func TestRelayControllerMarshalKeepsOnlyItsVariant(t *testing.T) {
	for _, data := range []string{
		`{"type":"hello","protocol":"daynight.session.v1","schemaVersion":1,"projectionVersion":1,"sessionId":"` + relayID + `","claimId":"` + relayID + `","executionGeneration":"1","controllerId":"` + relayID + `","controllerInstanceId":"` + relayID + `","provider":"codex","sourceEpoch":"` + relayID + `","lastAckedSourceSeq":"0"}`,
		`{` + relayFence + `,"type":"heartbeat"}`,
		`{` + relayFence + `,"type":"operation_begin","operationId":"` + relayID + `"}`,
		`{` + relayFence + `,"type":"reconcile","operations":[],"final":true}`,
		`{` + relayFence + `,"type":"source_reset","previousSourceEpoch":"` + relayID + `","newSourceEpoch":"` + relayID + `","reason":"Reset"}`,
		`{` + relayFence + `,"type":"events","batchId":"` + relayID + `","sourceEpoch":"` + relayID + `","events":[{"sourceSeq":"1","kind":"gap","payload":{"reason":"Gap"}}]}`,
		`{` + relayFence + `,"type":"operation_receipt","operation":` + string(commandFixture(t, "operation")) + `}`,
	} {
		message, err := DecodeController([]byte(data))
		if err != nil {
			t.Fatal(err)
		}
		encoded := relayJSON(t, message)
		if _, err := DecodeController(encoded); err != nil {
			t.Fatalf("marshal produced invalid variant: %s", encoded)
		}
	}
	if _, err := json.Marshal(ControllerMessage{Type: "unknown"}); err == nil {
		t.Fatal("serialized unsupported message")
	}
}

func TestRelayUnconnectedSnapshotCanBeArchived(t *testing.T) {
	snapshot := relayObject(t, commandFixture(t, "snapshot"))
	snapshot["connectionEpoch"] = "0"
	snapshot["connectionState"] = "disconnected"
	snapshot["lifecycle"] = "archived"
	snapshot["operations"] = map[string]any{"canSend": false, "canCancel": false, "canRespond": false}
	event := map[string]any{"protocol": Protocol, "sessionId": snapshot["sessionId"], "claimId": snapshot["claimId"], "executionGeneration": snapshot["executionGeneration"], "connectionEpoch": "0", "eventSeq": "1", "historyEpoch": snapshot["historyEpoch"], "kind": "snapshot", "payload": snapshot}
	if _, err := DecodeEvent(relayJSON(t, event)); err != nil {
		t.Fatal(err)
	}
	event["kind"] = "gap"
	event["payload"] = map[string]any{"reason": "No connection", "cursor": nil}
	if _, err := DecodeEvent(relayJSON(t, event)); err == nil {
		t.Fatal("non-snapshot event has no controller epoch")
	}
}

func TestRelayReconcileRequiresFinalBatchFlag(t *testing.T) {
	if _, err := DecodeController([]byte(`{` + relayFence + `,"type":"reconcile","operations":[]}`)); err == nil {
		t.Fatal("reconciliation omitted final boundary")
	}
}

func TestRelayStrictObjectsAtEveryEntryPoint(t *testing.T) {
	registration := []byte(`{"protocol":"daynight.session.v1","registrationId":"` + relayID + `","claimId":"` + relayID + `","workerId":"` + relayID + `","worktreeId":"` + relayID + `","controllerId":"` + relayID + `","controllerInstanceId":"` + relayID + `","provider":"codex"}`)
	tests := []struct {
		name   string
		data   []byte
		decode func([]byte) error
	}{
		{"registration", registration, func(data []byte) error { _, err := DecodeRegistration(data); return err }},
		{"snapshot", commandFixture(t, "snapshot"), func(data []byte) error { _, err := DecodeSnapshot(data); return err }},
		{"resource", commandFixture(t, "resource"), func(data []byte) error { _, err := DecodeResource(data); return err }},
		{"operation", commandFixture(t, "operation"), func(data []byte) error { _, err := DecodeOperation(data); return err }},
		{"event", commandFixture(t, "event"), func(data []byte) error { _, err := DecodeEvent(data); return err }},
		{"timeline", relayJSON(t, relayTimeline("interaction", map[string]any{"interaction": relayApproval()})), func(data []byte) error { _, err := DecodeTimeline(data); return err }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.decode(test.data); err != nil {
				t.Fatal("invalid test input", err)
			}
			original := relayObject(t, test.data)
			for field := range original {
				copy := relayObject(t, test.data)
				delete(copy, field)
				if test.decode(relayJSON(t, copy)) == nil {
					t.Fatalf("accepted missing %s", field)
				}
				encoded := string(relayJSON(t, original))
				marker := `"` + field + `":`
				duplicate := strings.Replace(encoded, marker, marker+`null,`+marker, 1)
				if test.decode([]byte(duplicate)) == nil {
					t.Fatalf("accepted duplicate %s", field)
				}
			}
			original["privilegeOverride"] = true
			if test.decode(relayJSON(t, original)) == nil {
				t.Fatal("accepted unknown field")
			}
			for _, invalid := range [][]byte{nil, []byte(`null`), []byte(`[]`), []byte(`{`), append(append([]byte(nil), test.data...), []byte(`{}`)...), []byte(`{"x":"\ud800"}`)} {
				if test.decode(invalid) == nil {
					t.Fatalf("accepted invalid object %q", invalid)
				}
			}
		})
	}
}

const relayID = "00000000-0000-4000-8000-000000000001"
const relayFence = `"protocol":"daynight.session.v1","sessionId":"` + relayID + `","claimId":"` + relayID + `","executionGeneration":"9007199254740993","connectionEpoch":"1"`

func TestRelayPublicFixtures(t *testing.T) {
	for _, name := range []string{"snapshot", "operation", "resource"} {
		t.Run(name, func(t *testing.T) {
			data := commandFixture(t, name)
			var value any
			var err error
			switch name {
			case "snapshot":
				value, err = DecodeSnapshot(data)
			case "operation":
				value, err = DecodeOperation(data)
			case "resource":
				value, err = DecodeResource(data)
			}
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			var original, actual any
			_ = json.Unmarshal(data, &original)
			_ = json.Unmarshal(encoded, &actual)
			if !reflect.DeepEqual(original, actual) {
				t.Fatalf("fixture changed: %s", encoded)
			}
		})
	}
}

func TestRelayControllerSourceBoundary(t *testing.T) {
	data := []byte(`{` + relayFence + `,"type":"events","sourceEpoch":"` + relayID + `","batchId":"` + relayID + `","events":[{"sourceSeq":"1","kind":"timeline_upsert","payload":{"entryId":"` + relayID + `","revision":"1","kind":"reasoning","text":"Thinking"}}]}`)
	message, err := DecodeController(data)
	if err != nil {
		t.Fatal(err)
	}
	if message.ExecutionGeneration != "9007199254740993" || len(message.Events) != 1 {
		t.Fatalf("lost source fence: %+v", message)
	}
	for _, mutated := range []string{
		strings.Replace(string(data), `"connectionEpoch":"1"`, `"connectionEpoch":"0"`, 1),
		strings.Replace(string(data), `"revision":"1"`, `"revision":"1","entrySeq":"0"`, 1),
		strings.Replace(string(data), `"revision":"1"`, `"revision":"01"`, 1),
		strings.Replace(string(data), `"text":"Thinking"`, `"text":"\ud800"`, 1),
		strings.Replace(string(data), `"text":"Thinking"`, `"text":"Thinking","text":"Other"`, 1),
		strings.Replace(string(data), `"sourceSeq":"1"`, `"sourceSeq":1`, 1),
	} {
		if _, err := DecodeController([]byte(mutated)); err == nil {
			t.Fatalf("accepted invalid source: %s", mutated)
		}
	}
}

func TestRelayRegistrationAndGrant(t *testing.T) {
	registration := []byte(`{"protocol":"daynight.session.v1","registrationId":"` + relayID + `","claimId":"` + relayID + `","workerId":"` + relayID + `","worktreeId":"` + relayID + `","controllerId":"` + relayID + `","controllerInstanceId":"` + relayID + `","provider":"codex"}`)
	if _, err := DecodeRegistration(registration); err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeRegistration([]byte(strings.Replace(string(registration), `"codex"`, `"unsupported"`, 1))); err == nil {
		t.Fatal("accepted unsupported provider")
	}
	if _, err := DecodeRegistration([]byte(strings.Replace(string(registration), `"codex"`, `"copilot"`, 1))); err != nil {
		t.Fatalf("Copilot registration rejected: %v", err)
	}
	grant := []byte(`{"protocol":"daynight.session.v1","claimId":"` + relayID + `","controllerId":"` + relayID + `","controllerInstanceId":"` + relayID + `","executionGeneration":"1","kind":"bootstrap","previousGeneration":null,"stopProof":null}`)
	if _, err := DecodeGrant(grant); err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeGrant([]byte(strings.Replace(string(grant), `"previousGeneration":null`, `"previousGeneration":"1"`, 1))); err == nil {
		t.Fatal("accepted missing stop proof")
	}
}

func TestCopilotHelloAndSnapshotPreserveCapabilityGates(t *testing.T) {
	hello := []byte(`{"type":"hello","protocol":"daynight.session.v1","schemaVersion":1,"projectionVersion":1,"sessionId":"` + relayID + `","claimId":"` + relayID + `","executionGeneration":"1","controllerId":"` + relayID + `","controllerInstanceId":"` + relayID + `","provider":"copilot","sourceEpoch":"` + relayID + `","lastAckedSourceSeq":"0"}`)
	if _, err := DecodeController(hello); err != nil {
		t.Fatalf("Copilot hello rejected: %v", err)
	}
	snapshot := relayObject(t, commandFixture(t, "snapshot"))
	snapshot["identity"].(map[string]any)["provider"] = "copilot"
	snapshot["capabilities"].(map[string]any)["steer"] = false
	snapshot["activity"], snapshot["currentTurnId"] = "working", "native-turn"
	snapshot["operations"].(map[string]any)["canSend"] = false
	if _, err := DecodeSnapshot(relayJSON(t, snapshot)); err != nil {
		t.Fatalf("Copilot snapshot rejected: %v", err)
	}
	snapshot["operations"].(map[string]any)["canSend"] = true
	if _, err := DecodeSnapshot(relayJSON(t, snapshot)); err == nil {
		t.Fatal("Copilot implicitly gained steer")
	}
	snapshot["activity"], snapshot["currentTurnId"] = "idle", nil
	snapshot["operations"].(map[string]any)["canCancel"] = false
	if _, err := DecodeSnapshot(relayJSON(t, snapshot)); err != nil {
		t.Fatalf("Idle Copilot cannot send: %v", err)
	}
}
