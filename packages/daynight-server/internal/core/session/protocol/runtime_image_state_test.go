package sessionprotocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestActualRuntimeDefaultImageStateAcrossControllerFrames(t *testing.T) {
	_, source, _, _ := runtime.Caller(0)
	file := filepath.Join(filepath.Dir(source), "../../../../../daynight/test/session/fixtures/runtime-image-state.json")
	raw, e := os.ReadFile(file)
	if e != nil {
		t.Fatal(e)
	}
	state, e := DecodeState(raw)
	if e != nil || state.ProviderImages == nil || state.ProviderImages.ReasonCode == nil || *state.ProviderImages.ReasonCode != "profile_disabled" {
		t.Fatal("actual default Controller state rejected", state, e)
	}
	fence := ControllerFence{Fence: Fence{SessionID: "11111111-1111-4111-8111-111111111111", TestExecutionID: "22222222-2222-4222-8222-222222222222", ExecutionGeneration: "1"}, ConnectionEpoch: "1"}
	for _, kind := range []string{"sync_state", "events"} {
		message := map[string]any{"protocol": Protocol, "sessionId": fence.SessionID, "testExecutionId": fence.TestExecutionID, "executionGeneration": "1", "connectionEpoch": "1", "type": kind}
		if kind == "sync_state" {
			message["state"], message["pendingInteractions"] = json.RawMessage(raw), []any{}
		} else {
			message["sourceEpoch"], message["batchId"], message["events"] = "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", []SourceEvent{{SourceSeq: "1", Kind: "state", Payload: raw}}
		}
		encoded, e := json.Marshal(message)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = DecodeController(encoded); e != nil {
			t.Fatal("actual default state rejected in "+kind, e)
		}
	}
	var value map[string]any
	if e = json.Unmarshal(raw, &value); e != nil {
		t.Fatal(e)
	}
	images := value["providerImages"].(map[string]any)
	images["reasonCode"] = "unregistered_reason"
	invalid, _ := json.Marshal(value)
	if _, e = DecodeState(invalid); e == nil {
		t.Fatal("unregistered capability reason accepted")
	}
	images["reasonCode"], images["send"] = "profile_disabled", "supported"
	invalid, _ = json.Marshal(value)
	if _, e = DecodeState(invalid); e == nil {
		t.Fatal("disabled profile advertised native image support")
	}
}
