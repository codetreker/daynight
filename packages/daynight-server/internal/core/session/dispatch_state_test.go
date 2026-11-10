package session

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func sessionRuntimeCommittedScopes(t *testing.T, f fixture, expectedCalls int) {
	t.Helper()
	completion := store.Completion{Outcome: store.TransactionCommitted}
	calls := 0
	t.Cleanup(func() {
		if calls != expectedCalls {
			t.Errorf("Session scope calls = %d, want %d", calls, expectedCalls)
		}
	})
	f.writer.WriteFn = func(ctx context.Context, callback func(store.SessionScope) error) (store.Completion, error) {
		calls++
		if calls > expectedCalls {
			t.Fatal("extra Session transaction")
		}
		if ctx.Err() != nil || f.dao.phaseFor(ctx) == nil {
			t.Fatal("Session operation lost its live, planned context")
		}
		if err := callback(f.writer); err != nil {
			t.Fatalf("Session callback: %v", err)
		}
		return completion, nil
	}
}

func sessionRuntimeEnvelope(t *testing.T, response map[string]any, snapshot sp.Snapshot, kind string) {
	t.Helper()
	for key, expected := range map[string]any{"type": kind, "protocol": sp.Protocol, "sessionId": snapshot.SessionID, "claimId": snapshot.ClaimID, "executionGeneration": snapshot.ExecutionGeneration, "connectionEpoch": snapshot.ConnectionEpoch} {
		if response[key] != expected {
			t.Fatalf("controller response %s = %#v, want %#v", key, response[key], expected)
		}
	}
}

func TestDispatchRechecksChangedActivityAfterOfferWithoutRetiringController(t *testing.T) {
	f, snapshot := connectFixture(t)
	sessionRuntimeCommittedScopes(t, f, 10)
	ctx := t.Context()
	epoch := *f.data.Session.SourceEpoch
	native := "native-session"
	state := sp.State{NativeSessionID: &native, InitialInputState: "provider_accepted", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	publish := func(seq string) {
		t.Helper()
		batch := uuid.NewString()
		ack, err := fixtureHandle(f, ctx, sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, SourceEpoch: epoch, BatchID: batch, Events: []sp.SourceEvent{{SourceSeq: seq, Kind: "state", Payload: encode(fixtureCopy(state))}}}, map[string]int{"TouchSession": 1, "SaveSession": 1})
		if err != nil || ack["type"] != "events_ack" || ack["batchId"] != batch || ack["sourceEpoch"] != epoch || ack["lastAckedSourceSeq"] != seq {
			t.Fatalf("state source ACK = %#v, %v", ack, err)
		}
		sessionRuntimeEnvelope(t, ack, snapshot, "events_ack")
		written := f.writes.Session
		if written == nil || written.SourceSeq != number(seq) || written.SourceEpoch == nil || *written.SourceEpoch != epoch || !reflect.DeepEqual(written.SourceEpochs, []string{epoch}) || written.Snapshot.Identity.NativeSessionID == nil || *written.Snapshot.Identity.NativeSessionID != native || written.Snapshot.InitialInputState != state.InitialInputState {
			t.Fatalf("state proposal lost source/native identity: %#v", written)
		}
		durableState := sp.State{NativeSessionID: written.Snapshot.Identity.NativeSessionID, InitialInputState: written.Snapshot.InitialInputState, Synchronized: written.Snapshot.Synchronized, Activity: written.Snapshot.Activity, CurrentTurnID: written.Snapshot.CurrentTurnID, Capabilities: written.Snapshot.Capabilities, Controls: written.Snapshot.Controls, TurnStartedAt: written.Snapshot.TurnStartedAt, CleanupInteractionIDs: written.Snapshot.CleanupInteractionIDs}
		expectedDurableState := sp.State{NativeSessionID: &native, InitialInputState: "provider_accepted", Activity: "unknown"}
		if written.Snapshot.ConnectionState != "disconnected" || !reflect.DeepEqual(durableState, expectedDurableState) {
			t.Fatalf("durable controller state = %#v (connection %q), want %#v (connection disconnected)", durableState, written.Snapshot.ConnectionState, expectedDurableState)
		}
		f.s.liveMutex.Lock()
		cell := f.s.live[snapshot.SessionID]
		f.s.liveMutex.Unlock()
		if cell == nil {
			t.Fatal("state completion did not retain the live Session")
		}
		cell.mu.Lock()
		live := fixtureCopy(cell.value.Snapshot)
		cell.mu.Unlock()
		actualState := sp.State{NativeSessionID: live.Identity.NativeSessionID, InitialInputState: live.InitialInputState, Synchronized: live.Synchronized, Activity: live.Activity, CurrentTurnID: live.CurrentTurnID, Capabilities: live.Capabilities, Controls: live.Controls, TurnStartedAt: live.TurnStartedAt, CleanupInteractionIDs: live.CleanupInteractionIDs}
		if !reflect.DeepEqual(actualState, state) {
			t.Fatalf("published controller state = %#v, want %#v", actualState, state)
		}
		f.SelectSessionWrite(t)
		f.SelectTouchWrite(t)
	}
	submitAndOffer := func() sp.Command {
		t.Helper()
		command := sp.Command{Protocol: sp.Protocol, RequestID: "stale-offer", Fence: snapshot.Fence, OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"bounded test input"}],"expectedTurnId":null}`)}
		expectedReceipt := sp.Operation{Fence: snapshot.Fence, Protocol: sp.Protocol, OperationID: command.OperationID, Kind: "send_message", State: "accepted"}
		f.data.Operation = nil
		f.data.PendingCount = 0
		receipt, err := fixtureSubmit(f, ctx, f.p, snapshot, fixtureCopy(command), map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1})
		if err != nil || !reflect.DeepEqual(receipt, expectedReceipt) {
			t.Fatalf("submit receipt = %#v, %v", receipt, err)
		}
		summary := fixtureCopy(command)
		summary.RequestID, summary.Payload = "", json.RawMessage(`{}`)
		written := f.writes.Operation
		if written == nil || written.SessionID != snapshot.SessionID || written.OperationID != command.OperationID || written.Actor != f.p || len(written.Hash) != 32 || !reflect.DeepEqual(written.Command, summary) || !reflect.DeepEqual(written.Receipt, expectedReceipt) {
			t.Fatal("operation proposal changed the actor, command or accepted receipt")
		}
		f.data.OperationDeadline = f.s.now().Add(time.Minute)
		f.SelectOperationWrite(t)
		f.SelectSessionWrite(t)
		f.data.AcceptedIDs = []string{command.OperationID}
		offers, err := fixturePoll(f, ctx, snapshot.ControllerFence, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "SaveSession": 1})
		if err != nil || len(offers) != 1 || offers[0]["type"] != "operation_offer" || !reflect.DeepEqual(offers[0]["command"], command) {
			t.Fatalf("original offer = %#v, %v", offers, err)
		}
		expectedReceipt.State = "offered"
		if f.writes.Epoch == nil || *f.writes.Epoch != 1 || f.writes.Receipt == nil || !reflect.DeepEqual(*f.writes.Receipt, expectedReceipt) {
			t.Fatal("offer proposal changed the receipt or connection epoch")
		}
		f.SelectReceiptWrite(t)
		f.SelectEpochWrite(t)
		f.SelectSessionWrite(t)
		f.data.AcceptedIDs = nil
		return command
	}
	begin := func(command sp.Command, expectedKind, expectedState string) {
		t.Helper()
		response, err := fixtureHandle(f, ctx, sp.ControllerMessage{Type: "operation_begin", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, OperationID: command.OperationID}, map[string]int{"SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1})
		if err != nil || response["type"] != expectedKind || response["sessionId"] != snapshot.SessionID || response["connectionEpoch"] != snapshot.ConnectionEpoch {
			t.Fatalf("begin response = %#v, %v", response, err)
		}
		sessionRuntimeEnvelope(t, response, snapshot, expectedKind)
		expected := sp.Operation{Fence: snapshot.Fence, Protocol: sp.Protocol, OperationID: command.OperationID, Kind: command.Kind, State: expectedState}
		if f.writes.Receipt == nil || !reflect.DeepEqual(*f.writes.Receipt, expected) {
			t.Fatalf("begin receipt proposal = %#v, want %#v", f.writes.Receipt, expected)
		}
		if expectedKind == "receipt_ack" {
			expected.Error = &sp.OperationError{Code: "permission_or_state_changed", Message: "Operation no longer has current permission or state."}
			if !reflect.DeepEqual(response["operation"], expected) {
				t.Fatalf("stale offer receipt = %#v, want %#v", response["operation"], expected)
			}
		} else if response["operationId"] != command.OperationID {
			t.Fatal("following operation authorization changed its identity")
		}
		f.SelectReceiptWrite(t)
		f.SelectSessionWrite(t)
		f.SelectTouchWrite(t)
	}

	publish("1")
	command := submitAndOffer()
	state.Activity = "unknown"
	publish("2")
	begin(command, "receipt_ack", "rejected")
	ack, err := fixtureHandle(f, ctx, sp.ControllerMessage{Type: "heartbeat", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence}, map[string]int{"TouchSession": 1, "SaveSession": 1})
	if err != nil || ack["type"] != "heartbeat_ack" || ack["sessionId"] != snapshot.SessionID || ack["connectionEpoch"] != snapshot.ConnectionEpoch {
		t.Fatalf("controller retired after stale offer: %#v, %v", ack, err)
	}
	sessionRuntimeEnvelope(t, ack, snapshot, "heartbeat_ack")
	f.SelectSessionWrite(t)
	f.SelectTouchWrite(t)
	state.Activity = "idle"
	publish("3")
	begin(submitAndOffer(), "operation_authorized", "dispatching")
}
