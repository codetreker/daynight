package session

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
)

type terminalControlFixture struct {
	fixture
	message v2.Message
	binding v2.Binding
	segment string
	now     time.Time
}

func terminalControlSetup(t *testing.T) *terminalControlFixture {
	t.Helper()
	f, m := terminalFixture(t)
	now := time.Now().UTC().Truncate(time.Millisecond)
	f.s.now = func() time.Time { return now }
	in := m.Payload.(v2.Registration)
	x := &terminalControlFixture{fixture: f, message: m, binding: in.Binding, segment: uuid.NewString(), now: now}
	f.s.now = func() time.Time { return x.now }
	if _, err := terminalRegistrationStep(t, f, m.SessionID, func() (v2.Message, error) {
		return terminalControlCall(f, f.TerminalRegistrationPhase(context.Background(), map[string]int{"InsertTerminal": 1}), func(ctx context.Context) (v2.Message, error) {
			return f.s.RegisterTerminal(ctx, f.p, f.project, f.task, m)
		})
	}); err != nil {
		t.Fatal(err)
	}
	run := v2.Run{ExecutionGeneration: "1", Owner: in.Owner, Binding: in.Binding, StartedAt: terminalTime(now), SegmentIDs: []string{x.segment}}
	m.Type = "generation_ledger"
	m.Payload = v2.GenerationLedger{Runs: []v2.Run{run}}
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		return terminalControlCall(f, f.TerminalPhase(context.Background(), true, map[string]int{"SaveTerminal": 1}), func(ctx context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", m)
		})
	}); err != nil {
		t.Fatal(err)
	}
	m.Type = "recording_responsibility"
	m.Payload = v2.RecordingResponsibility{ResponsibilityID: uuid.NewString(), RecordingEnabled: true}
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		return terminalControlCall(f, f.TerminalPhase(context.Background(), true, map[string]int{"SaveTerminal": 1}), func(ctx context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", m)
		})
	}); err != nil {
		t.Fatal(err)
	}
	r := f.terminal.Record(t)
	r.ControlEpoch = "1"
	r.Control = &v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "automation", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}
	f.terminal.SetRecord(t, r)
	return x
}
func (f *terminalControlFixture) msg(kind string, payload v2.Payload) v2.Message {
	m := f.message
	m.Type = kind
	m.Payload = payload
	return m
}

func terminalControlCall[T any](f fixture, phase context.Context, fn func(context.Context) (T, error)) (T, error) {
	defer f.dao.FinishContext(phase)
	return fn(phase)
}

func selectTerminalLease(t *testing.T, f *terminalControlFixture, actor model.Principal) {
	t.Helper()
	r := f.terminal.Record(t)
	r.ControlEpoch = "2"
	r.ControlActor = &actor
	r.Control = &v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "2", State: "manual", InitialAssignment: "transport_completed", AvailableActions: []string{"paste"}, Lease: &v2.Lease{LeaseID: uuid.NewString(), HolderUserID: actor.UserID, BrowserClientID: uuid.NewString(), ControlEpoch: "2", ExpiresAt: terminalTime(f.now.Add(30 * time.Second))}}
	f.terminal.SetRecord(t, r)
}

func TestTerminalForeignRelayPreservesHealthyStateAndSuspendsLostOwner(t *testing.T) {
	for _, cause := range []string{"healthy", "heartbeat_timeout", "claim_ended"} {
		t.Run(cause, func(t *testing.T) {
			f := terminalControlSetup(t)
			selectTerminalLease(t, f, f.p)
			other := New(f.writer)
			other.now = f.s.now
			before := string(f.terminal.Raw)
			if cause == "heartbeat_timeout" {
				f.now = f.now.Add(HeartbeatTimeout + time.Second)
			} else if cause == "claim_ended" {
				endTerminalTask(t, f.fixture, model.WorkerCompleted)
			}
			work := map[string]int{}
			if cause != "healthy" {
				work = map[string]int{"ExpireTerminalOperations": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1, "TerminalArchive": 1}
			}
			_, err := terminalStateStep(t, f.fixture, func() (map[string]any, error) {
				phase := f.TerminalPhase(context.Background(), false, work)
				defer f.dao.FinishContext(phase)
				return other.TerminalState(phase, f.p, f.project, f.task, f.message.SessionID)
			})
			if cause == "healthy" {
				var refusal *model.Fault
				if !errors.As(err, &refusal) || refusal.Code != "relay_instance_unavailable" || before != string(f.terminal.Raw) {
					t.Fatalf("healthy original state changed or routing refusal missing: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			control := f.terminal.Record(t).Control
			if control.State != "suspended" || control.Lease != nil || control.ControlEpoch != "3" {
				t.Fatal("lost owner retained manual control", control)
			}
		})
	}
}

func TestTerminalRevokedLeaseActorIsSuspended(t *testing.T) {
	for _, cause := range []string{"credential", "owner"} {
		t.Run(cause, func(t *testing.T) {
			f := terminalControlSetup(t)
			actor := listCredential(t, f.fixture, f.p.UserID, model.PATCredential)
			if cause == "owner" {
				actor = addMember(t, f.fixture, "member")
			} else {
				revokeFixtureCredential(t, f.fixture, actor)
			}
			selectTerminalLease(t, f, actor)
			work := map[string]int{"ExpireTerminalOperations": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1, "TerminalArchive": 1, "LockCredential": 2, "ProjectAccess": map[string]int{"credential": 1, "owner": 2}[cause]}
			_, err := terminalStateStep(t, f.fixture, func() (map[string]any, error) {
				phase := f.TerminalPhase(context.Background(), false, work)
				defer f.dao.FinishContext(phase)
				return f.s.TerminalState(phase, f.p, f.project, f.task, f.message.SessionID)
			})
			if err != nil {
				t.Fatal(err)
			}
			control := f.terminal.Record(t).Control
			if control.State != "suspended" || control.Lease != nil || control.ControlEpoch != "3" {
				t.Fatal("revoked actor retained lease", control)
			}
		})
	}
}

func TestTerminalFinalizationClearsExistingPreview(t *testing.T) {
	f, m, doc := terminalArchiveFixture(t)
	f.s.terminalFrames = map[string]*terminalFrameWrite{m.SessionID: {raw: []byte("private screen")}}
	f.s.terminalFrameWrites = map[string]*terminalFrameWrite{m.SessionID: {raw: []byte("pending screen")}}
	finalizeFixture(t, f, m, doc)
	if len(f.s.terminalFrames) != 0 || len(f.s.terminalFrameWrites) != 0 {
		t.Fatal("finalized terminal retained transient preview")
	}
}

func TestTerminalSnapshotReadsOnlyMatchingLivePreview(t *testing.T) {
	f := terminalControlSetup(t)
	r := f.terminal.Record(t)
	preview := v2.Snapshot{ConnectionEpoch: "1", SegmentID: f.segment, SegmentOrdinal: "1", Binding: f.binding, Recorded: true, Frame: v2.Frame{FrameSeq: "1", CapturedAt: terminalTime(f.now), ElapsedMs: "0", Width: 1, Height: 1, Full: true, Rows: [][]v2.StyledText{{{Text: "private"}}}}}
	frame := &terminalFrameWrite{raw: encode(f.msg("snapshot", preview)), lastSeen: f.now}
	f.s.terminalFrames = map[string]*terminalFrameWrite{f.message.SessionID: frame}
	if got := f.s.terminalSnapshot(r); got == nil || !reflect.DeepEqual(*got, preview) {
		t.Fatal("matching preview unavailable", got)
	}
	r.ConnectionEpoch = "2"
	if f.s.terminalSnapshot(r) != nil {
		t.Fatal("old connection preview exposed")
	}
	r.ConnectionEpoch = "1"
	r.ServerInstance = "other"
	if f.s.terminalSnapshot(r) != nil {
		t.Fatal("foreign relay preview exposed")
	}
	r.ServerInstance = f.s.instance
	frame.lastSeen = f.now.Add(-HeartbeatTimeout - time.Second)
	if f.s.terminalSnapshot(r) != nil {
		t.Fatal("expired preview exposed")
	}
	frame.lastSeen = f.now
	finalization := uuid.NewString()
	r.FinalizationID = &finalization
	if f.s.terminalSnapshot(r) != nil {
		t.Fatal("finalized preview exposed")
	}
}
