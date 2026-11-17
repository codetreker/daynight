package session

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
)

func TestTerminalMessagesRejectMalformedAndForeignFences(t *testing.T) {
	f, m, run, rid := terminalRunFixture(t, true)
	ctx := context.Background()
	browser := f.p
	browser.Kind = model.SessionCredential
	if _, err := terminalRegistrationStep(t, f, m.SessionID, func() (v2.Message, error) {
		phase := f.dao.ContextPhase(ctx, nil)
		defer f.dao.FinishContext(phase)
		return f.s.RegisterTerminal(phase, browser, f.project, f.task, m)
	}); err == nil {
		t.Fatal("browser registered Worker session")
	}
	foreign := m
	registration := m.Payload.(v2.Registration)
	registration.Owner.ServerOrigin = "https://other.example"
	foreign.Payload = registration
	if _, err := terminalRegistrationStep(t, f, foreign.SessionID, func() (v2.Message, error) {
		phase := f.dao.ContextPhase(ctx, nil)
		defer f.dao.FinishContext(phase)
		return f.s.RegisterTerminal(phase, f.p, f.project, f.task, foreign)
	}); err == nil {
		t.Fatal("foreign server origin registered")
	}
	foreign.Payload = nil
	if _, err := terminalRegistrationStep(t, f, foreign.SessionID, func() (v2.Message, error) {
		phase := f.dao.ContextPhase(ctx, nil)
		defer f.dao.FinishContext(phase)
		return f.s.RegisterTerminal(phase, f.p, f.project, f.task, foreign)
	}); err == nil {
		t.Fatal("malformed registration accepted")
	}
	if err := terminalErrorStep(t, f, func() error {
		phase := f.dao.ContextPhase(ctx, map[string]int{"LockTask": 1, "LockCredential": 1})
		defer f.dao.FinishContext(phase)
		return f.s.BindTerminalConnection(phase, browser, f.project, f.task, m.SessionID, m.Envelope, "1")
	}); err == nil {
		t.Fatal("browser bound Worker channel")
	}
	fence := m.Envelope
	fence.ExecutionGeneration = "2"
	if err := terminalErrorStep(t, f, func() error {
		phase := f.TerminalPhase(ctx, false, nil)
		defer f.dao.FinishContext(phase)
		return f.s.BindTerminalConnection(phase, f.p, f.project, f.task, m.SessionID, fence, "1")
	}); err == nil {
		t.Fatal("unregistered run bound Worker channel")
	}
	ledger := m
	ledger.Type = "generation_ledger"
	ledger.Payload = v2.GenerationLedger{Runs: []v2.Run{run}}
	final := m
	final.Type = "finalization"
	stopped := stopTerminalRun(t, f, m, run)
	final.Payload = v2.Finalization{FinalizationID: uuid.NewString(), ClaimTerminal: true, Runs: []v2.Run{stopped}}
	recording := zeroEvidence(m, rid)
	for _, tc := range []struct {
		name    string
		message v2.Message
		call    func(context.Context, model.Principal, v2.Message) error
	}{
		{"ledger", ledger, func(phase context.Context, p model.Principal, in v2.Message) error {
			_, err := terminalRecordStep(t, f, func() (v2.Message, error) {
				return f.s.UpdateTerminalLedger(phase, p, f.project, f.task, m.SessionID, "1", in)
			})
			return err
		}},
		{"finalization", final, func(phase context.Context, p model.Principal, in v2.Message) error {
			_, err := terminalRecordStep(t, f, func() (v2.Message, error) {
				return f.s.FinalizeTerminal(phase, p, f.project, f.task, m.SessionID, "1", in)
			})
			return err
		}},
		{"recording", recording, func(phase context.Context, p model.Principal, in v2.Message) error {
			_, err := terminalRecordingStep(t, f, in, func() (v2.Message, error) {
				return f.s.UpdateTerminalRecording(phase, p, f.project, f.task, m.SessionID, "1", in)
			})
			return err
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			browser := f.p
			browser.Kind = model.SessionCredential
			browserPhase := f.dao.ContextPhase(ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1})
			if err := tc.call(browserPhase, browser, tc.message); err == nil {
				t.Fatal("browser accepted as Worker")
			}
			f.dao.FinishContext(browserPhase)
			for _, change := range []struct {
				edit   func(*v2.Message)
				counts map[string]int
			}{
				{func(in *v2.Message) { in.Type = "registration" }, nil},
				{func(in *v2.Message) { in.Payload = nil }, nil},
				{func(in *v2.Message) { in.SchemaVersion = 99 }, nil},
				{func(in *v2.Message) { in.ClaimID = uuid.NewString() }, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1}},
				{func(in *v2.Message) { in.SessionID = uuid.NewString() }, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1}},
			} {
				in := tc.message
				change.edit(&in)
				phase := f.dao.ContextPhase(ctx, change.counts)
				if err := tc.call(phase, f.p, in); err == nil {
					t.Fatal("invalid message accepted", in)
				}
				f.dao.FinishContext(phase)
			}
		})
	}
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, nil)
		defer f.dao.FinishContext(phase)
		return f.s.FinalizeTerminal(phase, f.p, f.project, f.task, m.SessionID, "9", final)
	}); err == nil {
		t.Fatal("stale finalization connection")
	}
	if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, nil)
		defer f.dao.FinishContext(phase)
		return f.s.FinalizeTerminal(phase, f.p, f.project, f.task, m.SessionID, "1", final)
	}); err == nil {
		t.Fatal("active claim finalized")
	}
}

func TestTerminalLedgerPreservesRegisteredRunIdentity(t *testing.T) {
	f, m, run, _ := terminalRunFixture(t, true)
	ctx := context.Background()
	for _, tc := range []struct {
		name string
		edit func(*v2.Run)
	}{
		{"owner", func(r *v2.Run) { r.Owner.WorkerID = uuid.NewString() }},
		{"start identity", func(r *v2.Run) { r.StartedAt = "2026-01-01T00:00:01Z" }},
		{"future start", func(r *v2.Run) { r.StartedAt = terminalTime(time.Now().Add(time.Hour)) }},
		{"terminal binding", func(r *v2.Run) { r.Binding.TerminalID = "replacement" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			next := run
			tc.edit(&next)
			in := m
			in.Type = "generation_ledger"
			in.Payload = v2.GenerationLedger{Runs: []v2.Run{next}}
			if _, err := terminalRecordStep(t, f, func() (v2.Message, error) {
				phase := f.TerminalPhase(ctx, true, nil)
				defer f.dao.FinishContext(phase)
				return f.s.UpdateTerminalLedger(phase, f.p, f.project, f.task, m.SessionID, "1", in)
			}); err == nil {
				t.Fatal("run identity replaced")
			}
		})
	}
	old := run
	old.SegmentIDs = []string{uuid.NewString()}
	next := old
	next.SegmentIDs = []string{}
	if err := validRunProgression(old, next); err == nil {
		t.Fatal("registered segment removed")
	}
	next = old
	next.ExecutionGeneration = "2"
	if err := validRunProgression(old, next); err == nil {
		t.Fatal("generation identity changed")
	}
	stopped := stopTerminalRun(t, f, m, run)
	next = stopped
	next.SegmentIDs = []string{uuid.NewString()}
	if err := validRunProgression(stopped, next); err == nil {
		t.Fatal("stopped run gained a segment")
	}
	if len(f.terminal.Record(t).Runs) != 1 {
		t.Fatal("original ledger changed")
	}

}

func TestTerminalRecordingResponsibilityCannotBeReplacedOrInventContent(t *testing.T) {
	f, m, run, rid := terminalRunFixture(t, false)
	ctx := context.Background()
	responsibility := m
	responsibility.Type = "recording_responsibility"
	responsibility.Payload = v2.RecordingResponsibility{ResponsibilityID: rid, RecordingEnabled: false}
	if _, err := terminalRecordingStep(t, f, responsibility, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, nil)
		defer f.dao.FinishContext(phase)
		return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", responsibility)
	}); err != nil {
		t.Fatal("idempotent responsibility", err)
	}
	changed := responsibility
	changed.Payload = v2.RecordingResponsibility{ResponsibilityID: rid, RecordingEnabled: true}
	if _, err := terminalRecordingStep(t, f, changed, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, nil)
		defer f.dao.FinishContext(phase)
		return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", changed)
	}); err == nil {
		t.Fatal("recording policy changed")
	}
	message := zeroEvidence(m, rid)
	ev := message.Payload.(v2.RecordingEvidence)
	ev.Closed = false
	ev.SelectedFrameCount = "1"
	message.Payload = ev
	if _, err := terminalRecordingStep(t, f, message, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, map[string]int{"TerminalRecordingEvidence": 1})
		defer f.dao.FinishContext(phase)
		return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", message)
	}); err == nil {
		t.Fatal("disabled recorder submitted content")
	}
	message = zeroEvidence(m, uuid.NewString())
	if _, err := terminalRecordingStep(t, f, message, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, nil)
		defer f.dao.FinishContext(phase)
		return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", message)
	}); err == nil {
		t.Fatal("foreign recording responsibility")
	}
	message = zeroEvidence(m, rid)
	message.ExecutionGeneration = "2"
	if _, err := terminalRecordingStep(t, f, message, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, nil)
		defer f.dao.FinishContext(phase)
		return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", message)
	}); err == nil {
		t.Fatal("unregistered generation recording")
	}
	stopTerminalRun(t, f, m, run)
	message = zeroEvidence(m, rid)
	if _, err := terminalRecordingStep(t, f, message, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, map[string]int{"TerminalRecordingEvidence": 1, "InsertRecordingEvidence": 1, "SaveTerminal": 1})
		defer f.dao.FinishContext(phase)
		return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", message)
	}); err != nil {
		t.Fatal(err)
	}
	ev = message.Payload.(v2.RecordingEvidence)
	ev.EvidenceID = uuid.NewString()
	ev.Revision = "2"
	message.Payload = ev
	if _, err := terminalRecordingStep(t, f, message, func() (v2.Message, error) {
		phase := f.TerminalPhase(ctx, true, map[string]int{"TerminalRecordingEvidence": 1})
		defer f.dao.FinishContext(phase)
		return f.s.UpdateTerminalRecording(phase, f.p, f.project, f.task, m.SessionID, "1", message)
	}); err == nil {
		t.Fatal("closed checkpoint was replaced")
	}
}

func TestTerminalArchiveChecksEachRunsCaptureAndZeroContentProof(t *testing.T) {
	raw, err := os.ReadFile("../../../../daynight/test/session/fixtures/v2/valid-partial-archive.json")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := v2.DecodeArchive(raw)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := v2.SourceDigest(doc, "1")
	if err != nil {
		t.Fatal(err)
	}
	code := "recording_limit"
	r := &terminalArchiveRecord{Envelope: v2.Envelope{SessionID: doc.SessionID, ClaimID: doc.ClaimID, ExecutionGeneration: doc.ExecutionGeneration}, Owner: doc.Owner, Runs: doc.Runs, FinalizationID: &doc.FinalizationID, Recording: map[string]terminalRecording{
		"1": {Responsibility: &v2.RecordingResponsibility{RecordingEnabled: true}, Evidence: &v2.RecordingEvidence{Closed: true, SelectedFrameCount: "1", RegisteredFrameCount: "1", SourceSHA256: digest, CaptureError: &code}},
	}}
	if err = verifyTerminalArchiveRecord(r, doc); err != nil {
		t.Fatal("legitimate same-run recording limit", err)
	}
	original := doc.Gaps
	doc.Gaps = []v2.Gap{{Boundary: &v2.BoundaryGap{}}, {Interval: &v2.IntervalGap{Reason: "checkpoint_lost"}}, {Interval: &v2.IntervalGap{Reason: "recording_limit", SegmentID: uuid.NewString()}}}
	if err = verifyTerminalArchiveRecord(r, doc); err == nil {
		t.Fatal("another run's gap concealed capture error")
	}
	doc.Gaps = original
	// The archive parser owns wire validity; this boundary additionally checks
	// the Worker's immutable recording responsibility for each run.
	zero := doc.Runs[0]
	zero.ExecutionGeneration = "2"
	zero.SegmentIDs = []string{}
	doc.Runs = append(doc.Runs, zero)
	r.Runs = doc.Runs
	r.Recording["2"] = terminalRecording{Responsibility: &v2.RecordingResponsibility{RecordingEnabled: false}, Evidence: &v2.RecordingEvidence{Closed: true, SelectedFrameCount: "0", RegisteredFrameCount: "0", SourceSHA256: v2.EmptySourceDigest()}}
	if err = verifyTerminalArchiveRecord(r, doc); err == nil {
		t.Fatal("missing zero-run proof accepted")
	}
	doc.UnavailableRuns = []v2.UnavailableRun{{ExecutionGeneration: "2", Evidence: v2.NoRecordingEvidence{RecordingEnabled: true}}}
	if err = verifyTerminalArchiveRecord(r, doc); err == nil {
		t.Fatal("zero-run recording policy changed")
	}
	doc.UnavailableRuns[0].Evidence.RecordingEnabled = false
	if err = verifyTerminalArchiveRecord(r, doc); err != nil {
		t.Fatal("matching zero-run proof", err)
	}
}
