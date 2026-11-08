package sessionprotocol

import (
	"encoding/json"
	"testing"
)

func TestTestFenceStrictUnion(t *testing.T) {
	raw := []byte(`{"protocol":"daynight.session.v1","requestId":"r","operationId":"10000000-0000-0000-0000-000000000001","sessionId":"10000000-0000-0000-0000-000000000002","testExecutionId":"10000000-0000-0000-0000-000000000003","executionGeneration":"1","kind":"cancel","payload":{"expectedTurnId":"turn"}}`)
	if _, err := DecodeCommand(raw); err != nil {
		t.Fatal(err)
	}
	var mixed map[string]any
	_ = json.Unmarshal(raw, &mixed)
	mixed["claimId"] = "10000000-0000-0000-0000-000000000004"
	b, _ := json.Marshal(mixed)
	if _, err := DecodeCommand(b); err == nil {
		t.Fatal("mixed scope accepted")
	}
	delete(mixed, "claimId")
	delete(mixed, "testExecutionId")
	b, _ = json.Marshal(mixed)
	if _, err := DecodeCommand(b); err == nil {
		t.Fatal("missing scope accepted")
	}
}

func TestTestRegistrationAndGrantRemainStrict(t *testing.T) {
	reg := TestRegistration{Protocol: Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: "10000000-0000-0000-0000-000000000001", TestExecutionID: "10000000-0000-0000-0000-000000000002", ControllerID: "10000000-0000-0000-0000-000000000003", ControllerInstanceID: "10000000-0000-0000-0000-000000000004", Provider: "codex", InitialInput: "none"}
	raw, _ := json.Marshal(reg)
	if _, err := DecodeTestRegistration(raw); err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	_ = json.Unmarshal(raw, &fields)
	fields["claimId"] = reg.TestExecutionID
	raw, _ = json.Marshal(fields)
	if _, err := DecodeTestRegistration(raw); err == nil {
		t.Fatal("mixed registration")
	}
	grant := Grant{Protocol: Protocol, TestExecutionID: reg.TestExecutionID, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"}
	raw, _ = json.Marshal(grant)
	if _, err := DecodeTestGrant(raw); err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeGrant(raw); err == nil {
		t.Fatal("test grant through task parser")
	}
	grant.ClaimID = reg.TestExecutionID
	raw, _ = json.Marshal(grant)
	if _, err := DecodeTestGrant(raw); err == nil {
		t.Fatal("mixed grant")
	}
}

func TestTestSnapshotCannotAcquireTaskIdentityOrInitialization(t *testing.T) {
	snapshot := relayObject(t, commandFixture(t, "snapshot"))
	delete(snapshot, "claimId")
	snapshot["testExecutionId"] = relayID
	identity := snapshot["identity"].(map[string]any)
	for _, field := range []string{"projectId", "taskId", "workerId", "worktreeId"} {
		delete(identity, field)
	}
	identity["ownerUserId"] = relayID
	if _, err := DecodeSnapshot(relayJSON(t, snapshot)); err != nil {
		t.Fatal("valid owner snapshot", err)
	}
	for _, field := range []string{"projectId", "taskId", "workerId", "worktreeId"} {
		identity[field] = relayID
		if _, err := DecodeSnapshot(relayJSON(t, snapshot)); err == nil {
			t.Fatalf("mixed identity accepted: %s", field)
		}
		delete(identity, field)
	}
	delete(identity, "ownerUserId")
	if _, err := DecodeSnapshot(relayJSON(t, snapshot)); err == nil {
		t.Fatal("test snapshot without owner")
	}
	identity["ownerUserId"] = relayID
	delete(snapshot, "testExecutionId")
	snapshot["claimId"] = relayID
	if _, err := DecodeSnapshot(relayJSON(t, snapshot)); err == nil {
		t.Fatal("Task fence with Test identity")
	}
	task := relayObject(t, commandFixture(t, "snapshot"))
	task["initialInputState"] = "not_required"
	if _, err := DecodeSnapshot(relayJSON(t, task)); err == nil {
		t.Fatal("Task bypassed initial input")
	}
}

func TestTestStopProofAndEnvelopePreserveExactScope(t *testing.T) {
	stop := TestStop{Fence: Fence{SessionID: relayID, TestExecutionID: relayID, ExecutionGeneration: "1"}, Protocol: Protocol, ControllerID: relayID, ControllerInstanceID: relayID, StopProof: StopProof{RecordID: relayID, PreviousControllerInstanceID: relayID, StoppedAt: "2026-10-28T01:00:00Z"}}
	for _, kind := range []string{"", "never_started"} {
		stop.StopProof.Kind = kind
		if _, err := DecodeTestStop(relayJSON(t, stop)); err != nil {
			t.Fatal("valid stop proof", kind, err)
		}
	}
	for _, change := range []func(map[string]any){
		func(v map[string]any) { v["claimId"] = relayID },
		func(v map[string]any) { delete(v, "testExecutionId") },
		func(v map[string]any) { v["stopProof"].(map[string]any)["kind"] = "unknown" },
		func(v map[string]any) { v["stopProof"].(map[string]any)["stoppedAt"] = "not-a-time" },
		func(v map[string]any) { v["stopProof"].(map[string]any)["extra"] = true },
	} {
		raw := relayObject(t, relayJSON(t, stop))
		change(raw)
		if _, err := DecodeTestStop(relayJSON(t, raw)); err == nil {
			t.Fatal("malformed or mixed stop proof accepted")
		}
	}
	// Public event envelopes must round-trip with the operation's full binding.
	for _, testScope := range []bool{false, true} {
		fence := Fence{SessionID: relayID, ClaimID: relayID, ExecutionGeneration: "1"}
		if testScope {
			fence.ClaimID = ""
			fence.TestExecutionID = relayID
		}
		receipt := Operation{Fence: fence, Protocol: Protocol, OperationID: relayID, Kind: "send_message", State: "unknown"}
		event := BindingFields(fence, map[string]any{"protocol": Protocol, "sessionId": fence.SessionID, "claimId": fence.ClaimID, "executionGeneration": "1", "connectionEpoch": "1", "eventSeq": "1", "historyEpoch": "history", "kind": "operation", "payload": receipt})
		decoded, err := DecodeEvent(relayJSON(t, event))
		if err != nil || decoded.Fence != fence {
			t.Fatal("scope lost in public receipt", err)
		}
	}
}
