package sessionrelay

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
)

func TestRelayPersistsOnlyControlLedger(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	marker := "private-content-" + uuid.NewString()
	var epoch string
	if err := f.s.DB.Pool.QueryRow(ctx, `SELECT source_epoch::text FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	state := controlState()
	state.Controls.Settings[0].Description = &marker
	entry := map[string]any{"entryId": uuid.NewString(), "entrySeq": "1", "revision": "1", "kind": "assistant_message", "content": []any{map[string]any{"type": "text", "text": marker}}}
	resource := sp.Resource{ResourceID: uuid.NewString(), Status: "pending", Name: marker}
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: encode(state)}, {SourceSeq: "2", Kind: "timeline_upsert", Payload: encode(entry)}, {SourceSeq: "3", Kind: "resource", Payload: encode(resource)}}}); err != nil {
		t.Fatal(err)
	}
	command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "test", OperationID: uuid.NewString(), Kind: "send_message", Payload: encode(map[string]any{"content": []any{map[string]any{"type": "text", "text": marker}}, "expectedTurnId": nil})}
	receipt, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, command)
	if err != nil {
		t.Fatal(err)
	}
	offers, err := f.s.Poll(ctx, v.ControllerFence)
	if err != nil || len(offers) != 1 || !strings.Contains(string(encode(offers)), marker) {
		t.Fatalf("live command missing: %v %v", offers, err)
	}
	if _, err = f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: command.OperationID}); err != nil {
		t.Fatal(err)
	}
	receipt.State = "failed"
	receipt.Error = &sp.OperationError{Code: "native_operation_error", Message: marker}
	if _, err = f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &receipt}); err != nil {
		t.Fatal(err)
	}
	// Retransmitting the native receipt must remain idempotent despite omission of
	// diagnostics from the durable ledger.
	if _, err = f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &receipt}); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"task_sessions", "session_operations", "session_events", "session_timeline", "session_resources"} {
		var payload string
		if err = f.s.DB.Pool.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(t)::text,'[]') FROM `+table+` t`).Scan(&payload); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(payload, marker) {
			t.Fatalf("conversation data persisted in %s", table)
		}
	}
	for _, table := range []string{"session_events", "session_timeline", "session_resources"} {
		var count int
		if err = f.s.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM `+table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s contains %d records: %v", table, count, err)
		}
	}
	var raw []byte
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT snapshot FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var snapshot map[string]any
	if err = json.Unmarshal(raw, &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot["controls"] != nil || snapshot["currentTurnId"] != nil || snapshot["activity"] != "unknown" {
		t.Fatalf("dynamic snapshot persisted: %s", raw)
	}
	fresh := New(f.s.DB)
	got, err := fresh.Current(ctx, f.p, f.project, f.task)
	if err != nil {
		t.Fatal(err)
	}
	snapshotValue, ok := got["session"].(sp.Snapshot)
	if !ok || snapshotValue.Synchronized || snapshotValue.ConnectionState != "disconnected" || snapshotValue.Controls != nil {
		t.Fatalf("restart trusted lost live state: %#v", got)
	}
}

func TestRestartDoesNotReplayLostCommandBodies(t *testing.T) {
	for _, boundary := range []string{"accepted", "offered", "dispatching"} {
		t.Run(boundary, func(t *testing.T) {
			f, v := connectFixture(t)
			ctx := context.Background()
			publishState(t, f, v, idleState())
			command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "test", OperationID: uuid.NewString(), Kind: "send_message", Payload: encode(sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: "must not replay"}}})}
			if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, command); err != nil {
				t.Fatal(err)
			}
			if boundary != "accepted" {
				if _, err := f.s.Poll(ctx, v.ControllerFence); err != nil {
					t.Fatal(err)
				}
			}
			if boundary == "dispatching" {
				if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: command.OperationID}); err != nil {
					t.Fatal(err)
				}
			}
			var epoch, seq string
			if err := f.s.DB.Pool.QueryRow(ctx, `SELECT source_epoch::text,last_source_seq::text FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&epoch, &seq); err != nil {
				t.Fatal(err)
			}
			fresh := New(f.s.DB)
			grant, err := fresh.Grant(ctx, f.p, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: v.ExecutionGeneration, Kind: "reconnect"})
			if err != nil {
				t.Fatal(err)
			}
			hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: seq, SchemaVersion: 1, ProjectionVersion: 1}
			if _, err = fresh.Connect(ctx, grant.Token, hello, uuid.NewString()); err == nil {
				t.Fatal("second relay stole a live lease")
			}
			if _, err = f.s.DB.Pool.Exec(ctx, `UPDATE task_sessions SET last_seen=now()-interval '31 seconds' WHERE id=$1`, v.SessionID); err != nil {
				t.Fatal(err)
			}
			next, err := fresh.Connect(ctx, grant.Token, hello, uuid.NewString())
			if err != nil {
				t.Fatal(err)
			}
			state := "not_submitted"
			if boundary == "dispatching" {
				state = "dispatching"
			}
			if _, err = fresh.Handle(ctx, sp.ControllerMessage{Type: "reconcile", ControllerFence: next.ControllerFence, Operations: []sp.Reconciliation{{OperationID: command.OperationID, State: state}}, Final: true}); err != nil {
				t.Fatal(err)
			}
			nativeState := idleState()
			if _, err = fresh.Handle(ctx, sp.ControllerMessage{Type: "sync_state", ControllerFence: next.ControllerFence, State: &nativeState, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
				t.Fatal(err)
			}
			if offers, err := fresh.Poll(ctx, next.ControllerFence); err != nil || len(offers) != 0 {
				t.Fatalf("lost body replayed: %v %v", offers, err)
			}
			receipt, err := fresh.Operation(ctx, f.p, f.project, f.task, v.SessionID, command.OperationID)
			if err != nil {
				t.Fatal(err)
			}
			expected := "rejected"
			if boundary == "dispatching" {
				expected = "unknown"
			}
			if receipt.State != expected {
				t.Fatalf("%s became %s instead of %s", boundary, receipt.State, expected)
			}
			if _, err = f.s.Poll(ctx, v.ControllerFence); err == nil {
				t.Fatal("old relay fence survived")
			}
		})
	}
}

func TestSourceFloorReconnectRequiresFreshLiveState(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	_, _, cursor, err := f.s.BrowserPoll(ctx, f.p, f.project, f.task, v.SessionID, "")
	if err != nil {
		t.Fatal(err)
	}
	var epoch string
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT source_epoch::text FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	grant, err := f.s.Grant(ctx, f.p, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"})
	if err != nil {
		t.Fatal(err)
	}
	floor := "100"
	current, err := f.s.Connect(ctx, grant.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: "1", SourceFloor: &floor, SchemaVersion: 1, ProjectionVersion: 1}, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if current.HistoryEpoch == v.HistoryEpoch || current.Synchronized {
		t.Fatal("reconnect trusted lost live history")
	}
	if seq, err := f.s.SourceSeq(ctx, current.ControllerFence); err != nil || seq != 100 {
		t.Fatal(seq, err)
	}
	if _, _, _, err = f.s.BrowserPoll(ctx, f.p, f.project, f.task, v.SessionID, cursor); err == nil {
		t.Fatal("old event cursor crossed content reset")
	}
	state := idleState()
	apply(t, f, sp.ControllerMessage{Type: "events", ControllerFence: current.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "101", Kind: "state", Payload: encode(state)}}})
	c := sp.Command{Fence: current.Fence, Protocol: sp.Protocol, RequestID: "test", OperationID: uuid.NewString(), Kind: "send_message", Payload: encode(sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: "new input"}}})}
	if _, err = f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err == nil {
		t.Fatal("ordinary state bypassed explicit synchronization")
	}
	apply(t, f, sp.ControllerMessage{Type: "sync_state", ControllerFence: current.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}})
	if _, err = f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err != nil {
		t.Fatal(err)
	}
}
