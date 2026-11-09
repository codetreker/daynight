package session_test

import (
	"context"
	"errors"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
)

func TestTerminalWorkerChannelUsesReturnedGenerationFence(t *testing.T) {
	testTerminalWorkerChannelGenerationWire(t, false)
}

func TestTerminalWorkerChannelEncodesReturnedStopIdentity(t *testing.T) {
	testTerminalWorkerChannelGenerationWire(t, true)
}

func testTerminalWorkerChannelGenerationWire(t *testing.T, learnedAtStop bool) {
	t.Helper()
	f := terminalHTTPSetup(t)
	native := "native-conversation"
	registration := f.message.Payload.(v2.Registration)
	if !learnedAtStop {
		registration.Binding.NativeSessionID = &native
	}
	f.message.Payload = registration
	first := v2.Run{ExecutionGeneration: "1", Owner: registration.Owner, Binding: registration.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{uuid.NewString()}}
	stopped := "2026-01-01T00:00:01Z"
	first.StoppedAt = &stopped
	first.StopProof = &v2.StopProof{RecordID: uuid.NewString(), ExecutionGeneration: "1", Binding: first.Binding, BootID: "boot", StoppedAt: stopped, Method: "instances_exited", TerminalStopped: true, Processes: []v2.ProcessProof{{Role: "shell", PID: 1, BirthToken: "shell", BootID: "boot"}, {Role: "agent", PID: 2, BirthToken: "agent", BootID: "boot"}}}
	first.StopProof.Binding.NativeSessionID = &native
	next := v2.Run{ExecutionGeneration: "2", Owner: registration.Owner, Binding: registration.Binding, StartedAt: "2026-01-01T00:00:02Z", SegmentIDs: []string{uuid.NewString()}}
	next.Binding.TerminalID = "term_recovered"
	next.Binding.NativeSessionID = &native
	input := f.message
	input.Type = "generation_ledger"
	input.Payload = v2.GenerationLedger{Runs: []v2.Run{first}}
	result := input
	result.ExecutionGeneration = "2"
	result.Payload = v2.GenerationLedger{Runs: []v2.Run{first, next}}
	disconnected := terminalWireWorker(t, f, result.Envelope)
	var returned atomic.Bool
	polledNewFence := make(chan struct{}, 1)
	f.calls.AllowRepeated("PollTerminal")
	f.calls.RequireCalls("PollTerminal", 1)
	f.calls.Funcs.PollTerminal = func(ctx context.Context, principal model.Principal, project, task, id string, fence v2.Envelope, epoch string) ([]v2.Message, error) {
		if err := terminalWireScope(t, f, ctx, principal, project, task, id); err != nil {
			return nil, err
		}
		want := f.message.Envelope
		if returned.Load() {
			want = result.Envelope
		}
		if fence != want || epoch != "1" {
			err := errors.New("terminal poll did not use the acknowledged service generation fence")
			t.Error(err)
			return nil, err
		}
		if returned.Load() {
			select {
			case polledNewFence <- struct{}{}:
			default:
			}
		}
		return []v2.Message{}, nil
	}
	f.calls.Funcs.UpdateTerminalLedger = func(ctx context.Context, principal model.Principal, project, task, id, epoch string, message v2.Message) (v2.Message, error) {
		if err := terminalWireScope(t, f, ctx, principal, project, task, id); err != nil {
			return v2.Message{}, err
		}
		if epoch != "1" || !reflect.DeepEqual(message, input) {
			err := errors.New("generation ledger changed before the service call")
			t.Error(err)
			return v2.Message{}, err
		}
		returned.Store(true)
		return result, nil
	}
	snapshot := f.message
	snapshot.Type = "snapshot"
	snapshot.ExecutionGeneration = "2"
	snapshot.Payload = v2.Snapshot{ConnectionEpoch: "1", SegmentID: next.SegmentIDs[0], SegmentOrdinal: "2", Binding: next.Binding, Frame: v2.Frame{FrameSeq: "1", CapturedAt: "2026-01-01T00:00:02Z", ElapsedMs: "0", Width: 1, Height: 1, Full: true, Rows: [][]v2.StyledText{{}}}}
	f.calls.Funcs.HandleTerminalControl = func(ctx context.Context, principal model.Principal, project, task, id, epoch string, message v2.Message) (v2.Message, error) {
		if err := terminalWireScope(t, f, ctx, principal, project, task, id); err != nil {
			return v2.Message{}, err
		}
		if epoch != "1" || !reflect.DeepEqual(message, snapshot) {
			err := errors.New("generation channel forwarded an unselected snapshot")
			t.Error(err)
			return v2.Message{}, err
		}
		return snapshot, nil
	}
	worker := terminalWireDial(t, f)
	ack := f.workerMessage(t, worker, input)
	if !reflect.DeepEqual(ack, result) {
		t.Fatalf("generation ledger acknowledgement changed the supplied result: %#v", ack)
	}
	if ack := f.workerMessage(t, worker, snapshot); !reflect.DeepEqual(ack, snapshot) {
		t.Fatal("new-generation snapshot acknowledgement changed its wire payload", ack)
	}
	select {
	case <-polledNewFence:
	case <-time.After(3 * time.Second):
		t.Fatal("terminal channel did not poll with its returned generation fence")
	}
	stale := snapshot
	stale.ExecutionGeneration = "1"
	sessionWSWrite(t, worker, stale)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	if _, _, err := worker.Read(ctx); err == nil || ctx.Err() != nil {
		t.Fatalf("old-generation snapshot did not close the worker channel before its deadline: %v", err)
	}
	terminalWireDisconnected(t, f, disconnected)
}
