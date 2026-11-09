package session

import (
	"bytes"
	"context"
	"os"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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
func TestTerminalArchiveReadyReadsActualBytesAndSurvivesNewClaim(t *testing.T) {
	f, m, doc := terminalArchiveFixture(t)
	ctx := context.Background()
	f.dao.Expect("SaveTerminalReceipt", 1)
	data := encode(doc)
	if _, err := fixtureTerminalUpload(f, ctx, f.p, f.project, f.task, m.SessionID, data, map[string]int{"TerminalArchive": 0, "SaveTerminalReceipt": 0}); err == nil {
		t.Fatal("unfrozen archive accepted")
	}
	final := finalizeFixture(t, f, m, doc)
	receipt, err := fixtureTerminalUpload(f, ctx, f.p, f.project, f.task, m.SessionID, data, nil)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Payload.(v2.Receipt).Disposition != "ready" {
		t.Fatal(receipt)
	}
	selectTerminalArchiveReadback(t, f, m.SessionID, data, receipt.Payload.(v2.Receipt))
	ready, hash, size, completeness := "ready", v2.HashBytes(data), decimal(int64(len(data))), doc.Completeness
	f.terminal.History[0].State, f.terminal.History[0].Hash, f.terminal.History[0].Size, f.terminal.History[0].Completeness = &ready, &hash, &size, &completeness
	if _, err = v2.DecodeMessage(encode(receipt)); err != nil {
		t.Fatal("invalid generated receipt", err)
	}
	if retry, err := fixtureTerminalUpload(f, ctx, f.p, f.project, f.task, m.SessionID, data, map[string]int{"SaveTerminalReceipt": 0}); err != nil || !reflect.DeepEqual(receipt, retry) {
		t.Fatal(retry, err)
	}
	if _, err = fixtureTerminalUpload(f, ctx, f.p, f.project, f.task, m.SessionID, append(data, ' '), map[string]int{"SaveTerminalReceipt": 0}); err == nil {
		t.Fatal("immutable bytes replaced")
	}
	if _, err = terminalRecordStep(t, f, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, map[string]int{})
		defer f.dao.FinishContext(phase)
		return f.s.FinalizeTerminal(phase, f.p, f.project, f.task, m.SessionID, "1", final)
	}); err != nil {
		t.Fatal("finalization retry", err)
	}
	final.Payload = v2.Finalization{FinalizationID: uuid.NewString(), ClaimTerminal: true, Runs: doc.Runs}
	if _, err = terminalRecordStep(t, f, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, map[string]int{})
		defer f.dao.FinishContext(phase)
		return f.s.FinalizeTerminal(phase, f.p, f.project, f.task, m.SessionID, "1", final)
	}); err == nil {
		t.Fatal("second seal allowed")
	}
	f.data.Task.Worker.ClaimID = uuid.NewString()
	restarted := New(f.writer, f.s.files)
	restarted.Origin = f.s.Origin
	got, err := fixtureTerminalContent(f, restarted, ctx, f.p, f.project, f.task, m.SessionID, nil)
	if err != nil || !bytes.Equal(got.Data, data) {
		t.Fatal("history content", err)
	}
	if err := got.Close(); err != nil {
		t.Fatal(err)
	}
	page, err := fixtureTerminalHistory(f, restarted, ctx, f.p, f.project, f.task, "", 1, nil)
	if err != nil || len(page["items"].([]map[string]any)) != 1 {
		t.Fatal(page, err)
	}
	entry := page["items"].([]map[string]any)[0]
	if entry["sessionId"] != m.SessionID || entry["claimId"] != m.ClaimID || entry["archive"].(map[string]any)["state"] != "ready" {
		t.Fatal("fixed archive history changed identity or disposition", entry)
	}
	status, err := fixtureTerminalStatus(f, restarted, ctx, f.p, f.project, f.task, m.SessionID, nil)
	if err != nil || status.Payload.(v2.ArchiveStatus).State != "ready" {
		t.Fatal(status, err)
	}
	stored, err := fixtureTerminalReceipt(f, restarted, ctx, f.p, f.project, f.task, m.SessionID, nil)
	if err != nil || !reflect.DeepEqual(stored, receipt) {
		t.Fatal(stored, err)
	}
	if _, err = fixtureTerminalContent(f, restarted, ctx, f.p, uuid.NewString(), f.task, m.SessionID, map[string]int{"ProjectAccess": 1, "ArchiveMetadata": 0, "LockTask": 0, "LockCredential": 0, "LockTerminal": 0, "TerminalArchive": 0}); err == nil {
		t.Fatal("cross-project read")
	}
	path := "projects/" + f.project + "/" + m.SessionID[:2] + "/" + m.SessionID + "/" + v2.HashBytes(data) + ".json"
	if _, err = f.s.files.Put(ctx, archiveBucket, path, bytes.NewBufferString("corrupt")); err != nil {
		t.Fatal(err)
	}
	if _, err = fixtureTerminalContent(f, restarted, ctx, f.p, f.project, f.task, m.SessionID, nil); err == nil {
		t.Fatal("corrupt stored object read")
	}
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
func TestTerminalArchiveRejectsEvidenceMismatchAndRevokedAuthority(t *testing.T) {
	f, m, doc := terminalArchiveFixture(t)
	ctx := context.Background()
	finalizeFixture(t, f, m, doc)
	altered := doc
	altered.Owner.WorkerID = uuid.NewString()
	if _, err := fixtureTerminalUpload(f, ctx, f.p, f.project, f.task, m.SessionID, encode(altered), map[string]int{"ProjectAccess": 1, "LockArchiveTask": 0, "LockCredential": 0, "LockTerminal": 0, "TerminalArchive": 0, "SaveTerminalReceipt": 0}); err == nil {
		t.Fatal("foreign archive accepted")
	}
	other := f.p
	other.Kind = model.SessionCredential
	if _, err := fixtureTerminalUpload(f, ctx, other, f.project, f.task, m.SessionID, encode(doc), map[string]int{"ArchiveMetadata": 0, "ProjectAccess": 0, "LockArchiveTask": 0, "LockCredential": 0, "LockTerminal": 0, "TerminalArchive": 0, "SaveTerminalReceipt": 0}); err == nil {
		t.Fatal("browser finalized archive")
	}
	f.dao.ProjectAccessFn = func(context.Context, string, string) (model.ProjectAccess, error) {
		return model.ProjectAccess{}, model.ErrNotFound
	}
	if _, err := fixtureTerminalUpload(f, ctx, f.p, f.project, f.task, m.SessionID, encode(doc), map[string]int{"ArchiveMetadata": 0, "ProjectAccess": 1, "LockArchiveTask": 0, "LockCredential": 0, "LockTerminal": 0, "TerminalArchive": 0, "SaveTerminalReceipt": 0}); err == nil {
		t.Fatal("revoked owner uploaded")
	}
	if _, err := fixtureTerminalHistory(f, f.s, ctx, f.p, f.project, f.task, "", 20, map[string]int{"TerminalHistory": 0}); err == nil {
		t.Fatal("revoked viewer history")
	}
}

func TestTerminalFailedArchiveAndCaptureErrorsNeverBecomeUnavailable(t *testing.T) {
	for _, cause := range []string{"source_corrupt", "recording_limit", "failed_status"} {
		t.Run(cause, func(t *testing.T) {
			f, m, run, rid := terminalRunFixture(t, true)
			ctx := context.Background()
			run = stopTerminalRun(t, f, m, run)
			evidence := zeroEvidence(m, rid)
			e := evidence.Payload.(v2.RecordingEvidence)
			if cause != "failed_status" {
				e.CaptureError = &cause
			}
			evidence.Payload = e
			if _, err := terminalRecordingStep(t, f, evidence, func() (v2.Message, error) {
				phase := f.TerminalPhase(ctx, true, map[string]int{"TerminalRecordingEvidence": 1, "InsertRecordingEvidence": 1, "SaveTerminal": 1})
				defer f.dao.FinishContext(phase)
				return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", evidence)
			}); err != nil {
				t.Fatal(err)
			}
			archiveTerminal(t, f)
			final := m
			final.Type = "finalization"
			final.Payload = v2.Finalization{FinalizationID: uuid.NewString(), ClaimTerminal: true, Runs: []v2.Run{run}}
			got, err := terminalRecordStep(t, f, func() (v2.Message, error) {
				phase := f.TerminalPhase(ctx, true, map[string]int{"InvalidateTerminalOperations": 1, "SaveTerminal": 1})
				defer f.dao.FinishContext(phase)
				return f.s.FinalizeTerminal(phase, f.p, f.project, f.task, m.SessionID, "1", final)
			})
			if err != nil {
				t.Fatal(err)
			}
			fid := got.Payload.(v2.GenerationLedger).FinalizationID
			if cause == "failed_status" {
				status := m
				status.Type = "archive_status"
				code := "source_corrupt"
				status.Payload = v2.ArchiveStatus{State: "failed", ErrorCode: &code, FinalizationID: fid}
				phaseCtx := f.TerminalPhase(ctx, true, map[string]int{"TerminalArchive": 1, "SaveTerminalArchiveStatus": 1})
				_, err = f.s.UpdateTerminalArchive(phaseCtx, f.p, f.project, f.task, m.SessionID, status)
				f.dao.FinishContext(phaseCtx)
				if err != nil {
					t.Fatal(err)
				}
				if f.terminal.ProposedStatus == nil || !reflect.DeepEqual(*f.terminal.ProposedStatus, status.Payload.(v2.ArchiveStatus)) {
					t.Fatal("failed status write changed its selected error")
				}
				f.terminal.Status = status.Payload.(v2.ArchiveStatus)
			}
			r := &terminalRecord{Envelope: m.Envelope}
			reason := "ended_before_first_sample"
			receipt, err := terminalReceipt(r, v2.Receipt{FinalizationID: *fid, Disposition: "unavailable", Reason: &reason, Evidence: &v2.NoRecordingEvidence{RecordingEnabled: true, SelectedFrameCount: "0", RegisteredFrameCount: "0"}})
			if err != nil {
				t.Fatal(err)
			}
			phaseCtx := f.TerminalPhase(ctx, true, map[string]int{"TerminalArchive": 1})
			_, err = f.s.UpdateTerminalArchive(phaseCtx, f.p, f.project, f.task, m.SessionID, receipt)
			f.dao.FinishContext(phaseCtx)
			if err == nil {
				t.Fatal("failed zero source became unavailable")
			}
		})
	}
}
func TestTerminalArchiveValidatesClosedCountsDigestsAndPerRunGaps(t *testing.T) {
	f, m, doc := terminalArchiveFixture(t)
	finalizeFixture(t, f, m, doc)
	r := f.terminal.Record(t)
	base := r.Recording["1"]
	for _, change := range []struct {
		name string
		edit func(*terminalRecording)
	}{
		{"missing closed evidence", func(v *terminalRecording) { v.Evidence = nil }},
		{"selected content omitted", func(v *terminalRecording) { v.Evidence.SelectedFrameCount = "2" }},
		{"registered content omitted", func(v *terminalRecording) { v.Evidence.RegisteredFrameCount = "2" }},
		{"different source digest", func(v *terminalRecording) { v.Evidence.SourceSHA256 = v2.EmptySourceDigest() }},
		{"error with no same-run gap", func(v *terminalRecording) { code := "recording_limit"; v.Evidence.CaptureError = &code }},
		{"disabled recording with frames", func(v *terminalRecording) { v.Responsibility.RecordingEnabled = false }},
	} {
		t.Run(change.name, func(t *testing.T) {
			rec := base
			ev := *base.Evidence
			rp := *base.Responsibility
			rec.Evidence = &ev
			rec.Responsibility = &rp
			change.edit(&rec)
			r.Recording["1"] = rec
			if err := verifyTerminalArchive(r, doc); err == nil {
				t.Fatal("invalid content verified")
			}
		})
	}
	r.Recording["1"] = base
	if err := verifyTerminalArchive(r, doc); err != nil {
		t.Fatal(err)
	}
}
