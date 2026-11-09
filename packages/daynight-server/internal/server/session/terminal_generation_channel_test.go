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

func TestTerminalWorkerChannelAdvancesStoppedGeneration(t *testing.T) {
	testTerminalWorkerChannelAdvancesStoppedGeneration(t, false)
}

func TestTerminalWorkerChannelRecoversNativeIdentityLearnedAtStop(t *testing.T) {
	testTerminalWorkerChannelAdvancesStoppedGeneration(t, true)
}

func testTerminalWorkerChannelAdvancesStoppedGeneration(t *testing.T, learnedAtStop bool) {
	t.Helper()
	f := terminalHTTPSetup(t)
	native := "native-conversation"
	registration := f.message.Payload.(v2.Registration)
	if !learnedAtStop {
		registration.Binding.NativeSessionID = &native
	}
	f.message.Payload = registration
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	path := f.base + "/" + f.message.SessionID
	worker, _, err := websocket.Dial(ctx, f.server.URL+path+"/worker-channel", &websocket.DialOptions{HTTPHeader: f.workerHeaders("terminal-generation"), Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer worker.CloseNow()
	f.handshake(t, worker)
	send := func(generation, kind string, payload v2.Payload, scope string) map[string]json.RawMessage {
		t.Helper()
		message := f.message
		message.ExecutionGeneration = generation
		message.Type = kind
		message.Payload = payload
		return f.workerMessage(t, worker, message, scope)
	}
	first := v2.Run{ExecutionGeneration: "1", Owner: registration.Owner, Binding: registration.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{uuid.NewString()}}
	send("1", "generation_ledger", v2.GenerationLedger{Runs: []v2.Run{first}}, "terminal-socket-write")
	stopped := "2026-01-01T00:00:01Z"
	first.StoppedAt = &stopped
	first.StopProof = &v2.StopProof{RecordID: uuid.NewString(), ExecutionGeneration: "1", Binding: first.Binding, BootID: "boot", StoppedAt: stopped, Method: "instances_exited", TerminalStopped: true, Processes: []v2.ProcessProof{{Role: "shell", PID: 1, BirthToken: "shell", BootID: "boot"}, {Role: "agent", PID: 2, BirthToken: "agent", BootID: "boot"}}}
	first.StopProof.Binding.NativeSessionID = &native
	send("1", "generation_ledger", v2.GenerationLedger{Runs: []v2.Run{first}}, "terminal-socket-write")
	next := v2.Run{ExecutionGeneration: "2", Owner: registration.Owner, Binding: registration.Binding, StartedAt: "2026-01-01T00:00:02Z", SegmentIDs: []string{uuid.NewString()}}
	next.Binding.TerminalID = "term_recovered"
	next.Binding.NativeSessionID = &native
	pollIndex := f.writeIndex()
	ack := send("2", "generation_ledger", v2.GenerationLedger{Runs: []v2.Run{first, next}}, "terminal-generation")
	if string(ack["executionGeneration"]) != `"2"` {
		t.Fatal("ledger acknowledgement did not advance the channel generation", ack)
	}
	f.awaitSaved(t, pollIndex, func(record terminalRouteRecord) bool {
		return record.Envelope.ExecutionGeneration == "2" && record.ChannelEpoch == "1" && record.LastSeen != nil
	})
	assertConnected := func(want bool) {
		t.Helper()
		response := terminalRequest(f.h, http.MethodGet, path+"/state", "", v2.Protocol, "terminal-state")
		var state struct {
			Connected           bool                `json:"connected"`
			ExecutionGeneration string              `json:"executionGeneration"`
			Ledger              v2.GenerationLedger `json:"ledger"`
		}
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &state) != nil || state.Connected != want || state.ExecutionGeneration != "2" || len(state.Ledger.Runs) != 2 {
			t.Fatalf("generation channel state connected=%t: %d %s", want, response.Code, response.Body.String())
		}
		originalProof := state.Ledger.Runs[0].StopProof
		binding := state.Ledger.Runs[1].Binding
		if originalProof == nil || originalProof.Binding.NativeSessionID == nil || *originalProof.Binding.NativeSessionID != native || binding.NativeSessionID == nil || *binding.NativeSessionID != native || binding.TerminalID != next.Binding.TerminalID {
			t.Fatal("generation transition lost the original stop identity or replacement terminal binding", state)
		}
	}
	assertConnected(true)
	snapshot := v2.Snapshot{ConnectionEpoch: "1", SegmentID: next.SegmentIDs[0], SegmentOrdinal: "2", Binding: next.Binding, Frame: v2.Frame{FrameSeq: "1", CapturedAt: "2026-01-01T00:00:02Z", ElapsedMs: "0", Width: 1, Height: 1, Full: true, Rows: [][]v2.StyledText{{}}}}
	send("2", "snapshot", snapshot, "terminal-socket-state")
	stale := f.message
	stale.Type = "snapshot"
	stale.Payload = snapshot
	drainIndex := f.writeIndex()
	sessionWSWrite(t, worker, stale)
	closeCtx, cancelClose := context.WithTimeout(ctx, 3*time.Second)
	defer cancelClose()
	if _, _, err = worker.Read(closeCtx); err == nil || closeCtx.Err() != nil {
		t.Fatalf("old-generation snapshot did not close the Worker channel: %v", err)
	}
	f.awaitSaved(t, drainIndex, func(record terminalRouteRecord) bool {
		return record.Envelope.ExecutionGeneration == "2" && record.ChannelEpoch == "1" && record.LastSeen == nil
	})
	assertConnected(false)
}
