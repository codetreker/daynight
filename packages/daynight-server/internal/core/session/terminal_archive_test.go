package session

import (
	"context"
	"os"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func terminalArchiveFixture(t *testing.T) (fixture, v2.Message, v2.Archive) {
	t.Helper()
	return terminalArchiveFixtureWithNative(t, nil)
}
func terminalArchiveFixtureWithNative(t *testing.T, nativeSession *string) (fixture, v2.Message, v2.Archive) {
	t.Helper()
	f, m := terminalFixture(t)
	raw, err := os.ReadFile("../../../../daynight/test/session/fixtures/v2/valid-archive.json")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := v2.DecodeArchive(raw)
	if err != nil {
		t.Fatal(err)
	}
	for i := range doc.Runs {
		doc.Runs[i].Binding.NativeSessionID = nativeSession
		doc.Runs[i].StopProof.Binding.NativeSessionID = nativeSession
	}
	for i := range doc.Segments {
		doc.Segments[i].Binding.NativeSessionID = nativeSession
	}
	reg := m.Payload.(v2.Registration)
	reg.Binding = doc.Runs[0].Binding
	m.Payload = reg
	configureTerminalFixture(t, &f, m)
	doc.SessionID = m.SessionID
	doc.ClaimID = m.ClaimID
	doc.Owner = reg.Owner
	doc.FinalizationID = uuid.NewString()
	for i := range doc.Runs {
		doc.Runs[i].Owner = reg.Owner
	}
	ctx := context.Background()
	if _, err = terminalRegistrationStep(t, f, m.SessionID, func() (v2.Message, error) {
		phase := f.TerminalRegistrationPhase(ctx, map[string]int{"InsertTerminal": 1})
		defer f.dao.FinishContext(phase)
		return f.s.RegisterTerminal(phase, f.p, f.project, f.task, m)
	}); err != nil {
		t.Fatal(err)
	}
	active := doc.Runs[0]
	active.StopProof = nil
	active.StoppedAt = nil
	ledger := m
	ledger.Type = "generation_ledger"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{active}}
	if _, err = terminalRecordStep(t, f, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, map[string]int{"SaveTerminal": 1})
		defer f.dao.FinishContext(phase)
		return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "1", ledger)
	}); err != nil {
		t.Fatal(err)
	}
	responsibility := m
	responsibility.Type = "recording_responsibility"
	responsibility.Payload = v2.RecordingResponsibility{ResponsibilityID: uuid.NewString(), RecordingEnabled: true}
	if _, err = terminalRecordingStep(t, f, responsibility, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, map[string]int{"SaveTerminal": 1})
		defer f.dao.FinishContext(phase)
		return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", responsibility)
	}); err != nil {
		t.Fatal(err)
	}
	ledger.Payload = v2.GenerationLedger{Runs: doc.Runs}
	if _, err = terminalRecordStep(t, f, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, map[string]int{"SaveTerminal": 1})
		defer f.dao.FinishContext(phase)
		return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "1", ledger)
	}); err != nil {
		t.Fatal(err)
	}
	digest, err := v2.SourceDigest(doc, "1")
	if err != nil {
		t.Fatal(err)
	}
	evidence := m
	evidence.Type = "recording_evidence"
	evidence.Payload = v2.RecordingEvidence{ResponsibilityID: responsibility.Payload.(v2.RecordingResponsibility).ResponsibilityID, EvidenceID: uuid.NewString(), Revision: "1", SelectedFrameCount: "1", RegisteredFrameCount: "1", Closed: true, JournalSHA256: v2.HashBytes([]byte("durable journal")), SourceSHA256: digest}
	if _, err = terminalRecordingStep(t, f, evidence, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, map[string]int{"TerminalRecordingEvidence": 1, "InsertRecordingEvidence": 1, "SaveTerminal": 1})
		defer f.dao.FinishContext(phase)
		return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", evidence)
	}); err != nil {
		t.Fatal(err)
	}
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	f.s.files = files
	state := "pending"
	f.terminal.History = []store.TerminalHistoryRow{{ID: m.SessionID, Claim: m.ClaimID, Backend: "herdr", Created: f.terminal.Registration.LastSeen, Terminal: append([]byte(nil), f.terminal.Raw...), State: &state}}
	return f, m, doc
}
func finalizeFixture(t *testing.T, f fixture, m v2.Message, doc v2.Archive) v2.Message {
	t.Helper()
	archiveTerminal(t, f)
	final := m
	final.Type = "finalization"
	final.Payload = v2.Finalization{FinalizationID: doc.FinalizationID, ClaimTerminal: true, Runs: doc.Runs}
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		phase := f.TerminalPhase(context.Background(), true, map[string]int{"InvalidateTerminalOperations": 1, "SaveTerminal": 1})
		defer f.dao.FinishContext(phase)
		return f.s.FinalizeTerminal(phase, f.p, f.project, f.task, m.SessionID, "1", final)
	}); err != nil {
		t.Fatal(err)
	}
	return final
}
func TestTerminalFinalizationAndGenerationGrantCannotBothSucceed(t *testing.T) {
	for _, order := range []string{"finalization first", "generation first"} {
		t.Run(order, func(t *testing.T) {
			f, m, doc := terminalArchiveFixture(t)
			ctx := context.Background()
			archiveTerminal(t, f)
			final := m
			final.Type = "finalization"
			final.Payload = v2.Finalization{FinalizationID: doc.FinalizationID, ClaimTerminal: true, Runs: doc.Runs}
			next := doc.Runs[0]
			next.ExecutionGeneration = "2"
			next.Binding.TerminalID = "term_next"
			next.SegmentIDs = []string{}
			next.StopProof = nil
			next.StoppedAt = nil
			ledger := m
			ledger.Type = "generation_ledger"
			ledger.ExecutionGeneration = "2"
			ledger.Payload = v2.GenerationLedger{Runs: append(append([]v2.Run{}, doc.Runs...), next)}
			finalize := func() error {
				_, err := terminalRecordStep(t, f, func() (v2.Message, error) {
					phase := f.TerminalPhase(ctx, true, map[string]int{"InvalidateTerminalOperations": 1, "SaveTerminal": 1})
					defer f.dao.FinishContext(phase)
					return f.s.FinalizeTerminal(phase, f.p, f.project, f.task, m.SessionID, "1", final)
				})
				return err
			}
			grant := func() error {
				_, err := terminalRecordStep(t, f, func() (v2.Message, error) {
					phase := f.TerminalPhase(ctx, true, map[string]int{})
					defer f.dao.FinishContext(phase)
					return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "1", ledger)
				})
				return err
			}
			f.dao.Expect("SaveTerminal", 1)
			var finalErr, grantErr error
			if order == "finalization first" {
				finalErr, grantErr = finalize(), grant()
			} else {
				grantErr, finalErr = grant(), finalize()
			}
			if finalErr != nil || grantErr == nil {
				t.Fatalf("stopped claim decisions: finalize=%v grant=%v", finalErr, grantErr)
			}
			got := f.terminal.Record(t)
			if got.Envelope.ExecutionGeneration != "1" || got.FinalizationID == nil || *got.FinalizationID != doc.FinalizationID {
				t.Fatal("stopped claim changed generation or finalization identity")
			}
		})
	}
}
