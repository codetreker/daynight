package session

import (
	"context"
	"reflect"
	"testing"
	"time"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
)

func terminalRunFixture(t *testing.T, enabled bool) (fixture, v2.Message, v2.Run, string) {
	t.Helper()
	f, m := terminalFixture(t)
	ctx := context.Background()
	if _, err := terminalRegistrationStep(t, f, m.SessionID, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "InsertTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.RegisterTerminal(phase, f.p, f.project, f.task, m)
		})
	}); err != nil {
		t.Fatal(err)
	}
	p := m.Payload.(v2.Registration)
	run := v2.Run{ExecutionGeneration: "1", Owner: p.Owner, Binding: p.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{}}
	ledger := m
	ledger.Type = "generation_ledger"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{run}}
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "SaveTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "1", ledger)
		})
	}); err != nil {
		t.Fatal(err)
	}
	rid := uuid.NewString()
	responsibility := m
	responsibility.Type = "recording_responsibility"
	responsibility.Payload = v2.RecordingResponsibility{ResponsibilityID: rid, RecordingEnabled: enabled}
	if _, err := terminalRecordingStep(t, f, responsibility, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "SaveTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", responsibility)
		})
	}); err != nil {
		t.Fatal(err)
	}
	return f, m, run, rid
}
func stopTerminalRun(t *testing.T, f fixture, m v2.Message, run v2.Run) v2.Run {
	t.Helper()
	stopped := "2026-01-01T00:01:00Z"
	run.StoppedAt = &stopped
	run.StopProof = &v2.StopProof{RecordID: uuid.NewString(), ExecutionGeneration: run.ExecutionGeneration, Binding: run.Binding, BootID: "boot", StoppedAt: stopped, Method: "instances_exited", TerminalStopped: true, Processes: []v2.ProcessProof{{Role: "shell", PID: 1, BirthToken: "shell-birth", BootID: "boot"}, {Role: "agent", PID: 2, BirthToken: "agent-birth", BootID: "boot"}}}
	ledger := m
	ledger.Type = "generation_ledger"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{run}}
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		return withinRecordingPhase(f, context.Background(), map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "SaveTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "1", ledger)
		})
	}); err != nil {
		t.Fatal(err)
	}
	return run
}
func zeroEvidence(m v2.Message, rid string) v2.Message {
	m.Type = "recording_evidence"
	m.Payload = v2.RecordingEvidence{ResponsibilityID: rid, EvidenceID: uuid.NewString(), Revision: "1", SelectedFrameCount: "0", RegisteredFrameCount: "0", Closed: true, JournalSHA256: v2.HashBytes([]byte("closed zero journal")), SourceSHA256: v2.EmptySourceDigest()}
	return m
}
func TestTerminalRecordingCountersErrorsAndEvidenceIdentityCannotRollBack(t *testing.T) {
	f, m, _, rid := terminalRunFixture(t, true)
	ctx := context.Background()
	message := zeroEvidence(m, rid)
	e := message.Payload.(v2.RecordingEvidence)
	e.Closed = false
	e.SelectedFrameCount = "1"
	message.Payload = e
	if _, err := terminalRecordingStep(t, f, message, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalRecordingEvidence": 1, "InsertRecordingEvidence": 1, "SaveTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", message)
		})
	}); err != nil {
		t.Fatal(err)
	}
	sameID := e
	sameID.Revision = "2"
	sameID.RegisteredFrameCount = "1"
	message.Payload = sameID
	if _, err := terminalRecordingStep(t, f, message, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalRecordingEvidence": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", message)
		})
	}); err == nil {
		t.Fatal("evidence ID was reused with different bytes")
	}
	rollback := e
	rollback.EvidenceID = uuid.NewString()
	rollback.Revision = "2"
	rollback.SelectedFrameCount = "0"
	message.Payload = rollback
	if _, err := terminalRecordingStep(t, f, message, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalRecordingEvidence": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", message)
		})
	}); err == nil {
		t.Fatal("selected count rolled back")
	}
	failed := e
	failed.EvidenceID = uuid.NewString()
	failed.Revision = "2"
	code := "source_corrupt"
	failed.CaptureError = &code
	message.Payload = failed
	if _, err := terminalRecordingStep(t, f, message, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalRecordingEvidence": 1, "InsertRecordingEvidence": 1, "SaveTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", message)
		})
	}); err != nil {
		t.Fatal(err)
	}
	cleared := failed
	cleared.EvidenceID = uuid.NewString()
	cleared.Revision = "3"
	cleared.CaptureError = nil
	message.Payload = cleared
	if _, err := terminalRecordingStep(t, f, message, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalRecordingEvidence": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", message)
		})
	}); err == nil {
		t.Fatal("capture error erased")
	}
	message.Payload = e
	if _, err := terminalRecordingStep(t, f, message, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalRecordingEvidence": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", message)
		})
	}); err != nil {
		t.Fatal("old immutable evidence retry", err)
	}
	if got := f.terminal.Record(t).Recording["1"].Evidence; got == nil || got.EvidenceID != failed.EvidenceID {
		t.Fatal("old retry moved latest evidence", got)
	}

	reused := e
	reused.Revision = "3"
	message.Payload = reused
	if _, err := terminalRecordingStep(t, f, message, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalRecordingEvidence": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", message)
		})
	}); err == nil {
		t.Fatal("old evidence identity was rebound after a newer checkpoint")
	}
	message.Payload = failed
	if _, err := terminalRecordingStep(t, f, message, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "9", message)
		})
	}); err == nil {
		t.Fatal("stale connection evidence accepted")
	}
}
func TestTerminalReconnectKeepsGenerationAndRejectsOldConnection(t *testing.T) {
	f, m, run, _ := terminalRunFixture(t, true)
	ctx := context.Background()
	reg := m.Payload.(v2.Registration)
	reg.Mode = "reconnect"
	epoch := "1"
	reg.ConnectionEpoch = &epoch
	request := m
	request.Payload = reg
	ack, err := terminalRegistrationStep(t, f, request.SessionID, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "LockTerminal": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.RegisterTerminal(phase, f.p, f.project, f.task, request)
		})
	})
	if err != nil || ack.ExecutionGeneration != "1" || ack.Payload.(v2.RegistrationAck).ConnectionEpoch != "2" {
		t.Fatal(ack, err)
	}
	if got, err := terminalRegistrationStep(t, f, request.SessionID, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "LockTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.RegisterTerminal(phase, f.p, f.project, f.task, request)
		})
	}); err != nil || !reflect.DeepEqual(got, ack) {
		t.Fatal(got, err)
	}
	ledger := m
	ledger.Type = "generation_ledger"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{run}}
	if _, err = terminalRecordStep(t, f, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "1", ledger)
		})
	}); err == nil {
		t.Fatal("old connection ledger accepted")
	}
	if _, err = terminalRecordStep(t, f, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "SaveTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "2", ledger)
		})
	}); err != nil {
		t.Fatal(err)
	}
	reg.Binding.TerminalID = "replacement"
	request.Payload = reg
	if _, err = terminalRegistrationStep(t, f, request.SessionID, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "LockTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.RegisterTerminal(phase, f.p, f.project, f.task, request)
		})
	}); err == nil {
		t.Fatal("changed terminal reconnected")
	}
	remote := New(f.writer)
	remote.Origin = f.s.Origin
	reg = m.Payload.(v2.Registration)
	reg.Mode = "reconnect"
	epoch = "2"
	reg.ConnectionEpoch = &epoch
	request.Payload = reg
	if _, err = terminalRegistrationStep(t, f, request.SessionID, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "LockTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return remote.RegisterTerminal(phase, f.p, f.project, f.task, request)
		})
	}); err == nil {
		t.Fatal("live relay affinity bypassed")
	}
	remote.now = func() time.Time { return time.Now().Add(HeartbeatTimeout + time.Second) }
	if _, err = terminalRegistrationStep(t, f, request.SessionID, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "LockTerminal": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return remote.RegisterTerminal(phase, f.p, f.project, f.task, request)
		})
	}); err != nil {
		t.Fatal("expired relay cannot reconnect", err)
	}
}

func TestTerminalGenerationRecoveryRequiresStoppedOriginalAndKeepsItsLedger(t *testing.T) {
	f, m, run, _ := terminalRunFixture(t, true)
	ctx := context.Background()
	native := "native-session"
	run.Binding.NativeSessionID = &native
	ledger := m
	ledger.Type = "generation_ledger"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{run}}
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "SaveTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "1", ledger)
		})
	}); err != nil {
		t.Fatal(err)
	}
	nextRun := run
	nextRun.ExecutionGeneration = "2"
	nextRun.Binding.TerminalID = "term_recovery"
	ledger.ExecutionGeneration = "2"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{run, nextRun}}
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "1", ledger)
		})
	}); err == nil {
		t.Fatal("unstopped generation replaced")
	}
	run = stopTerminalRun(t, f, m, run)
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{run, nextRun}}
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "SaveTerminal": 1, "InvalidateTerminalOperations": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "1", ledger)
		})
	}); err != nil {
		t.Fatal(err)
	}
	if r := f.terminal.Record(t); r.Envelope.ExecutionGeneration != "2" {
		t.Fatal("generation was not retained", r.Envelope.ExecutionGeneration)
	}
	original := run
	original.Binding.TerminalID = "altered-original"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{original, nextRun}}
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "1", ledger)
		})
	}); err == nil {
		t.Fatal("old original run changed")
	}
	nextRun.Binding.NativeSessionID = nil
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{run, nextRun}}
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "1", ledger)
		})
	}); err == nil {
		t.Fatal("native session identity erased")
	}
}

func TestTerminalGenerationRecoveryUsesIdentityFirstLearnedAtStop(t *testing.T) {
	for _, persistStopFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "stop and recovery together", true: "already frozen stop"}[persistStopFirst], func(t *testing.T) {
			f, m, run, _ := terminalRunFixture(t, true)
			ctx := context.Background()
			native := "native-learned-at-stop"
			stoppedAt := "2026-01-01T00:01:00Z"
			stopped := run
			stopped.StoppedAt = &stoppedAt
			proofBinding := run.Binding
			proofBinding.NativeSessionID = &native
			stopped.StopProof = &v2.StopProof{RecordID: uuid.NewString(), ExecutionGeneration: "1", Binding: proofBinding, BootID: "boot", StoppedAt: stoppedAt, Method: "instances_exited", TerminalStopped: true, Processes: []v2.ProcessProof{{Role: "shell", PID: 1, BirthToken: "shell-birth", BootID: "boot"}, {Role: "agent", PID: 2, BirthToken: "agent-birth", BootID: "boot"}}}
			ledger := m
			ledger.Type = "generation_ledger"
			ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{stopped}}
			if persistStopFirst {
				if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
					return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "SaveTerminal": 1}, func(phase context.Context) (v2.Message, error) {
						return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "1", ledger)
					})
				}); err != nil {
					t.Fatal("persist stop with newly learned native identity", err)
				}
			}
			recovery := run
			recovery.ExecutionGeneration = "2"
			recovery.StartedAt = "2026-01-01T00:02:00Z"
			recovery.Binding.TerminalID = "term_recovery"
			ledger.ExecutionGeneration = "2"
			differentNative := "different-native"
			for _, invalidNative := range []*string{nil, &differentNative} {
				recovery.Binding.NativeSessionID = invalidNative
				ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{stopped, recovery}}
				if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
					return withinRecordingPhase(f, ctx, map[string]int{}, func(phase context.Context) (v2.Message, error) {
						return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "1", ledger)
					})
				}); err == nil {
					t.Fatal("recovery erased or replaced the stop proof's native identity")
				}
			}
			recovery.Binding.NativeSessionID = &native
			ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{stopped, recovery}}
			if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
				return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "SaveTerminal": 1, "InvalidateTerminalOperations": 1}, func(phase context.Context) (v2.Message, error) {
					return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "1", ledger)
				})
			}); err != nil {
				t.Fatal("recovery rejected identity learned by the original stop proof", err)
			}
			r := f.terminal.Record(t)
			runs := r.Runs
			if r.Envelope.ExecutionGeneration != "2" || len(runs) != 2 || !reflect.DeepEqual(runs[0], stopped) || runs[0].Binding.NativeSessionID != nil || !reflect.DeepEqual(runs[1], recovery) {
				t.Fatal("recovery changed the original frozen run", r)
			}

		})
	}
}

func TestTerminalGenerationRecoveryStillRequiresPreviouslyLearnedIdentity(t *testing.T) {
	f, m, run, _ := terminalRunFixture(t, true)
	stopped := stopTerminalRun(t, f, m, run)
	recovery := run
	recovery.ExecutionGeneration = "2"
	recovery.Binding.TerminalID = "term_recovery"
	inventedNative := "newly-invented-native"
	recovery.Binding.NativeSessionID = &inventedNative
	ledger := m
	ledger.Type = "generation_ledger"
	ledger.ExecutionGeneration = "2"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{stopped, recovery}}
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		return withinRecordingPhase(f, context.Background(), map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "1", ledger)
		})
	}); err == nil {
		t.Fatal("recovery invented a native identity absent from the stopped run and its proof")
	}
}
