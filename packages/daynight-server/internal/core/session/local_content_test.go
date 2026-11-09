package session

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestRelayPersistsOnlyControlLedger(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	marker := "private-content-" + uuid.NewString()
	writes := observeContentLedger(t, f, marker)
	f.dao.Expect("InsertSessionOperation", 1)
	f.dao.Expect("SetSessionOperationReceipt", 3)
	f.dao.Expect("SetSessionOperationEpoch", 1)
	epoch := *f.data.Session.SourceEpoch
	state := controlState()
	state.Controls.Settings[0].Description = &marker
	entry := map[string]any{"entryId": uuid.NewString(), "entrySeq": "1", "revision": "1", "kind": "assistant_message", "content": []any{map[string]any{"type": "text", "text": marker}}}
	resource := sp.Resource{ResourceID: uuid.NewString(), Status: "pending", Name: marker}
	if _, err := f.s.Handle(f.ControllerPhase(ctx, map[string]int{"TouchSession": 1, "SaveSession": 1}), sp.ControllerMessage{Type: "events", ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: encode(state)}, {SourceSeq: "2", Kind: "timeline_upsert", Payload: encode(entry)}, {SourceSeq: "3", Kind: "resource", Payload: encode(resource)}}}); err != nil {
		t.Fatal(err)
	}
	selectContentHandle(t, f)
	command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "test", OperationID: uuid.NewString(), Kind: "send_message", Payload: encode(map[string]any{"content": []any{map[string]any{"type": "text", "text": marker}}, "expectedTurnId": nil})}
	receipt, err := f.s.Submit(f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1}), f.p, f.project, f.task, v.SessionID, command)
	if err != nil {
		t.Fatal(err)
	}
	f.SelectOperationWrite(t)
	f.SelectSessionWrite(t)
	f.data.AcceptedIDs = []string{command.OperationID}
	offers, err := f.s.Poll(f.ControllerPhase(ctx, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "SaveSession": 1}), v.ControllerFence)
	if err != nil || len(offers) != 1 || !strings.Contains(string(encode(offers)), marker) {
		t.Fatalf("live command missing: %v %v", offers, err)
	}
	selectContentOffer(t, f)
	if _, err = f.s.Handle(f.ControllerPhase(ctx, map[string]int{"SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1}), sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: command.OperationID}); err != nil {
		t.Fatal(err)
	}
	f.SelectReceiptWrite(t)
	selectContentHandle(t, f)
	receipt.State = "failed"
	receipt.Error = &sp.OperationError{Code: "native_operation_error", Message: marker}
	if _, err = f.s.Handle(f.ControllerPhase(ctx, map[string]int{"SessionOperation": 1, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1}), sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &receipt}); err != nil {
		t.Fatal(err)
	}
	f.SelectReceiptWrite(t)
	selectContentHandle(t, f)
	// Retransmitting the native receipt must remain idempotent despite omission of
	// diagnostics from the durable ledger.
	if _, err = f.s.Handle(f.ControllerPhase(ctx, map[string]int{"SessionOperation": 1, "TouchSession": 1, "SaveSession": 1}), sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &receipt}); err != nil {
		t.Fatal(err)
	}
	selectContentHandle(t, f)
	if writes.sessions == 0 || writes.operations != 1 || writes.receipts == 0 {
		t.Fatalf("durable write observations: %#v", writes)
	}
	raw := encode(f.data.Session.Snapshot)
	var snapshot map[string]any
	if err = json.Unmarshal(raw, &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot["controls"] != nil || snapshot["currentTurnId"] != nil || snapshot["activity"] != "unknown" {
		t.Fatalf("dynamic snapshot persisted: %s", raw)
	}
	fresh := New(f.writer)
	got, err := fresh.Current(f.TaskPhase(ctx, map[string]int{"CurrentTaskSession": 1, "SessionBotID": 1, "LockSession": 1}), f.p, f.project, f.task)
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
			if _, err := f.s.Submit(f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1}), f.p, f.project, f.task, v.SessionID, command); err != nil {
				t.Fatal(err)
			}
			f.SelectOperationWrite(t)
			f.SelectSessionWrite(t)
			if boundary != "accepted" {
				f.data.AcceptedIDs = []string{command.OperationID}
				if _, err := f.s.Poll(f.ControllerPhase(ctx, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "SaveSession": 1}), v.ControllerFence); err != nil {
					t.Fatal(err)
				}
				selectContentOffer(t, f)
			}
			if boundary == "dispatching" {
				if _, err := f.s.Handle(f.ControllerPhase(ctx, map[string]int{"SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1}), sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: command.OperationID}); err != nil {
					t.Fatal(err)
				}
				f.SelectReceiptWrite(t)
				selectContentHandle(t, f)
			}
			epoch, seq := *f.data.Session.SourceEpoch, decimal(f.data.Session.SourceSeq)
			fresh := New(f.writer)
			freshFixture := f
			freshFixture.s = fresh
			grant, err := fresh.Grant(f.BrowserPhase(ctx, map[string]int{"SetSessionGrant": 1, "SaveSession": 1}), f.p, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: v.ExecutionGeneration, Kind: "reconnect"})
			if err != nil {
				t.Fatal(err)
			}
			f.SelectGrantWrite(t)
			hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: seq, SchemaVersion: 1, ProjectionVersion: 1}
			if _, err = fresh.Connect(f.GrantPhase(ctx, nil), grant.Token, hello, uuid.NewString()); err == nil {
				t.Fatal("second relay stole a live lease")
			}
			expired := f.s.now().Add(-HeartbeatTimeout - time.Second)
			f.data.Session.LastSeen = &expired
			next, err := fresh.Connect(f.GrantPhase(ctx, map[string]int{"ConnectSession": 1, "SaveSession": 1}), grant.Token, hello, uuid.NewString())
			if err != nil {
				t.Fatal(err)
			}
			freshFixture.SelectConnectionWrite(t)
			state := "not_submitted"
			if boundary == "dispatching" {
				state = "dispatching"
			}
			if _, err = fresh.Handle(f.ControllerPhase(ctx, map[string]int{"SessionOperation": 1, "LockCredential": 1 + contentCaseCalls(boundary != "dispatching"), "ProjectAccess": 1 + contentCaseCalls(boundary != "dispatching"), "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "UnreconciledSessionOperations": 1, "TouchSession": 1, "SaveSession": 1}), sp.ControllerMessage{Type: "reconcile", ControllerFence: next.ControllerFence, Operations: []sp.Reconciliation{{OperationID: command.OperationID, State: state}}, Final: true}); err != nil {
				t.Fatal(err)
			}
			f.SelectEpochWrite(t)
			f.SelectReceiptWrite(t)
			selectContentHandle(t, f)
			nativeState := idleState()
			if _, err = fresh.Handle(f.ControllerPhase(ctx, map[string]int{"UnreconciledSessionOperationCount": 1, "TouchSession": 1, "SaveSession": 1}), sp.ControllerMessage{Type: "sync_state", ControllerFence: next.ControllerFence, State: &nativeState, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
				t.Fatal(err)
			}
			selectContentHandle(t, f)
			if boundary == "accepted" {
				f.data.AcceptedIDs = []string{command.OperationID}
			}
			if offers, err := fresh.Poll(f.ControllerPhase(ctx, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": contentCaseCalls(boundary == "accepted"), "LockCredential": 1 + contentCaseCalls(boundary == "accepted"), "ProjectAccess": 1 + contentCaseCalls(boundary == "accepted"), "SetSessionOperationReceipt": contentCaseCalls(boundary == "accepted"), "SaveSession": contentCaseCalls(boundary == "accepted")}), next.ControllerFence); err != nil || len(offers) != 0 {
				t.Fatalf("lost body replayed: %v %v", offers, err)
			}
			if boundary == "accepted" {
				f.SelectReceiptWrite(t)
				f.SelectSessionWrite(t)
			}
			receipt, err := fresh.Operation(f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1}), f.p, f.project, f.task, v.SessionID, command.OperationID)
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
			if _, err = f.s.Poll(f.ControllerPhase(ctx, nil), v.ControllerFence); err == nil {
				t.Fatal("old relay fence survived")
			}
		})
	}
}

func TestSourceFloorReconnectRequiresFreshLiveState(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	_, _, cursor, err := f.s.BrowserPoll(f.BrowserPhase(ctx, nil), f.p, f.project, f.task, v.SessionID, "")
	if err != nil {
		t.Fatal(err)
	}
	epoch := *f.data.Session.SourceEpoch
	grant, err := f.s.Grant(f.BrowserPhase(ctx, map[string]int{"SetSessionGrant": 1, "SaveSession": 1}), f.p, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"})
	if err != nil {
		t.Fatal(err)
	}
	floor := "100"
	f.SelectGrantWrite(t)
	current, err := f.s.Connect(f.GrantPhase(ctx, map[string]int{"ConnectSession": 1, "SaveSession": 1}), grant.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: "1", SourceFloor: &floor, SchemaVersion: 1, ProjectionVersion: 1}, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	f.SelectConnectionWrite(t)
	if current.HistoryEpoch == v.HistoryEpoch || current.Synchronized {
		t.Fatal("reconnect trusted lost live history")
	}
	if seq, err := f.s.SourceSeq(f.ControllerPhase(ctx, nil), current.ControllerFence); err != nil || seq != 100 {
		t.Fatal(seq, err)
	}
	if _, _, _, err = f.s.BrowserPoll(f.BrowserPhase(ctx, nil), f.p, f.project, f.task, v.SessionID, cursor); err == nil {
		t.Fatal("old event cursor crossed content reset")
	}
	state := idleState()
	apply(t, f, sp.ControllerMessage{Type: "events", ControllerFence: current.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "101", Kind: "state", Payload: encode(state)}}})
	c := sp.Command{Fence: current.Fence, Protocol: sp.Protocol, RequestID: "test", OperationID: uuid.NewString(), Kind: "send_message", Payload: encode(sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: "new input"}}})}
	if _, err = f.s.Submit(f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1}), f.p, f.project, f.task, v.SessionID, c); err == nil {
		t.Fatal("ordinary state bypassed explicit synchronization")
	}
	apply(t, f, sp.ControllerMessage{Type: "sync_state", ControllerFence: current.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}, map[string]int{"UnreconciledSessionOperationCount": 1})
	if _, err = f.s.Submit(f.BrowserPhase(ctx, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1}), f.p, f.project, f.task, v.SessionID, c); err != nil {
		t.Fatal(err)
	}
}
