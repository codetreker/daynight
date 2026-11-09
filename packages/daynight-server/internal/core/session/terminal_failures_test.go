package session

import (
	"context"
	"errors"
	"io"
	"os"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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
	status := m
	status.Type = "archive_status"
	status.Payload = v2.ArchiveStatus{State: "pending"}
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
		{"archive", status, func(phase context.Context, p model.Principal, in v2.Message) error {
			_, err := f.s.UpdateTerminalArchive(phase, p, f.project, f.task, m.SessionID, in)
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
	receiptPhase := f.TerminalPhase(ctx, true, map[string]int{"TerminalArchive": 1})
	if _, err := f.s.TerminalReceipt(receiptPhase, f.p, f.project, f.task, m.SessionID); err == nil {
		t.Fatal("receipt appeared before archive")
	}
	f.dao.FinishContext(receiptPhase)
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
	state, err := terminalStateStep(t, f, func() (map[string]any, error) {
		phase := f.TerminalPhase(ctx, false, map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1})
		defer f.dao.FinishContext(phase)
		return f.s.TerminalState(phase, f.p, f.project, f.task, m.SessionID)
	})
	if err != nil || len(state["ledger"].(v2.GenerationLedger).Runs) != 1 {
		t.Fatal(state, err)
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

type terminalBrokenStorage struct {
	filestorage.Storage
	mode string
}

func (s terminalBrokenStorage) Put(ctx context.Context, bucket, path string, in io.Reader) (filestorage.FileInfo, error) {
	if s.mode == "put error" {
		return filestorage.FileInfo{}, errors.New("disk unavailable")
	}
	info, err := s.Storage.Put(ctx, bucket, path, in)
	if s.mode == "short put" {
		info.Size--
	}
	return info, err
}
func (s terminalBrokenStorage) Open(ctx context.Context, bucket, path string) (filestorage.Object, error) {
	if s.mode == "open error" {
		return filestorage.Object{}, errors.New("object unavailable")
	}
	obj, err := s.Storage.Open(ctx, bucket, path)
	if err != nil {
		return obj, err
	}
	if s.mode == "read error" {
		_ = obj.Body.Close()
		obj.Body = io.NopCloser(terminalBrokenReader{})
	}
	return obj, nil
}

type terminalBrokenReader struct{}

func (terminalBrokenReader) Read([]byte) (int, error) { return 0, errors.New("disk read failure") }

func TestTerminalStorageFailuresNeverPublishReceipts(t *testing.T) {
	f, m, doc := terminalArchiveFixture(t)
	ctx := context.Background()
	finalizeFixture(t, f, m, doc)
	storage := f.s.files
	for _, mode := range []string{"unavailable", "put error", "short put", "open error", "read error"} {
		t.Run(mode, func(t *testing.T) {
			f.s.files = terminalBrokenStorage{Storage: storage, mode: mode}
			if mode == "unavailable" {
				f.s.files = nil
			}
			f.terminal.ProposedReceipt = nil
			f.dao.Expect("SaveTerminalReceipt", 0)
			counts := map[string]int{"ReadCredential": 1, "ArchiveMetadata": 1, "ProjectAccess": 1}
			if mode != "unavailable" {
				counts["ProjectAccess"] = 2
				counts["LockArchiveTask"], counts["LockCredential"], counts["LockTerminal"], counts["TerminalArchive"] = 1, 1, 1, 1
			}
			phase := f.dao.ContextPhase(ctx, counts)
			if _, err := f.s.PutTerminalArchive(phase, f.p, f.project, f.task, m.SessionID, encode(doc)); err == nil {
				t.Fatal("storage failure reported success")
			}
			f.dao.FinishContext(phase)
			if f.terminal.ProposedReceipt != nil {
				t.Fatal("storage failure attempted to publish a receipt")
			}
			receiptPhase := f.TerminalPhase(ctx, true, map[string]int{"TerminalArchive": 1})
			if _, err := f.s.TerminalReceipt(receiptPhase, f.p, f.project, f.task, m.SessionID); err == nil {
				t.Fatal("unverified object has receipt")
			}
			f.dao.FinishContext(receiptPhase)
		})
	}
	f.s.files = storage
	invalidPhase := f.dao.ContextPhase(ctx, map[string]int{"ReadCredential": 1, "ArchiveMetadata": 1, "ProjectAccess": 1})
	if _, err := f.s.PutTerminalArchive(invalidPhase, f.p, f.project, f.task, m.SessionID, []byte("{}")); err == nil {
		t.Fatal("invalid archive accepted")
	}
	f.dao.FinishContext(invalidPhase)
	f.dao.Expect("SaveTerminalReceipt", 1)
	uploadPhase := f.dao.ContextPhase(ctx, map[string]int{"ReadCredential": 1, "ArchiveMetadata": 1, "ProjectAccess": 2, "LockArchiveTask": 1, "LockCredential": 1, "LockTerminal": 1, "TerminalArchive": 1, "SaveTerminalReceipt": 1})
	if _, err := f.s.PutTerminalArchive(uploadPhase, f.p, f.project, f.task, m.SessionID, encode(doc)); err != nil {
		t.Fatal("retry after storage recovery", err)
	}
	f.dao.FinishContext(uploadPhase)
	f.s.files = nil
	readPhase := f.dao.ContextPhase(ctx, map[string]int{"ReadCredential": 1, "ArchiveMetadata": 1, "ProjectAccess": 1})
	if _, err := f.s.TerminalArchiveContent(readPhase, f.p, f.project, f.task, m.SessionID); err == nil {
		t.Fatal("missing storage returned content")
	}
	f.dao.FinishContext(readPhase)
}

func TestTerminalCurrentRejectsCorruptStateAndMissingAuthority(t *testing.T) {
	f, m := terminalFixture(t)
	ctx := context.Background()
	if _, err := terminalStateStep(t, f, func() (map[string]any, error) {
		phase := f.TaskPhase(ctx, map[string]int{"LockCredential": 0, "ProjectAccess": 0})
		defer f.dao.FinishContext(phase)
		return f.s.CurrentTerminal(phase, f.p, f.project, uuid.NewString())
	}); err == nil {
		t.Fatal("unknown task current")
	}
	if _, err := terminalRegistrationStep(t, f, m.SessionID, func() (v2.Message, error) {
		phase := f.TerminalRegistrationPhase(ctx, map[string]int{"InsertTerminal": 1})
		defer f.dao.FinishContext(phase)
		return f.s.RegisterTerminal(phase, f.p, f.project, f.task, m)
	}); err != nil {
		t.Fatal(err)
	}
	f.terminal.Raw = []byte(`[]`)
	if _, err := terminalStateStep(t, f, func() (map[string]any, error) {
		phase := f.TaskPhase(ctx, map[string]int{"CurrentTerminalSession": 1, "LockTerminal": 1})
		defer f.dao.FinishContext(phase)
		return f.s.CurrentTerminal(phase, f.p, f.project, f.task)
	}); err == nil {
		t.Fatal("corrupt terminal state accepted")
	}
	missing := uuid.NewString()
	priorRead := f.dao.LockTerminalFn
	f.dao.LockTerminalFn = func(ctx context.Context, id string) ([]byte, error) {
		if id == missing {
			return nil, model.ErrNotFound
		}
		return priorRead(ctx, id)
	}
	if _, err := terminalStateStep(t, f, func() (map[string]any, error) {
		phase := f.TerminalPhase(ctx, false, nil)
		defer f.dao.FinishContext(phase)
		return f.s.TerminalState(phase, f.p, f.project, f.task, missing)
	}); err == nil {
		t.Fatal("missing session accepted")
	}
	f.data.Task.Worker = nil
	state, err := terminalStateStep(t, f, func() (map[string]any, error) {
		phase := f.TaskPhase(ctx, nil)
		defer f.dao.FinishContext(phase)
		return f.s.CurrentTerminal(phase, f.p, f.project, f.task)
	})
	if err != nil || state["status"] != "not_applicable" {
		t.Fatal(state, err)
	}
	denyFixtureProject(t, f, f.p)
	if _, err := terminalStateStep(t, f, func() (map[string]any, error) {
		phase := f.TaskPhase(ctx, nil)
		defer f.dao.FinishContext(phase)
		return f.s.CurrentTerminal(phase, f.p, f.project, f.task)
	}); err == nil {
		t.Fatal("revoked member current")
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
	r := &terminalRecord{Envelope: v2.Envelope{SessionID: doc.SessionID, ClaimID: doc.ClaimID, ExecutionGeneration: doc.ExecutionGeneration}, Owner: doc.Owner, Runs: doc.Runs, FinalizationID: &doc.FinalizationID, Recording: map[string]terminalRecording{
		"1": {Responsibility: &v2.RecordingResponsibility{RecordingEnabled: true}, Evidence: &v2.RecordingEvidence{Closed: true, SelectedFrameCount: "1", RegisteredFrameCount: "1", SourceSHA256: digest, CaptureError: &code}},
	}}
	if err = verifyTerminalArchive(r, doc); err != nil {
		t.Fatal("legitimate same-run recording limit", err)
	}
	original := doc.Gaps
	doc.Gaps = []v2.Gap{{Boundary: &v2.BoundaryGap{}}, {Interval: &v2.IntervalGap{Reason: "checkpoint_lost"}}, {Interval: &v2.IntervalGap{Reason: "recording_limit", SegmentID: uuid.NewString()}}}
	if err = verifyTerminalArchive(r, doc); err == nil {
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
	if err = verifyTerminalArchive(r, doc); err == nil {
		t.Fatal("missing zero-run proof accepted")
	}
	doc.UnavailableRuns = []v2.UnavailableRun{{ExecutionGeneration: "2", Evidence: v2.NoRecordingEvidence{RecordingEnabled: true}}}
	if err = verifyTerminalArchive(r, doc); err == nil {
		t.Fatal("zero-run recording policy changed")
	}
	doc.UnavailableRuns[0].Evidence.RecordingEnabled = false
	if err = verifyTerminalArchive(r, doc); err != nil {
		t.Fatal("matching zero-run proof", err)
	}
}

func TestTerminalHistoryPreservesWebAndHerdrContentAcrossClaims(t *testing.T) {
	f, terminal := terminalFixture(t)
	ctx := context.Background()
	f.data.Task.Worker.AgentControlMode = model.AgentControlModeWeb
	registrationPhase := f.RegistrationPhase(ctx, map[string]int{"InsertTaskSession": 1})
	web, err := f.s.Register(registrationPhase, f.p, f.project, f.task, f.r)
	if err != nil {
		t.Fatal(err)
	}
	f.dao.FinishContext(registrationPhase)
	f.SelectRegistrationWrite(t)
	terminal.ClaimID = uuid.NewString()
	f.data.Task.Worker.AgentControlMode = model.AgentControlModeHerdr
	f.data.Task.Worker.ClaimID = terminal.ClaimID
	configureTerminalFixture(t, &f, terminal)
	if _, err = terminalRegistrationStep(t, f, terminal.SessionID, func() (v2.Message, error) {
		phase := f.TerminalRegistrationPhase(ctx, map[string]int{"InsertTerminal": 1})
		defer f.dao.FinishContext(phase)
		return f.s.RegisterTerminal(phase, f.p, f.project, f.task, terminal)
	}); err != nil {
		t.Fatal(err)
	}
	rows := []store.TerminalHistoryRow{
		{ID: web.SessionID, Claim: web.ClaimID, Backend: "web", Created: time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC), Snapshot: encode(web)},
		{ID: terminal.SessionID, Claim: terminal.ClaimID, Backend: "herdr", Created: time.Date(2026, 11, 1, 11, 0, 0, 0, time.UTC), Terminal: append([]byte(nil), f.terminal.Raw...)},
	}
	f.dao.TerminalHistoryFn = func(_ context.Context, project, taskID string, before *time.Time, beforeID *string, limit int) ([]store.TerminalHistoryRow, error) {
		if project != f.project || taskID != f.task || before != nil || beforeID != nil || limit != 21 {
			t.Fatal("mixed history changed its DAO query")
		}
		return rows, nil
	}
	f.dao.Expect("TerminalHistory", 2)
	historyPhase := f.TaskPhase(ctx, map[string]int{"TerminalHistory": 1})
	page, err := f.s.TerminalHistory(historyPhase, f.p, f.project, f.task, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	f.dao.FinishContext(historyPhase)
	items := page["items"].([]map[string]any)
	if len(items) != 2 {
		t.Fatalf("mixed Session history lost an earlier backend: %#v", items)
	}
	byID := map[string]map[string]any{}
	for _, item := range items {
		byID[item["sessionId"].(string)] = item
	}
	native := byID[web.SessionID]
	if native["claimId"] != web.ClaimID || native["executionGeneration"] != web.ExecutionGeneration || native["agentControlMode"] != "web" || native["contentKind"] != "native_timeline" || native["archive"].(map[string]any)["state"] != "unavailable" {
		t.Fatalf("web history was relabeled or rebound: %#v", native)
	}
	herdr := byID[terminal.SessionID]
	if herdr["claimId"] != terminal.ClaimID || herdr["executionGeneration"] != "1" || herdr["agentControlMode"] != "herdr" || herdr["contentKind"] != "terminal_recording" || herdr["archive"].(map[string]any)["state"] != "pending" {
		t.Fatalf("terminal history lost its native content type: %#v", herdr)
	}
	rows[0].Snapshot = []byte(`[]`)
	corruptPhase := f.TaskPhase(ctx, map[string]int{"TerminalHistory": 1})
	if _, err = f.s.TerminalHistory(corruptPhase, f.p, f.project, f.task, "", 20); err == nil {
		t.Fatal("corrupt web history was silently omitted from the mixed result")
	}
	f.dao.FinishContext(corruptPhase)
}
