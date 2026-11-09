package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"strings"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestOperationRetryPreservesHistoricalCanonicalHash(t *testing.T) {
	f, v := connectFixture(t)
	publishState(t, f, v, idleState())
	ctx := context.Background()
	c := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "hash", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"<script>&\u2028"}],"expectedTurnId":null}`)}
	var payload any
	if err := json.Unmarshal(c.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	legacy, err := json.Marshal(sp.BindingFields(c.Fence, map[string]any{"sessionId": c.SessionID, "claimId": c.ClaimID, "executionGeneration": c.ExecutionGeneration, "operationId": c.OperationID, "kind": c.Kind, "payload": payload}))
	if err != nil {
		t.Fatal(err)
	}
	expected := sha256.Sum256(legacy)
	if !bytes.Contains(legacy, []byte(`\u003c`)) || !bytes.Equal(commandHash(c), expected[:]) {
		t.Fatal("historical operation canonicalization changed")
	}
	if _, err = f.s.Submit(f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1}), f.p, f.project, f.task, v.SessionID, c); err != nil {
		t.Fatal(err)
	}
	if f.writes.Operation == nil || !bytes.Equal(f.writes.Operation.Hash, expected[:]) {
		t.Fatal("operation write omitted the canonical intent hash")
	}
	f.SelectOperationWrite(t)
	f.SelectSessionWrite(t)
	f.data.Operation.Hash = expected[:]
	if _, err = f.s.Submit(f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1}), f.p, f.project, f.task, v.SessionID, c); err != nil {
		t.Fatal("historical retry rejected", err)
	}
}

func TestLiveCapacityDoesNotHTMLExpandPendingApprovals(t *testing.T) {
	f, v := connectFixture(t)
	state := idleState()
	nativePending := func(character string) sp.TimelineEntry {
		entry := pendingEntry(t, uuid.NewString(), "1", strings.Repeat(character, 400000), "pending")
		raw, _ := sp.MarshalWire(entry)
		// Reproduce native JSON.stringify input instead of this fixture's legacy encoder.
		raw = bytes.ReplaceAll(raw, []byte(`\u003c`), []byte("<"))
		raw = bytes.ReplaceAll(raw, []byte(`\u003e`), []byte(">"))
		decoded, err := sp.DecodeTimeline(raw)
		if err != nil {
			t.Fatal(err)
		}
		return decoded
	}
	message := sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{nativePending("<"), nativePending(">")}}
	raw, err := sp.MarshalWire(message)
	if err != nil || len(raw) > sp.MaxFrameBytes {
		t.Fatalf("invalid probe: %d %v", len(raw), err)
	}
	decoded, err := sp.DecodeController(raw)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.Handle(f.ControllerPhase(context.Background(), map[string]int{"UnreconciledSessionOperationCount": 1, "TouchSession": 1, "SaveSession": 1}), decoded); err != nil {
		t.Fatal("bounded native approval sync rejected", err)
	}
	selectContentHandle(t, f)
}
