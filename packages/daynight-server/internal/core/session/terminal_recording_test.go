package session

import (
	"context"
	"reflect"
	"testing"
	"time"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func terminalRunFixture(t *testing.T, enabled bool) (fixture, v2.Message, v2.Run, string) {
	t.Helper()
	f, m := terminalFixture(t)
	ctx := context.Background()
	if _, err := terminalRegistrationStep(t, f, m.SessionID, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "InsertTerminal": 1}, func(phase context.Context) (v2.Message, error) {
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
func TestTerminalUnavailableRequiresClosedResponsibilityAndCreatesImmutableReceipt(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(map[bool]string{false: "disabled", true: "before first sample"}[enabled], func(t *testing.T) {
			f, m, run, rid := terminalRunFixture(t, enabled)
			ctx := context.Background()
			early := zeroEvidence(m, rid)
			if _, err := terminalRecordingStep(t, f, early, func() (v2.Message, error) {
				return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalRecordingEvidence": 1}, func(phase context.Context) (v2.Message, error) {
					return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", early)
				})
			}); err == nil {
				t.Fatal("closed before stopped")
			}
			run = stopTerminalRun(t, f, m, run)
			archiveTerminal(t, f)
			final := m
			final.Type = "finalization"
			final.Payload = v2.Finalization{FinalizationID: uuid.NewString(), ClaimTerminal: true, Runs: []v2.Run{run}}
			if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
				return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1}, func(phase context.Context) (v2.Message, error) {
					return f.s.FinalizeTerminal(phase, f.p, f.project, f.task, m.SessionID, "1", final)
				})
			}); err == nil {
				t.Fatal("finalized without closed evidence")
			}
			evidence := zeroEvidence(m, rid)
			if _, err := terminalRecordingStep(t, f, evidence, func() (v2.Message, error) {
				return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalRecordingEvidence": 1, "InsertRecordingEvidence": 1, "SaveTerminal": 1}, func(phase context.Context) (v2.Message, error) {
					return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", evidence)
				})
			}); err != nil {
				t.Fatal(err)
			}
			if _, err := terminalRecordingStep(t, f, evidence, func() (v2.Message, error) {
				return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalRecordingEvidence": 1}, func(phase context.Context) (v2.Message, error) {
					return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", evidence)
				})
			}); err != nil {
				t.Fatal("evidence retry", err)
			}
			frozen, err := terminalRecordStep(t, f, func() (v2.Message, error) {
				return withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "SaveTerminal": 1, "InvalidateTerminalOperations": 1}, func(phase context.Context) (v2.Message, error) {
					return f.s.FinalizeTerminal(phase, f.p, f.project, f.task, m.SessionID, "1", final)
				})
			})
			if err != nil {
				t.Fatal(err)
			}
			reason := "recording_not_enabled"
			if enabled {
				reason = "ended_before_first_sample"
			}
			receipt := m
			receipt.Type = "receipt"
			receipt.Payload = v2.Receipt{FinalizationID: *frozen.Payload.(v2.GenerationLedger).FinalizationID, Disposition: "unavailable", Reason: &reason, Evidence: &v2.NoRecordingEvidence{RecordingEnabled: enabled, SelectedFrameCount: "0", RegisteredFrameCount: "0"}}
			p := receipt.Payload.(v2.Receipt)
			p.DispositionDigest, err = v2.ReceiptDigest(receipt)
			if err != nil {
				t.Fatal(err)
			}
			receipt.Payload = p
			got, err := withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalArchive": 1, "SaveTerminalReceipt": 1}, func(phase context.Context) (v2.Message, error) {
				return f.s.UpdateTerminalArchive(phase, f.p, f.project, f.task, m.SessionID, receipt)
			})
			if err != nil || !reflect.DeepEqual(got, receipt) {
				t.Fatal(got, err)
			}
			selectUnavailableTerminalReceipt(t, f, got)
			if _, err = withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalArchive": 1}, func(phase context.Context) (v2.Message, error) {
				return f.s.UpdateTerminalArchive(phase, f.p, f.project, f.task, m.SessionID, receipt)
			}); err != nil {
				t.Fatal("receipt retry", err)
			}
			status, err := withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalArchive": 1}, func(phase context.Context) (v2.Message, error) {
				return f.s.TerminalArchiveStatus(phase, f.p, f.project, f.task, m.SessionID)
			})
			if err != nil || status.Payload.(v2.ArchiveStatus).State != "unavailable" {
				t.Fatal(status, err)
			}
			if _, err = withinRecordingPhase(f, ctx, map[string]int{"ReadCredential": 1, "ProjectAccess": 1, "ArchiveMetadata": 1}, func(phase context.Context) (*RetainedArchive, error) {
				return f.s.TerminalArchiveContent(phase, f.p, f.project, f.task, m.SessionID)
			}); err == nil {
				t.Fatal("unavailable returned body")
			}
			pending := m
			pending.Type = "archive_status"
			pending.Payload = v2.ArchiveStatus{State: "pending", FinalizationID: frozen.Payload.(v2.GenerationLedger).FinalizationID}
			if got, err := withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalArchive": 1}, func(phase context.Context) (v2.Message, error) {
				return f.s.UpdateTerminalArchive(phase, f.p, f.project, f.task, m.SessionID, pending)
			}); err != nil || got.Payload.(v2.ArchiveStatus).State != "unavailable" {
				t.Fatal("terminal status overwritten", got, err)
			}
		})
	}
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
	canonical, err := v2.CanonicalJSON(message)
	if err != nil {
		t.Fatal(err)
	}
	observed, err := withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalRecordingEvidence": 1}, func(phase context.Context) (map[string]any, error) {
		return f.s.TerminalRecordingEvidence(phase, f.p, f.project, f.task, m.SessionID, "1", e.EvidenceID)
	})
	if err != nil || observed["bodyHash"] != v2.HashBytes(canonical) || observed["revision"] != "1" {
		t.Fatal(observed, err)
	}
	state, err := terminalStateStep(t, f, func() (map[string]any, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "ExpireTerminalOperations": 1, "TerminalArchive": 1}, func(phase context.Context) (map[string]any, error) {
			return f.s.TerminalState(phase, f.p, f.project, f.task, m.SessionID)
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	recording := state["recording"].([]map[string]any)
	if len(recording) != 1 || recording[0]["evidence"].(*v2.RecordingEvidence).EvidenceID != failed.EvidenceID {
		t.Fatal("old retry moved latest evidence", recording)
	}
	if _, err = withinRecordingPhase(f, ctx, map[string]int{}, func(phase context.Context) (map[string]any, error) {
		return f.s.TerminalRecordingEvidence(phase, f.p, f.project, f.task, m.SessionID, "01", e.EvidenceID)
	}); err == nil {
		t.Fatal("noncanonical generation read")
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
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "LockTerminal": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.RegisterTerminal(phase, f.p, f.project, f.task, request)
		})
	})
	if err != nil || ack.ExecutionGeneration != "1" || ack.Payload.(v2.RegistrationAck).ConnectionEpoch != "2" {
		t.Fatal(ack, err)
	}
	if got, err := terminalRegistrationStep(t, f, request.SessionID, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "LockTerminal": 1}, func(phase context.Context) (v2.Message, error) {
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
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "LockTerminal": 1}, func(phase context.Context) (v2.Message, error) {
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
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "LockTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return remote.RegisterTerminal(phase, f.p, f.project, f.task, request)
		})
	}); err == nil {
		t.Fatal("live relay affinity bypassed")
	}
	remote.now = func() time.Time { return time.Now().Add(HeartbeatTimeout + time.Second) }
	if _, err = terminalRegistrationStep(t, f, request.SessionID, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "LockTerminal": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1}, func(phase context.Context) (v2.Message, error) {
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
	state, err := terminalStateStep(t, f, func() (map[string]any, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "ExpireTerminalOperations": 1, "TerminalArchive": 1}, func(phase context.Context) (map[string]any, error) {
			return f.s.TerminalState(phase, f.p, f.project, f.task, m.SessionID)
		})
	})
	if err != nil || state["executionGeneration"] != "2" || state["connected"] != false {
		t.Fatal(state, err)
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
			state, err := terminalStateStep(t, f, func() (map[string]any, error) {
				return withinRecordingPhase(f, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "ExpireTerminalOperations": 1, "TerminalArchive": 1}, func(phase context.Context) (map[string]any, error) {
					return f.s.TerminalState(phase, f.p, f.project, f.task, m.SessionID)
				})
			})
			if err != nil {
				t.Fatal(err)
			}
			runs := state["ledger"].(v2.GenerationLedger).Runs
			if state["executionGeneration"] != "2" || len(runs) != 2 || !reflect.DeepEqual(runs[0], stopped) || runs[0].Binding.NativeSessionID != nil || !reflect.DeepEqual(runs[1], recovery) {
				t.Fatal("recovery changed the original frozen run", state)
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
func TestTerminalHistoryPaginationFindsOldClaimsAndHonorsDeletion(t *testing.T) {
	f, m := terminalFixture(t)
	ctx := context.Background()
	f.terminal.CurrentID = ""
	current, err := terminalStateStep(t, f, func() (map[string]any, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "CurrentTerminalSession": 1}, func(phase context.Context) (map[string]any, error) {
			return f.s.CurrentTerminal(phase, f.p, f.project, f.task)
		})
	})
	if err != nil || current["status"] != "not_registered" {
		t.Fatal(current, err)
	}
	if _, err = terminalRegistrationStep(t, f, m.SessionID, func() (v2.Message, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTaskRegistration": 1, "LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1, "InsertTerminal": 1}, func(phase context.Context) (v2.Message, error) {
			return f.s.RegisterTerminal(phase, f.p, f.project, f.task, m)
		})
	}); err != nil {
		t.Fatal(err)
	}
	f.terminal.CurrentID = m.SessionID
	ids := []string{uuid.NewString(), uuid.NewString(), m.SessionID}
	oldRecord := f.terminal.Record(t)
	oldRecord.Envelope.SessionID = ids[0]
	oldRecord.Envelope.ClaimID = uuid.NewString()
	oldRaw := encode(oldRecord)
	priorRead := f.dao.LockTerminalFn
	f.dao.LockTerminalFn = func(ctx context.Context, id string) ([]byte, error) {
		if id == ids[0] {
			return oldRaw, nil
		}
		return priorRead(ctx, id)
	}
	created := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	rows := []store.TerminalHistoryRow{
		{ID: ids[2], Claim: m.ClaimID, Backend: "herdr", Created: created, Terminal: append([]byte(nil), f.terminal.Raw...)},
		{ID: ids[1], Claim: uuid.NewString(), Backend: "herdr", Created: created.Add(-time.Second), Terminal: oldRaw},
		{ID: ids[0], Claim: oldRecord.Envelope.ClaimID, Backend: "herdr", Created: created.Add(-2 * time.Second), Terminal: oldRaw},
	}
	f.dao.TerminalHistoryFn = func(_ context.Context, project, taskID string, before *time.Time, beforeID *string, limit int) ([]store.TerminalHistoryRow, error) {
		if project != f.project || taskID != f.task || limit != 3 {
			t.Fatal("history changed its DAO scope or lookahead limit")
		}
		if before == nil && beforeID == nil {
			return rows, nil
		}
		if before == nil || beforeID == nil || !before.Equal(rows[1].Created) || *beforeID != rows[1].ID {
			t.Fatal("history cursor did not preserve the last returned row")
		}
		return rows[2:], nil
	}
	f.dao.Expect("TerminalHistory", 2)
	priorArchive := f.dao.TerminalArchiveFn
	f.dao.TerminalArchiveFn = func(ctx context.Context, id string) (v2.ArchiveStatus, *v2.Receipt, string, error) {
		if id == ids[0] {
			return v2.ArchiveStatus{State: "pending"}, nil, "", nil
		}
		return priorArchive(ctx, id)
	}
	priorExpire := f.dao.ExpireTerminalOperationsFn
	f.dao.ExpireTerminalOperationsFn = func(ctx context.Context, id string, now time.Time) error {
		if id == ids[0] {
			return nil
		}
		return priorExpire(ctx, id, now)
	}
	current, err = terminalStateStep(t, f, func() (map[string]any, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "ExpireTerminalOperations": 1, "TerminalArchive": 1, "CurrentTerminalSession": 1}, func(phase context.Context) (map[string]any, error) {
			return f.s.CurrentTerminal(phase, f.p, f.project, f.task)
		})
	})
	if err != nil || current["sessionId"] != ids[2] {
		t.Fatal(current, err)
	}
	old, err := terminalStateStep(t, f, func() (map[string]any, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "ExpireTerminalOperations": 1, "TerminalArchive": 1}, func(phase context.Context) (map[string]any, error) {
			return f.s.TerminalState(phase, f.p, f.project, f.task, ids[0])
		})
	})
	if err != nil || old["connected"] != false {
		t.Fatal(old, err)
	}
	page, err := withinRecordingPhase(f, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "TerminalHistory": 1}, func(phase context.Context) (map[string]any, error) {
		return f.s.TerminalHistory(phase, f.p, f.project, f.task, "", 2)
	})
	if err != nil {
		t.Fatal(err)
	}
	items := page["items"].([]map[string]any)
	token := page["nextCursor"].(*string)
	if len(items) != 2 || token == nil || items[0]["sessionId"] != ids[2] || items[1]["sessionId"] != ids[1] {
		t.Fatal(page)
	}
	next, err := withinRecordingPhase(f, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "TerminalHistory": 1}, func(phase context.Context) (map[string]any, error) {
		return f.s.TerminalHistory(phase, f.p, f.project, f.task, *token, 2)
	})
	if err != nil || len(next["items"].([]map[string]any)) != 1 || next["nextCursor"].(*string) != nil || next["items"].([]map[string]any)[0]["sessionId"] != ids[0] {
		t.Fatal(next, err)
	}
	if _, err = withinRecordingPhase(f, ctx, map[string]int{}, func(phase context.Context) (map[string]any, error) {
		return f.s.TerminalHistory(phase, f.p, f.project, uuid.NewString(), *token, 2)
	}); err == nil {
		t.Fatal("foreign task cursor")
	}
	if _, err = withinRecordingPhase(f, ctx, map[string]int{}, func(phase context.Context) (map[string]any, error) {
		return f.s.TerminalHistory(phase, f.p, f.project, f.task, "not base64", 2)
	}); err == nil {
		t.Fatal("malformed cursor")
	}
	if _, err = withinRecordingPhase(f, ctx, map[string]int{}, func(phase context.Context) (map[string]any, error) {
		return f.s.TerminalHistory(phase, f.p, f.project, f.task, "", 201)
	}); err == nil {
		t.Fatal("unbounded history")
	}
	f.data.Task.Status = "done"
	f.data.TaskDeleted = true
	if _, err = terminalStateStep(t, f, func() (map[string]any, error) {
		return withinRecordingPhase(f, ctx, map[string]int{"LockTask": 1}, func(phase context.Context) (map[string]any, error) {
			return f.s.TerminalState(phase, f.p, f.project, f.task, ids[0])
		})
	}); err == nil {
		t.Fatal("deleted task visible")
	}
	if _, err = withinRecordingPhase(f, ctx, map[string]int{"LockTask": 1}, func(phase context.Context) (map[string]any, error) {
		return f.s.TerminalHistory(phase, f.p, f.project, f.task, "", 2)
	}); err == nil {
		t.Fatal("deleted history visible")
	}
	if _, err = withinRecordingPhase(f, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalArchive": 1}, func(phase context.Context) (v2.Message, error) {
		return f.s.TerminalArchiveStatus(phase, f.p, f.project, f.task, ids[0])
	}); err != nil {
		t.Fatal("original owner cannot finish deleted task", err)
	}
}
