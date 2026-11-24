package sessionprotocol

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestArchiveSourceValidationRetainsEscapedLiteralsAndRejectsOversize(t *testing.T) {
	in := ArchiveSourceRecoveryRequest{Fence: Fence{SessionID: uuid.NewString(), ClaimID: uuid.NewString(), ExecutionGeneration: "1"}, ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), SourceEpoch: uuid.NewString(), OldBatchID: uuid.NewString(), RecoveryID: uuid.NewString(), Cutoff: "1", Events: []SourceEvent{{SourceSeq: "1", Kind: "timeline_upsert", Payload: json.RawMessage(`{"entryId":"` + uuid.NewString() + `","revision":"1","kind":"reasoning","text":"\\u2028 and \u2028"}`)}}}
	wire, err := archiveSourceValidationWire(in)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeArchiveSourceRecovery(wire)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err = json.Unmarshal(decoded.Events[0].Payload, &payload); err != nil || payload["text"] != "\\u2028 and \u2028" {
		t.Fatal("escaped literal changed", payload, err)
	}
	oversized := in
	oversized.Events = make([]SourceEvent, 3)
	for i := range oversized.Events {
		oversized.Events[i] = SourceEvent{SourceSeq: string(rune('1' + i)), Kind: "timeline_upsert", Payload: json.RawMessage(`{"entryId":"` + uuid.NewString() + `","revision":"1","kind":"reasoning","text":"` + strings.Repeat("x", 900_000) + `"}`)}
	}
	if err = ValidateArchiveSourceRecovery(oversized); err == nil {
		t.Fatal("oversized semantic request admitted")
	}
}

func TestArchiveSourceValidationWireRejectsInvalidJSONAndPreservesEscapes(t *testing.T) {
	if _, err := archiveSourceValidationWire(make(chan int)); err == nil {
		t.Fatal("unserializable source value accepted")
	}
	value := map[string]any{"text": "line\n\"quote\" \\u2028 \u2028 \u2029"}
	wire, err := archiveSourceValidationWire(value)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]string
	if err = json.Unmarshal(wire, &decoded); err != nil || decoded["text"] != value["text"] {
		t.Fatal("source validation changed text", decoded, err)
	}
	validTail := ArchiveSourceTailRequest{Fence: Fence{SessionID: uuid.NewString(), ClaimID: uuid.NewString(), ExecutionGeneration: "1"}, ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), SourceEpoch: uuid.NewString(), BatchID: uuid.NewString(), Events: []SourceEvent{{SourceSeq: "1", Kind: "timeline_upsert", Payload: json.RawMessage(`{"entryId":"` + uuid.NewString() + `","revision":"1","kind":"reasoning","text":"valid"}`)}}}
	if err = ValidateArchiveSourceTail(validTail); err != nil {
		t.Fatal("valid source tail refused", err)
	}
	invalidTail := validTail
	invalidTail.BatchID = "invalid"
	if err = ValidateArchiveSourceTail(invalidTail); err == nil {
		t.Fatal("invalid batch identity accepted")
	}
	tail := ArchiveSourceTailRequest{Events: []SourceEvent{{Payload: json.RawMessage(`{`)}}}
	if err = ValidateArchiveSourceTail(tail); err == nil {
		t.Fatal("malformed original event was accepted")
	}
	recovery := ArchiveSourceRecoveryRequest{Events: []SourceEvent{{Payload: json.RawMessage(`{`)}}}
	if err = ValidateArchiveSourceRecovery(recovery); err == nil {
		t.Fatal("malformed recovery event was accepted")
	}
}
