package session

import (
	"bytes"
	"context"
	"os"
	"reflect"
	"sync"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
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
	doc.SessionID = m.SessionID
	doc.ClaimID = m.ClaimID
	doc.Owner = reg.Owner
	doc.FinalizationID = uuid.NewString()
	for i := range doc.Runs {
		doc.Runs[i].Owner = reg.Owner
	}
	ctx := context.Background()
	if _, err = f.s.RegisterTerminal(ctx, f.p, f.project, f.task, m); err != nil {
		t.Fatal(err)
	}
	active := doc.Runs[0]
	active.StopProof = nil
	active.StoppedAt = nil
	ledger := m
	ledger.Type = "generation_ledger"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{active}}
	if _, err = f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", ledger); err != nil {
		t.Fatal(err)
	}
	responsibility := m
	responsibility.Type = "recording_responsibility"
	responsibility.Payload = v2.RecordingResponsibility{ResponsibilityID: uuid.NewString(), RecordingEnabled: true}
	if _, err = f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", responsibility); err != nil {
		t.Fatal(err)
	}
	ledger.Payload = v2.GenerationLedger{Runs: doc.Runs}
	if _, err = f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", ledger); err != nil {
		t.Fatal(err)
	}
	digest, err := v2.SourceDigest(doc, "1")
	if err != nil {
		t.Fatal(err)
	}
	evidence := m
	evidence.Type = "recording_evidence"
	evidence.Payload = v2.RecordingEvidence{ResponsibilityID: responsibility.Payload.(v2.RecordingResponsibility).ResponsibilityID, EvidenceID: uuid.NewString(), Revision: "1", SelectedFrameCount: "1", RegisteredFrameCount: "1", Closed: true, JournalSHA256: v2.HashBytes([]byte("durable journal")), SourceSHA256: digest}
	if _, err = f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", evidence); err != nil {
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
	return f, m, doc
}
func finalizeFixture(t *testing.T, f fixture, m v2.Message, doc v2.Archive) v2.Message {
	t.Helper()
	archiveTerminal(t, f)
	final := m
	final.Type = "finalization"
	final.Payload = v2.Finalization{FinalizationID: doc.FinalizationID, ClaimTerminal: true, Runs: doc.Runs}
	if _, err := f.s.FinalizeTerminal(context.Background(), f.p, f.project, f.task, m.SessionID, "1", final); err != nil {
		t.Fatal(err)
	}
	return final
}
func TestTerminalArchiveReadyReadsActualBytesAndSurvivesNewClaim(t *testing.T) {
	f, m, doc := terminalArchiveFixture(t)
	ctx := context.Background()
	data := encode(doc)
	if _, err := f.s.PutTerminalArchive(ctx, f.p, f.project, f.task, m.SessionID, data); err == nil {
		t.Fatal("unfrozen archive accepted")
	}
	final := finalizeFixture(t, f, m, doc)
	receipt, err := f.s.PutTerminalArchive(ctx, f.p, f.project, f.task, m.SessionID, data)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Payload.(v2.Receipt).Disposition != "ready" {
		t.Fatal(receipt)
	}
	if _, err = v2.DecodeMessage(encode(receipt)); err != nil {
		t.Fatal("invalid generated receipt", err)
	}
	if retry, err := f.s.PutTerminalArchive(ctx, f.p, f.project, f.task, m.SessionID, data); err != nil || !reflect.DeepEqual(receipt, retry) {
		t.Fatal(retry, err)
	}
	if _, err = f.s.PutTerminalArchive(ctx, f.p, f.project, f.task, m.SessionID, append(data, ' ')); err == nil {
		t.Fatal("immutable bytes replaced")
	}
	if _, err = f.s.FinalizeTerminal(ctx, f.p, f.project, f.task, m.SessionID, "1", final); err != nil {
		t.Fatal("finalization retry", err)
	}
	final.Payload = v2.Finalization{FinalizationID: uuid.NewString(), ClaimTerminal: true, Runs: doc.Runs}
	if _, err = f.s.FinalizeTerminal(ctx, f.p, f.project, f.task, m.SessionID, "1", final); err == nil {
		t.Fatal("second seal allowed")
	}
	if _, err = f.db.Pool.Exec(ctx, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{claimId}',to_jsonb($2::text))::text WHERE task_id=$1 AND name='worker'`, f.task, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	restarted := New(f.db, f.s.files)
	restarted.Origin = f.s.Origin
	got, err := restarted.TerminalArchiveContent(ctx, f.p, f.project, f.task, m.SessionID)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("history content", err)
	}
	page, err := restarted.TerminalHistory(ctx, f.p, f.project, f.task, "", 1)
	if err != nil || len(page["items"].([]map[string]any)) != 1 {
		t.Fatal(page, err)
	}
	status, err := restarted.TerminalArchiveStatus(ctx, f.p, f.project, f.task, m.SessionID)
	if err != nil || status.Payload.(v2.ArchiveStatus).State != "ready" {
		t.Fatal(status, err)
	}
	stored, err := restarted.TerminalReceipt(ctx, f.p, f.project, f.task, m.SessionID)
	if err != nil || !reflect.DeepEqual(stored, receipt) {
		t.Fatal(stored, err)
	}
	if _, err = restarted.TerminalArchiveContent(ctx, f.p, uuid.NewString(), f.task, m.SessionID); err == nil {
		t.Fatal("cross-project read")
	}
	path := "projects/" + f.project + "/" + m.SessionID[:2] + "/" + m.SessionID + "/" + v2.HashBytes(data) + ".json"
	if _, err = f.s.files.Put(ctx, archiveBucket, path, bytes.NewBufferString("corrupt")); err != nil {
		t.Fatal(err)
	}
	if _, err = restarted.TerminalArchiveContent(ctx, f.p, f.project, f.task, m.SessionID); err == nil {
		t.Fatal("corrupt stored object read")
	}
}
func TestTerminalFinalizationAndGenerationGrantCannotBothSucceed(t *testing.T) {
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
	results := make(chan error, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, err := f.s.FinalizeTerminal(ctx, f.p, f.project, f.task, m.SessionID, "1", final)
		results <- err
	}()
	go func() {
		defer wg.Done()
		_, err := f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", ledger)
		results <- err
	}()
	wg.Wait()
	close(results)
	successes := 0
	for err := range results {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("successes=%d", successes)
	}
	got, err := f.s.TerminalState(ctx, f.p, f.project, f.task, m.SessionID)
	if err != nil || got["executionGeneration"] != "1" {
		t.Fatal(got, err)
	}
}
func TestTerminalArchiveRejectsEvidenceMismatchAndRevokedAuthority(t *testing.T) {
	f, m, doc := terminalArchiveFixture(t)
	ctx := context.Background()
	finalizeFixture(t, f, m, doc)
	altered := doc
	altered.Owner.WorkerID = uuid.NewString()
	if _, err := f.s.PutTerminalArchive(ctx, f.p, f.project, f.task, m.SessionID, encode(altered)); err == nil {
		t.Fatal("foreign archive accepted")
	}
	other := f.p
	other.Kind = model.SessionCredential
	if _, err := f.s.PutTerminalArchive(ctx, other, f.project, f.task, m.SessionID, encode(doc)); err == nil {
		t.Fatal("browser finalized archive")
	}
	if _, err := f.db.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, f.project, f.p.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.PutTerminalArchive(ctx, f.p, f.project, f.task, m.SessionID, encode(doc)); err == nil {
		t.Fatal("revoked owner uploaded")
	}
	if _, err := f.s.TerminalHistory(ctx, f.p, f.project, f.task, "", 20); err == nil {
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
			if _, err := f.s.UpdateTerminalRecording(ctx, f.p, f.project, f.task, m.SessionID, "1", evidence); err != nil {
				t.Fatal(err)
			}
			archiveTerminal(t, f)
			final := m
			final.Type = "finalization"
			final.Payload = v2.Finalization{FinalizationID: uuid.NewString(), ClaimTerminal: true, Runs: []v2.Run{run}}
			got, err := f.s.FinalizeTerminal(ctx, f.p, f.project, f.task, m.SessionID, "1", final)
			if err != nil {
				t.Fatal(err)
			}
			fid := got.Payload.(v2.GenerationLedger).FinalizationID
			if cause == "failed_status" {
				status := m
				status.Type = "archive_status"
				code := "source_corrupt"
				status.Payload = v2.ArchiveStatus{State: "failed", ErrorCode: &code, FinalizationID: fid}
				if _, err = f.s.UpdateTerminalArchive(ctx, f.p, f.project, f.task, m.SessionID, status); err != nil {
					t.Fatal(err)
				}
			}
			r := &terminalRecord{Envelope: m.Envelope}
			reason := "ended_before_first_sample"
			receipt, err := terminalReceipt(r, v2.Receipt{FinalizationID: *fid, Disposition: "unavailable", Reason: &reason, Evidence: &v2.NoRecordingEvidence{RecordingEnabled: true, SelectedFrameCount: "0", RegisteredFrameCount: "0"}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = f.s.UpdateTerminalArchive(ctx, f.p, f.project, f.task, m.SessionID, receipt); err == nil {
				t.Fatal("failed zero source became unavailable")
			}
		})
	}
}
func TestTerminalArchiveValidatesClosedCountsDigestsAndPerRunGaps(t *testing.T) {
	f, m, doc := terminalArchiveFixture(t)
	ctx := context.Background()
	finalizeFixture(t, f, m, doc)
	var r *terminalRecord
	if err := testTransact(f.s, f.db, ctx, func(tx *operationTx) error { var err error; r, err = loadTerminal(ctx, tx, m.SessionID); return err }); err != nil {
		t.Fatal(err)
	}
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
