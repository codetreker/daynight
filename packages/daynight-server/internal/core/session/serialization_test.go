package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"reflect"
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

func TestNativeHTMLTimelineProjectionSurvivesReconnectWithoutExpansion(t *testing.T) {
	f, snapshot := connectFixture(t)
	sessionRuntimeCommittedScopes(t, f, 10)
	ctx := t.Context()
	epoch := *f.data.Session.SourceEpoch
	entryID := uuid.NewString()
	expectedEntry := map[string]any{"entryId": entryID, "entrySeq": "1", "revision": "1", "kind": "tool_call", "callId": "tool-1", "name": "shell", "input": strings.Repeat("<", 200000), "output": []any{map[string]any{"type": "text", "text": strings.Repeat(">", 200000)}}, "status": "completed", "truncated": false}
	nativeJSON := func(value any) []byte {
		t.Helper()
		var buffer bytes.Buffer
		encoder := json.NewEncoder(&buffer)
		encoder.SetEscapeHTML(false)
		if err := encoder.Encode(value); err != nil {
			t.Fatal(err)
		}
		return bytes.TrimSuffix(buffer.Bytes(), []byte("\n"))
	}
	poll := func(cursor string) (sp.Snapshot, []map[string]any, string) {
		t.Helper()
		phase := f.BrowserPhase(ctx, nil)
		defer f.dao.FinishContext(phase)
		current, events, after, err := f.s.BrowserPoll(phase, f.p, f.project, f.task, snapshot.SessionID, cursor)
		if err != nil {
			t.Fatal("browser projection:", err)
		}
		return current, events, after
	}
	sendAndRead := func(sequence string) {
		t.Helper()
		before, _, cursor := poll("")
		batch := uuid.NewString()
		message := map[string]any{"type": "events", "protocol": sp.Protocol, "sessionId": snapshot.SessionID, "claimId": snapshot.ClaimID, "executionGeneration": snapshot.ExecutionGeneration, "connectionEpoch": snapshot.ConnectionEpoch, "sourceEpoch": epoch, "batchId": batch, "events": []any{map[string]any{"sourceSeq": sequence, "kind": "timeline_upsert", "payload": fixtureCopy(expectedEntry)}}}
		raw := nativeJSON(message)
		if len(raw) >= 500000 || !bytes.Contains(raw, []byte(strings.Repeat("<", 200000))) || !bytes.Contains(raw, []byte(strings.Repeat(">", 200000))) {
			t.Fatalf("native controller frame expanded: %d bytes", len(raw))
		}
		decoded, err := sp.DecodeController(raw)
		if err != nil {
			t.Fatal("native controller decode:", err)
		}
		ack, err := fixtureHandle(f, ctx, decoded, map[string]int{"TouchSession": 1, "SaveSession": 1})
		if err != nil || ack["type"] != "events_ack" || ack["batchId"] != batch || ack["sourceEpoch"] != epoch || ack["lastAckedSourceSeq"] != sequence || ack["sessionId"] != snapshot.SessionID || ack["connectionEpoch"] != snapshot.ConnectionEpoch {
			t.Fatalf("native event ACK = %#v, %v", ack, err)
		}
		sessionRuntimeEnvelope(t, ack, snapshot, "events_ack")
		if f.writes.Session == nil || f.writes.Session.SourceSeq != number(sequence) || f.writes.Session.SourceEpoch == nil || *f.writes.Session.SourceEpoch != epoch || f.writes.Session.Snapshot.LastTimelineSeq != "1" {
			t.Fatal("native event proposal changed its source or timeline identity")
		}
		f.SelectSessionWrite(t)
		f.SelectTouchWrite(t)
		after, events, nextCursor := poll(cursor)
		if len(events) != 1 || nextCursor == cursor || after.ControllerFence != snapshot.ControllerFence || after.LastTimelineSeq != "1" {
			t.Fatalf("native browser event projection = %#v", events)
		}
		event := events[0]
		if event["kind"] != "timeline_upsert" || event["protocol"] != sp.Protocol || event["sessionId"] != snapshot.SessionID || event["claimId"] != snapshot.ClaimID || event["executionGeneration"] != snapshot.ExecutionGeneration || event["connectionEpoch"] != snapshot.ConnectionEpoch || event["historyEpoch"] != before.HistoryEpoch || event["eventSeq"] != after.LastEventSeq || !reflect.DeepEqual(event["payload"], expectedEntry) {
			t.Fatal("native timeline projection changed the complete entry or event identity")
		}
		encoded, err := sp.MarshalWire(event)
		if err != nil || len(encoded) >= 500000 || !bytes.Contains(encoded, []byte(strings.Repeat("<", 200000))) || !bytes.Contains(encoded, []byte(strings.Repeat(">", 200000))) {
			t.Fatalf("projected native event expanded: %d bytes, %v", len(encoded), err)
		}
		if _, err := sp.DecodeEvent(encoded); err != nil {
			t.Fatal("projected native event cannot be decoded:", err)
		}
	}

	sendAndRead("1")
	phase := f.ControllerPhase(ctx, map[string]int{"DisconnectSession": 1, "SaveSession": 1})
	if err := f.s.Disconnect(phase, snapshot.ControllerFence); err != nil {
		t.Fatal("disconnect:", err)
	}
	f.dao.FinishContext(phase)
	f.SelectDisconnectWrite(t)
	f.SelectSessionWrite(t)
	previous := snapshot
	snapshot = reconnect(t, f, snapshot)
	if snapshot.Fence != previous.Fence || snapshot.ConnectionEpoch != "2" || f.data.Session.SourceEpoch == nil || *f.data.Session.SourceEpoch != epoch || f.data.Session.SourceSeq != 1 {
		t.Fatal("reconnect changed the Session or source identity")
	}
	synchronizeFixture(t, f, snapshot)
	sendAndRead("2")
}
