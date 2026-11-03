package sessionrelay

import (
	"context"
	"reflect"
	"testing"
	"time"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol/v2"
	"github.com/google/uuid"
)

func terminalRunFixture(t *testing.T, enabled bool) (fixture, v2.Message, v2.Run, string) {
	t.Helper()
	f, m := terminalFixture(t)
	ctx := context.Background()
	if _, err := f.s.RegisterTerminal(ctx, f.p, f.project, f.task, m); err != nil {
		t.Fatal(err)
	}
	p := m.Payload.(v2.Registration)
	run := v2.Run{ExecutionGeneration: "1", Owner: p.Owner, Binding: p.Binding, StartedAt: "2026-01-01T00:00:00Z", SegmentIDs: []string{}}
	ledger := m
	ledger.Type = "generation_ledger"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{run}}
	if _, err := f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", ledger); err != nil {
		t.Fatal(err)
	}
	rid := uuid.NewString()
	responsibility := m
	responsibility.Type = "recording_responsibility"
	responsibility.Payload = v2.RecordingResponsibility{ResponsibilityID: rid, RecordingEnabled: enabled}
	if _, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", responsibility); err != nil {
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
	if _, err := f.s.UpdateTerminalLedger(context.Background(), f.p, f.project, f.task, m.SessionID, "1", ledger); err != nil {
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
			if _, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", zeroEvidence(m, rid)); err == nil {
				t.Fatal("closed before stopped")
			}
			run = stopTerminalRun(t, f, m, run)
			archiveTerminal(t, f)
			final := m
			final.Type = "finalization"
			final.Payload = v2.Finalization{FinalizationID: uuid.NewString(), ClaimTerminal: true, Runs: []v2.Run{run}}
			if _, err := f.s.FinalizeTerminal(ctx, f.p, f.project, f.task, m.SessionID, "1", final); err == nil {
				t.Fatal("finalized without closed evidence")
			}
			evidence := zeroEvidence(m, rid)
			if _, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", evidence); err != nil {
				t.Fatal(err)
			}
			if _, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", evidence); err != nil {
				t.Fatal("evidence retry", err)
			}
			frozen, err := f.s.FinalizeTerminal(ctx, f.p, f.project, f.task, m.SessionID, "1", final)
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
			got, err := f.s.UpdateTerminalArchive(ctx, f.p, f.project, f.task, m.SessionID, receipt)
			if err != nil || !reflect.DeepEqual(got, receipt) {
				t.Fatal(got, err)
			}
			if _, err = f.s.UpdateTerminalArchive(ctx, f.p, f.project, f.task, m.SessionID, receipt); err != nil {
				t.Fatal("receipt retry", err)
			}
			status, err := f.s.TerminalArchiveStatus(ctx, f.p, f.project, f.task, m.SessionID)
			if err != nil || status.Payload.(v2.ArchiveStatus).State != "unavailable" {
				t.Fatal(status, err)
			}
			if _, err = f.s.TerminalArchiveContent(ctx, f.p, f.project, f.task, m.SessionID); err == nil {
				t.Fatal("unavailable returned body")
			}
			pending := m
			pending.Type = "archive_status"
			pending.Payload = v2.ArchiveStatus{State: "pending", FinalizationID: frozen.Payload.(v2.GenerationLedger).FinalizationID}
			if got, err := f.s.UpdateTerminalArchive(ctx, f.p, f.project, f.task, m.SessionID, pending); err != nil || got.Payload.(v2.ArchiveStatus).State != "unavailable" {
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
	if _, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", message); err != nil {
		t.Fatal(err)
	}
	sameID := e
	sameID.Revision = "2"
	sameID.RegisteredFrameCount = "1"
	message.Payload = sameID
	if _, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", message); err == nil {
		t.Fatal("evidence ID was reused with different bytes")
	}
	rollback := e
	rollback.EvidenceID = uuid.NewString()
	rollback.Revision = "2"
	rollback.SelectedFrameCount = "0"
	message.Payload = rollback
	if _, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", message); err == nil {
		t.Fatal("selected count rolled back")
	}
	failed := e
	failed.EvidenceID = uuid.NewString()
	failed.Revision = "2"
	code := "source_corrupt"
	failed.CaptureError = &code
	message.Payload = failed
	if _, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", message); err != nil {
		t.Fatal(err)
	}
	cleared := failed
	cleared.EvidenceID = uuid.NewString()
	cleared.Revision = "3"
	cleared.CaptureError = nil
	message.Payload = cleared
	if _, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", message); err == nil {
		t.Fatal("capture error erased")
	}
	message.Payload = e
	if _, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", message); err != nil {
		t.Fatal("old immutable evidence retry", err)
	}
	canonical, err := v2.CanonicalJSON(message)
	if err != nil {
		t.Fatal(err)
	}
	observed, err := f.s.TerminalRecordingEvidence(ctx, f.p, f.project, f.task, m.SessionID, "1", e.EvidenceID)
	if err != nil || observed["bodyHash"] != v2.HashBytes(canonical) || observed["revision"] != "1" {
		t.Fatal(observed, err)
	}
	state, err := f.s.TerminalState(ctx, f.p, f.project, f.task, m.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	recording := state["recording"].([]map[string]any)
	if len(recording) != 1 || recording[0]["evidence"].(*v2.RecordingEvidence).EvidenceID != failed.EvidenceID {
		t.Fatal("old retry moved latest evidence", recording)
	}
	if _, err = f.s.TerminalRecordingEvidence(ctx, f.p, f.project, f.task, m.SessionID, "01", e.EvidenceID); err == nil {
		t.Fatal("noncanonical generation read")
	}

	reused := e
	reused.Revision = "3"
	message.Payload = reused
	if _, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", message); err == nil {
		t.Fatal("old evidence identity was rebound after a newer checkpoint")
	}
	message.Payload = failed
	if _, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "9", message); err == nil {
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
	ack, err := f.s.RegisterTerminal(ctx, f.p, f.project, f.task, request)
	if err != nil || ack.ExecutionGeneration != "1" || ack.Payload.(v2.RegistrationAck).ConnectionEpoch != "2" {
		t.Fatal(ack, err)
	}
	if got, err := f.s.RegisterTerminal(ctx, f.p, f.project, f.task, request); err != nil || !reflect.DeepEqual(got, ack) {
		t.Fatal(got, err)
	}
	ledger := m
	ledger.Type = "generation_ledger"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{run}}
	if _, err = f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", ledger); err == nil {
		t.Fatal("old connection ledger accepted")
	}
	if _, err = f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "2", ledger); err != nil {
		t.Fatal(err)
	}
	reg.Binding.TerminalID = "replacement"
	request.Payload = reg
	if _, err = f.s.RegisterTerminal(ctx, f.p, f.project, f.task, request); err == nil {
		t.Fatal("changed terminal reconnected")
	}
	remote := New(f.s.DB)
	remote.Origin = f.s.Origin
	reg = m.Payload.(v2.Registration)
	reg.Mode = "reconnect"
	epoch = "2"
	reg.ConnectionEpoch = &epoch
	request.Payload = reg
	if _, err = remote.RegisterTerminal(ctx, f.p, f.project, f.task, request); err == nil {
		t.Fatal("live relay affinity bypassed")
	}
	remote.now = func() time.Time { return time.Now().Add(HeartbeatTimeout + time.Second) }
	if _, err = remote.RegisterTerminal(ctx, f.p, f.project, f.task, request); err != nil {
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
	if _, err := f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", ledger); err != nil {
		t.Fatal(err)
	}
	nextRun := run
	nextRun.ExecutionGeneration = "2"
	nextRun.Binding.TerminalID = "term_recovery"
	ledger.ExecutionGeneration = "2"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{run, nextRun}}
	if _, err := f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", ledger); err == nil {
		t.Fatal("unstopped generation replaced")
	}
	run = stopTerminalRun(t, f, m, run)
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{run, nextRun}}
	if _, err := f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", ledger); err != nil {
		t.Fatal(err)
	}
	state, err := f.s.TerminalState(ctx, f.p, f.project, f.task, m.SessionID)
	if err != nil || state["executionGeneration"] != "2" || state["connected"] != false {
		t.Fatal(state, err)
	}
	original := run
	original.Binding.TerminalID = "altered-original"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{original, nextRun}}
	if _, err := f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", ledger); err == nil {
		t.Fatal("old original run changed")
	}
	nextRun.Binding.NativeSessionID = nil
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{run, nextRun}}
	if _, err := f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", ledger); err == nil {
		t.Fatal("native session identity erased")
	}
}
func TestTerminalHistoryPaginationFindsOldClaimsAndHonorsDeletion(t *testing.T) {
	f, m := terminalFixture(t)
	ctx := context.Background()
	current, err := f.s.CurrentTerminal(ctx, f.p, f.project, f.task)
	if err != nil || current["status"] != "not_registered" {
		t.Fatal(current, err)
	}
	ids := []string{}
	for i := 0; i < 3; i++ {
		if i > 0 {
			m.SessionID = uuid.NewString()
			m.ClaimID = uuid.NewString()
			reg := m.Payload.(v2.Registration)
			reg.RegistrationID = uuid.NewString()
			m.Payload = reg
			if _, err = f.s.DB.Pool.Exec(ctx, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{claimId}',to_jsonb($2::text))::text WHERE task_id=$1 AND name='worker'`, f.task, m.ClaimID); err != nil {
				t.Fatal(err)
			}
		}
		if _, err = f.s.RegisterTerminal(ctx, f.p, f.project, f.task, m); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, m.SessionID)
	}
	current, err = f.s.CurrentTerminal(ctx, f.p, f.project, f.task)
	if err != nil || current["sessionId"] != ids[2] {
		t.Fatal(current, err)
	}
	old, err := f.s.TerminalState(ctx, f.p, f.project, f.task, ids[0])
	if err != nil || old["connected"] != false {
		t.Fatal(old, err)
	}
	page, err := f.s.TerminalHistory(ctx, f.p, f.project, f.task, "", 2)
	if err != nil {
		t.Fatal(err)
	}
	items := page["items"].([]map[string]any)
	token := page["nextCursor"].(*string)
	if len(items) != 2 || token == nil {
		t.Fatal(page)
	}
	next, err := f.s.TerminalHistory(ctx, f.p, f.project, f.task, *token, 2)
	if err != nil || len(next["items"].([]map[string]any)) != 1 || next["nextCursor"].(*string) != nil {
		t.Fatal(next, err)
	}
	if _, err = f.s.TerminalHistory(ctx, f.p, f.project, uuid.NewString(), *token, 2); err == nil {
		t.Fatal("foreign task cursor")
	}
	if _, err = f.s.TerminalHistory(ctx, f.p, f.project, f.task, "not base64", 2); err == nil {
		t.Fatal("malformed cursor")
	}
	if _, err = f.s.TerminalHistory(ctx, f.p, f.project, f.task, "", 201); err == nil {
		t.Fatal("unbounded history")
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `UPDATE tasks SET deleted_at=now(),status='done' WHERE id=$1`, f.task); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.TerminalState(ctx, f.p, f.project, f.task, ids[0]); err == nil {
		t.Fatal("deleted task visible")
	}
	if _, err = f.s.TerminalHistory(ctx, f.p, f.project, f.task, "", 2); err == nil {
		t.Fatal("deleted history visible")
	}
	if _, err = f.s.TerminalArchiveStatus(ctx, f.p, f.project, f.task, ids[0]); err != nil {
		t.Fatal("original owner cannot finish deleted task", err)
	}
}
