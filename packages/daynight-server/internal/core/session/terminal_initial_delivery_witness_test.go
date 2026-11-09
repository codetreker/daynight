package session

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
)

type terminalInitialDeliveryWitness struct {
	fixture
	message v2.Message
	now     time.Time
	writes  []terminalRecord
}

func newTerminalInitialDeliveryWitness(t *testing.T) *terminalInitialDeliveryWitness {
	t.Helper()
	f, message := terminalFixture(t)
	registration := message.Payload.(v2.Registration)
	registration.Capabilities = v2.Capabilities{}
	message.Payload = registration
	witness := &terminalInitialDeliveryWitness{fixture: f, message: message, now: time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)}
	f.s.now = func() time.Time { return witness.now }
	seen := witness.now
	f.terminal.SetRecord(t, &terminalRecord{
		Envelope:           message.Envelope,
		Registration:       registration,
		RegistrationDigest: v2.HashBytes(encode(message)),
		RegistrationEpoch:  "1",
		Owner:              registration.Owner,
		Binding:            registration.Binding,
		Runs: []v2.Run{{
			ExecutionGeneration: "1", Owner: registration.Owner, Binding: registration.Binding,
			StartedAt: terminalTime(witness.now), SegmentIDs: []string{uuid.NewString()},
		}},
		ConnectionEpoch: "1", ChannelEpoch: "1", ControlEpoch: "0", LastLeaseSeq: "0",
		LastSeen: &seen, ServerInstance: f.s.instance, Recording: map[string]terminalRecording{},
	})
	save := f.dao.SaveTerminalFn
	f.dao.SaveTerminalFn = func(ctx context.Context, id string, raw []byte, lastSeen *time.Time, instance string) error {
		if err := save(ctx, id, raw, lastSeen, instance); err != nil {
			return err
		}
		var proposal terminalRecord
		if err := json.Unmarshal(raw, &proposal); err != nil {
			return err
		}
		witness.writes = append(witness.writes, proposal)
		return nil
	}
	return witness
}

func (w *terminalInitialDeliveryWitness) observe(t *testing.T, state v2.ControlState, calls map[string]int) (v2.Message, error) {
	t.Helper()
	w.writes = nil
	w.terminal.ProposedRaw = nil
	message := w.message
	message.Type = "control_state"
	message.Payload = state
	ctx := w.TerminalPhase(t.Context(), false, calls)
	defer w.dao.FinishContext(ctx)
	return w.s.HandleTerminalControl(ctx, w.p, w.project, w.task, message.SessionID, "1", message)
}

func (w *terminalInitialDeliveryWitness) requireState(t *testing.T, initial, activity string, connected bool) {
	t.Helper()
	ctx := w.TerminalPhase(t.Context(), false, map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1})
	defer w.dao.FinishContext(ctx)
	state, err := w.s.TerminalState(ctx, w.p, w.project, w.task, w.message.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	control, ok := state["control"].(*v2.ControlState)
	if !ok || state["connected"] != connected || control.InitialAssignment != initial || control.State != activity || control.ConnectionEpoch != "1" {
		t.Fatalf("initial delivery state changed: connected=%v control=%+v error=%v", state["connected"], control, err)
	}
}

func TestTerminalInitialDeliveryRetryUpdatesControlStateAndProposesWrites(t *testing.T) {
	w := newTerminalInitialDeliveryWitness(t)
	for index, initial := range []string{"pending", "dispatching", "pending", "dispatching", "transport_completed"} {
		w.now = w.now.Add(time.Millisecond)
		state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "automation", InitialAssignment: initial, AvailableActions: []string{"acquire_control"}}
		expected := w.terminal.Record(t)
		expected.Control = &state
		expected.ControlEpoch = "1"
		seen := w.now
		expected.LastSeen = &seen
		calls := map[string]int{"ExpireTerminalOperations": 1, "SaveTerminal": 1}
		if index == 0 {
			calls["InvalidateTerminalOperations"] = 1
		}
		ack, err := w.observe(t, state, calls)
		if err != nil {
			t.Fatalf("initial observation %d (%s): %v", index, initial, err)
		}
		envelope := w.message.Envelope
		envelope.Type = "control_state"
		if !reflect.DeepEqual(ack, v2.Message{Envelope: envelope, Payload: state}) {
			t.Fatalf("initial observation %d did not return its exact acknowledgement: %+v", index, ack)
		}
		if len(w.writes) != 1 || !reflect.DeepEqual(w.writes[0], *expected) {
			t.Fatalf("initial observation %d changed the proposed control record: %+v", index, w.writes)
		}
		w.terminal.SetRecord(t, expected)
	}
	w.requireState(t, "transport_completed", "automation", true)
}

func TestTerminalInitialDeliveryReplayRefusalPreservesResultOnDisconnect(t *testing.T) {
	for _, initial := range []string{"unknown", "unconfirmed", "transport_completed"} {
		t.Run(initial, func(t *testing.T) {
			w := newTerminalInitialDeliveryWitness(t)
			state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "suspended", InitialAssignment: initial, AvailableActions: []string{}}
			expected := w.terminal.Record(t)
			expected.Control = &state
			expected.ControlEpoch = "1"
			if _, err := w.observe(t, state, map[string]int{"ExpireTerminalOperations": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}); err != nil {
				t.Fatal(err)
			}
			if len(w.writes) != 1 || !reflect.DeepEqual(w.writes[0], *expected) {
				t.Fatal("original initial result was not proposed unchanged", w.writes)
			}
			w.terminal.SetRecord(t, expected)
			w.now = w.now.Add(time.Millisecond)
			replay := state
			replay.InitialAssignment = "pending"
			_, err := w.observe(t, replay, map[string]int{"ExpireTerminalOperations": 1})
			var refusal *model.Fault
			if !errors.As(err, &refusal) || refusal.Code != "session_conflict" || len(w.writes) != 0 || w.terminal.ProposedRaw != nil {
				t.Fatalf("%s replay was not refused without a write: refusal=%v writes=%+v", initial, err, w.writes)
			}
			w.requireState(t, initial, "suspended", true)
			w.writes = nil
			w.terminal.ProposedRaw = nil
			ctx := w.TerminalPhase(t.Context(), true, map[string]int{"InvalidateTerminalOperations": 1, "SaveTerminal": 2})
			err = w.s.DisconnectTerminal(ctx, w.p, w.project, w.task, w.message.SessionID, w.message.Envelope, "1")
			w.dao.FinishContext(ctx)
			if err != nil {
				t.Fatal(err)
			}
			suspended := fixtureCopy(*expected)
			suspended.ControlEpoch = "2"
			suspended.Control.ControlEpoch = "2"
			suspended.Control.State = "suspended"
			suspended.Control.Lease = nil
			suspended.Control.AvailableActions = []string{}
			suspended.ControlActor = nil
			suspended.LastLeaseSeq = "0"
			disconnected := fixtureCopy(suspended)
			disconnected.LastSeen = nil
			if len(w.writes) != 2 || !reflect.DeepEqual(w.writes[0], suspended) || !reflect.DeepEqual(w.writes[1], disconnected) {
				t.Fatalf("disconnect changed the original %s decision: %+v", initial, w.writes)
			}
			w.terminal.SetRecord(t, &disconnected)
			w.requireState(t, initial, "suspended", false)
		})
	}
}
