package session_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
)

func terminalInitialInputChannel(t *testing.T) (*terminalHTTPFixture, *websocket.Conn) {
	t.Helper()
	f := terminalHTTPSetup(t)
	reg := f.message.Payload.(v2.Registration)
	reg.Capabilities = v2.Capabilities{}
	f.message.Payload = reg
	f.input(func(in *terminalRouteInput) { in.Registration = reg })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	worker, _, err := websocket.Dial(ctx, f.server.URL+f.base+"/"+f.message.SessionID+"/worker-channel", &websocket.DialOptions{HTTPHeader: f.workerHeaders(), Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = worker.CloseNow() })
	f.handshake(t, worker)
	ledger := f.message
	ledger.Type = "generation_ledger"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{{ExecutionGeneration: "1", Owner: reg.Owner, Binding: reg.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{uuid.NewString()}}}}
	f.workerMessage(t, worker, ledger, "terminal-socket-write")
	return f, worker
}

func TestTerminalWorkerChannelRetainsDefinitelyUnsentInitialRetry(t *testing.T) {
	f, worker := terminalInitialInputChannel(t)
	for index, initial := range []string{"pending", "dispatching", "pending", "dispatching", "transport_completed"} {
		message := f.message
		message.Type = "control_state"
		message.Payload = v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "automation", InitialAssignment: initial, AvailableActions: []string{"acquire_control"}}
		scope := "terminal-socket-state"
		if index == 0 {
			scope = "terminal-socket-initial"
		}
		ack := f.workerMessage(t, worker, message, scope)
		var control v2.ControlState
		if err := json.Unmarshal(ack["payload"], &control); err != nil {
			t.Fatal(err)
		}
		if control.InitialAssignment != initial || control.State != "automation" || control.ConnectionEpoch != "1" || control.ControlEpoch != "1" {
			t.Fatalf("initial observation %d was not acknowledged on the original channel: %+v", index, control)
		}
	}
	response := terminalRequest(f.h, http.MethodGet, f.base+"/"+f.message.SessionID+"/state", "", v2.Protocol, "terminal-state")
	var state struct {
		Connected bool            `json:"connected"`
		Control   v2.ControlState `json:"control"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &state) != nil || !state.Connected || state.Control.InitialAssignment != "transport_completed" {
		t.Fatal("initial retry closed the Worker channel or lost its durable result", response.Code, response.Body.String())
	}
}

func TestTerminalWorkerChannelRejectsInitialReplayAfterUncertainOrFinalResult(t *testing.T) {
	for _, initial := range []string{"unknown", "unconfirmed", "transport_completed"} {
		t.Run(initial, func(t *testing.T) {
			f, worker := terminalInitialInputChannel(t)
			message := f.message
			message.Type = "control_state"
			state := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "suspended", InitialAssignment: initial, AvailableActions: []string{}}
			message.Payload = state
			f.workerMessage(t, worker, message, "terminal-socket-initial")
			f.state.mu.Lock()
			current := append([]byte(nil), f.state.input.Raw...)
			f.state.mu.Unlock()
			expected := terminalDecodeRecord(t, current)
			expected.ControlEpoch = "2"
			terminalSuspend(&expected)
			expected.Control.ControlEpoch = "2"
			expected.LastSeen = nil
			expectedRaw := []byte(jsonBody(t, expected))
			index := f.writeIndex()
			state.InitialAssignment = "pending"
			message.Payload = state
			f.expectSocketScope("terminal-socket-refused", 1)
			sessionWSWrite(t, worker, message)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, _, err := worker.Read(ctx); err == nil || ctx.Err() != nil {
				t.Fatalf("Worker channel did not reject %s to pending: %v", initial, err)
			}
			f.awaitSaved(t, index, func(actual terminalRouteRecord) bool {
				return terminalRecordJSONEqual([]byte(jsonBody(t, actual)), expectedRaw)
			})
			response := terminalRequest(f.h, http.MethodGet, f.base+"/"+f.message.SessionID+"/state", "", v2.Protocol, "terminal-state")
			var observed struct {
				Connected bool            `json:"connected"`
				Control   v2.ControlState `json:"control"`
			}
			if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &observed) != nil || observed.Connected || observed.Control.InitialAssignment != initial || observed.Control.State != "suspended" {
				t.Fatal("rejected replay replaced the original initial result", response.Code, response.Body.String())
			}
		})
	}
}
