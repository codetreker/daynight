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
