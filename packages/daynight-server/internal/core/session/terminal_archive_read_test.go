package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

// A historical read starts with persisted state and uploaded bytes. No live
// registration, control, finalization or upload operation prepares the data.
func TestTerminalHistoryReadsPersistedArchiveIndependently(t *testing.T) {
	f := setup(t)
	raw, err := os.ReadFile("../../../../daynight/test/session/fixtures/v2/valid-archive.json")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := v2.DecodeArchive(raw)
	if err != nil {
		t.Fatal(err)
	}
	id, claim := uuid.NewString(), uuid.NewString()
	owner := v2.Owner{ProjectID: f.project, TaskID: f.task, WorkerID: f.r.WorkerID, WorktreeID: f.r.WorktreeID, OwnerUserID: f.p.UserID, ServerOrigin: "https://daynight.example", Provider: "codex"}
	doc.SessionID, doc.ClaimID, doc.Owner, doc.FinalizationID = id, claim, owner, uuid.NewString()
	for i := range doc.Runs {
		doc.Runs[i].Owner = owner
	}
	digest, err := v2.SourceDigest(doc, "1")
	if err != nil {
		t.Fatal(err)
	}
	record := terminalArchiveRecord{Envelope: v2.Envelope{Protocol: v2.Protocol, SchemaVersion: 2, ProjectionVersion: 1, SessionID: id, ClaimID: claim, ExecutionGeneration: "1", AgentControlMode: "herdr", ContentKind: "terminal_recording"}, Owner: owner, Runs: doc.Runs, FinalizationID: &doc.FinalizationID,
		Recording: map[string]terminalRecording{"1": {Responsibility: &v2.RecordingResponsibility{RecordingEnabled: true}, Evidence: &v2.RecordingEvidence{Closed: true, SelectedFrameCount: "1", RegisteredFrameCount: "1", SourceSHA256: digest}}}}
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(encode(record), &fields); err != nil {
		t.Fatal(err)
	}
	// These fields belong to live execution and are intentionally not decoded.
	fields["Control"] = json.RawMessage(`false`)
	fields["Registration"] = json.RawMessage(`false`)
	recordBytes := encode(fields)
	data := encode(doc)
	hash, size := v2.HashBytes(data), strconv.Itoa(len(data))
	path, err := archiveObjectPath(f.project, f.p.UserID, id, hash)
	if err != nil {
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
	if _, err := files.Put(t.Context(), archiveBucket, path, bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	archiveStatus := v2.ArchiveStatus{State: "ready", FinalizationID: &doc.FinalizationID, SHA256: &hash, ByteLength: &size, Completeness: &doc.Completeness}
	receipt := v2.Receipt{Disposition: "ready"}
	f.dao.LockTerminalFn = func(_ context.Context, got string) ([]byte, error) {
		if got != id {
			t.Fatal("wrong session")
		}
		return bytes.Clone(recordBytes), nil
	}
	f.dao.TerminalArchiveFn = func(_ context.Context, got string) (v2.ArchiveStatus, *v2.Receipt, string, error) {
		if got != id {
			t.Fatal("wrong archive")
		}
		return archiveStatus, &receipt, path, nil
	}
	f.dao.ArchiveMetadataFn = func(_ context.Context, got string) (store.ArchiveMetadata, error) {
		if got != id {
			t.Fatal("wrong metadata")
		}
		return store.ArchiveMetadata{Owner: f.p.UserID, Project: f.project, Task: f.task, Backend: "herdr", TaskExists: true, TaskDeleted: f.data.TaskDeleted, ProjectLive: true, BotValid: true}, nil
	}
	f.dao.TerminalHistoryFn = func(_ context.Context, project, task string, _ *time.Time, _ *string, _ int) ([]store.TerminalHistoryRow, error) {
		if project != f.project || task != f.task {
			t.Fatal("wrong scope")
		}
		state := "ready"
		return []store.TerminalHistoryRow{{ID: id, Claim: claim, Backend: "herdr", Created: time.Now(), Terminal: recordBytes, State: &state}}, nil
	}
	f.s.taskRun = nil
	content := func(p model.Principal, project string, counts map[string]int) (*RetainedArchive, error) {
		phase := f.dao.ContextPhase(t.Context(), counts)
		defer f.dao.FinishContext(phase)
		return f.s.TerminalArchiveContent(phase, p, project, f.task, id)
	}
	status := func(p model.Principal, counts map[string]int) (v2.Message, error) {
		phase := f.dao.ContextPhase(t.Context(), counts)
		defer f.dao.FinishContext(phase)
		return f.s.TerminalArchiveStatus(phase, p, f.project, f.task, id)
	}
	directory := func(counts map[string]int) (map[string]any, error) {
		phase := f.dao.ContextPhase(t.Context(), counts)
		defer f.dao.FinishContext(phase)
		return f.s.TerminalHistory(phase, f.p, f.project, f.task, "", 10)
	}
	readCounts := map[string]int{"ReadCredential": 1, "ArchiveMetadata": 1, "ProjectAccess": 2, "LockTask": 1, "LockCredential": 1, "LockTerminal": 1, "TerminalArchive": 1}
	statusCounts := map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalArchive": 1}
	page, err := directory(map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "TerminalHistory": 1})
	if err != nil || len(page["items"].([]map[string]any)) != 1 {
		t.Fatalf("history: %#v %v", page, err)
	}
	result, err := status(f.p, statusCounts)
	if err != nil || result.Payload.(v2.ArchiveStatus).State != "ready" {
		t.Fatalf("status: %#v %v", result, err)
	}
	retained, err := content(f.p, f.project, readCounts)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(retained.Data, data) {
		t.Error("archive bytes changed")
	}
	gateKey := "session/archive/owner/" + f.p.UserID
	if permit, err := files.TryAcquireResidency(t.Context(), gateKey); !errors.Is(err, filestorage.ErrGateBusy) {
		if permit != nil {
			_ = permit.Close()
		}
		t.Fatalf("archive did not retain owner gate: %v", err)
	}
	if err = retained.Close(); err != nil {
		t.Fatal(err)
	}
	permit, err := files.TryAcquireResidency(t.Context(), gateKey)
	if err != nil {
		t.Fatalf("archive close did not release owner gate: %v", err)
	}
	if err = permit.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := content(f.p, uuid.NewString(), map[string]int{"ReadCredential": 1, "ProjectAccess": 1}); err == nil {
		t.Fatal("foreign Project read succeeded")
	}
	f.data.TaskDeleted = true
	if _, err := content(f.p, f.project, map[string]int{"ReadCredential": 1, "ProjectAccess": 1, "ArchiveMetadata": 1}); err == nil {
		t.Fatal("deleted Task exposed archive content")
	}
	if _, err := directory(map[string]int{"LockTask": 1}); err == nil {
		t.Fatal("deleted Task exposed directory")
	}
	if _, err := status(f.p, statusCounts); err != nil {
		t.Fatalf("owner lost deleted Task status readback: %v", err)
	}
	other := f.p
	other.UserID = uuid.NewString()
	f.dao.LockCredentialFn = func(_ context.Context, _ model.Principal, _ time.Time) error { return nil }
	f.dao.ProjectAccessFn = func(_ context.Context, user, project string) (model.ProjectAccess, error) {
		return model.ProjectAccess{UserID: user, ProjectID: project}, nil
	}
	if _, err := status(other, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1}); err == nil {
		t.Fatal("non-owner read status of deleted Task")
	}
	f.data.TaskDeleted = false
	if !bytes.Equal(recordBytes, encode(fields)) {
		t.Fatal("history read rewrote persisted record")
	}
	originalRecord := bytes.Clone(recordBytes)
	badOwner := record
	badOwner.Owner.ProjectID = uuid.NewString()
	recordBytes = encode(badOwner)
	if _, err := content(f.p, f.project, map[string]int{"ReadCredential": 1, "ArchiveMetadata": 1, "ProjectAccess": 2, "LockTask": 1, "LockCredential": 1, "LockTerminal": 1}); err == nil {
		t.Fatal("archive accepted a foreign persisted owner")
	}
	badRuns := record
	badRuns.Runs = append([]v2.Run(nil), record.Runs...)
	badRuns.Runs[0].StartedAt = "2000-01-01T00:00:00Z"
	recordBytes = encode(badRuns)
	if _, err := content(f.p, f.project, readCounts); err == nil {
		t.Fatal("archive accepted a changed persisted run")
	}
	badEvidence := record
	evidence := *record.Recording["1"].Evidence
	evidence.SourceSHA256 = v2.HashBytes([]byte("different recording"))
	badEvidence.Recording = map[string]terminalRecording{"1": {Responsibility: record.Recording["1"].Responsibility, Evidence: &evidence}}
	recordBytes = encode(badEvidence)
	if _, err := content(f.p, f.project, readCounts); err == nil {
		t.Fatal("archive accepted changed recording evidence")
	}
	recordBytes = originalRecord
	wrongCompleteness := "partial"
	if doc.Completeness == wrongCompleteness {
		wrongCompleteness = "complete"
	}
	archiveStatus.Completeness = &wrongCompleteness
	if _, err := content(f.p, f.project, readCounts); err == nil {
		t.Fatal("archive accepted changed completeness")
	}
	archiveStatus.Completeness = &doc.Completeness
	hash = v2.HashBytes([]byte("corrupt"))
	if _, err := content(f.p, f.project, readCounts); err == nil {
		t.Fatal("incorrect archive digest accepted")
	}
}

func TestTerminalHistoryRejectsInvalidRecordAndMissingScope(t *testing.T) {
	for _, input := range []string{`{`, `{"Envelope":false}`, `{"Runs":"invalid"}`} {
		if _, err := decodeTerminalArchiveRecord([]byte(input)); err == nil {
			t.Fatalf("accepted invalid persisted record %q", input)
		}
	}
	s := &Execution{Engine: NewEngine(nil)}
	if _, err := s.TerminalArchiveStatus(t.Context(), model.Principal{}, "project", "task", "session"); err == nil || err.Error() != "terminal history scope unavailable" {
		t.Fatalf("missing history scope: %v", err)
	}
}

type historicalArchiveState struct {
	Raw     []byte
	Status  v2.ArchiveStatus
	Receipt *v2.Receipt
	Path    string
}

type historicalArchiveFixtureData struct {
	fixture
	archive *historicalArchiveState
}

func (f historicalArchiveFixtureData) readContent(ctx context.Context, id string) (*RetainedArchive, error) {
	phase := f.dao.ContextPhase(ctx, map[string]int{"ReadCredential": 1, "ArchiveMetadata": 1, "ProjectAccess": 2, "LockTask": 1, "LockCredential": 1, "LockTerminal": 1, "TerminalArchive": 1})
	defer f.dao.FinishContext(phase)
	return f.s.TerminalArchiveContent(phase, f.p, f.project, f.task, id)
}

func (f historicalArchiveFixtureData) readStatus(ctx context.Context, id string) (v2.Message, error) {
	phase := f.dao.ContextPhase(ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalArchive": 1})
	defer f.dao.FinishContext(phase)
	return f.s.TerminalArchiveStatus(phase, f.p, f.project, f.task, id)
}

// historicalArchiveFixture represents an already persisted archive without a live writer.
func historicalArchiveFixture(t *testing.T) (historicalArchiveFixtureData, v2.Message, v2.Archive) {
	t.Helper()
	f := historicalArchiveFixtureData{fixture: setup(t), archive: &historicalArchiveState{}}
	owner := v2.Owner{ProjectID: f.project, TaskID: f.task, WorkerID: f.r.WorkerID, WorktreeID: f.r.WorktreeID, OwnerUserID: f.p.UserID, ServerOrigin: "https://daynight.example", Provider: "codex"}
	message := v2.Message{Envelope: v2.Envelope{Protocol: v2.Protocol, SchemaVersion: 2, ProjectionVersion: 1, SessionID: uuid.NewString(), ClaimID: uuid.NewString(), ExecutionGeneration: "1", AgentControlMode: "herdr", ContentKind: "terminal_recording"}}
	f.dao.LockTerminalFn = func(_ context.Context, id string) ([]byte, error) {
		if id != message.SessionID {
			t.Fatal("wrong Session")
		}
		return bytes.Clone(f.archive.Raw), nil
	}
	f.dao.TerminalArchiveFn = func(_ context.Context, id string) (v2.ArchiveStatus, *v2.Receipt, string, error) {
		if id != message.SessionID {
			t.Fatal("wrong archive")
		}
		return f.archive.Status, f.archive.Receipt, f.archive.Path, nil
	}
	f.dao.ArchiveMetadataFn = func(_ context.Context, id string) (store.ArchiveMetadata, error) {
		if id != message.SessionID {
			t.Fatal("wrong metadata")
		}
		return store.ArchiveMetadata{Owner: f.p.UserID, Project: f.project, Task: f.task, Backend: "herdr", TaskExists: true, ProjectLive: true, BotValid: true}, nil
	}
	raw, err := os.ReadFile("../../../../daynight/test/session/fixtures/v2/valid-archive.json")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := v2.DecodeArchive(raw)
	if err != nil {
		t.Fatal(err)
	}
	doc.SessionID, doc.ClaimID, doc.Owner, doc.FinalizationID = message.SessionID, message.ClaimID, owner, uuid.NewString()
	for i := range doc.Runs {
		doc.Runs[i].Owner = owner
	}
	digest, err := v2.SourceDigest(doc, "1")
	if err != nil {
		t.Fatal(err)
	}
	record := terminalArchiveRecord{Envelope: message.Envelope, Owner: owner, Runs: doc.Runs, FinalizationID: &doc.FinalizationID,
		Recording: map[string]terminalRecording{"1": {Responsibility: &v2.RecordingResponsibility{RecordingEnabled: true}, Evidence: &v2.RecordingEvidence{Closed: true, SelectedFrameCount: "1", RegisteredFrameCount: "1", SourceSHA256: digest}}}}
	f.archive.Raw = encode(record)
	data := encode(doc)
	hash, size := v2.HashBytes(data), strconv.Itoa(len(data))
	path, err := archiveObjectPath(f.project, f.p.UserID, message.SessionID, hash)
	if err != nil {
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
	if _, err := files.Put(t.Context(), archiveBucket, path, bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	f.s.files = files
	f.archive.Path = path
	f.archive.Receipt = &v2.Receipt{Disposition: "ready"}
	f.archive.Status = v2.ArchiveStatus{State: "ready", FinalizationID: &doc.FinalizationID, SHA256: &hash, ByteLength: &size, Completeness: &doc.Completeness}
	return f, message, doc
}

func TestTerminalArchiveReadValidatesClosedCountsDigestsAndPerRunGaps(t *testing.T) {
	f, _, doc := historicalArchiveFixture(t)
	r, err := decodeTerminalArchiveRecord(f.archive.Raw)
	if err != nil {
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
			rec, ev, rp := base, *base.Evidence, *base.Responsibility
			rec.Evidence, rec.Responsibility = &ev, &rp
			change.edit(&rec)
			r.Recording["1"] = rec
			if err := verifyTerminalArchiveRecord(r, doc); err == nil {
				t.Fatal("invalid content verified")
			}
		})
	}
	r.Recording["1"] = base
	if err := verifyTerminalArchiveRecord(r, doc); err != nil {
		t.Fatal(err)
	}
}

func TestTerminalHistoryNonReadyStatusHasNoContent(t *testing.T) {
	for _, state := range []string{"pending", "unavailable"} {
		t.Run(state, func(t *testing.T) {
			f, message, doc := historicalArchiveFixture(t)
			f.archive.Status = v2.ArchiveStatus{State: state, FinalizationID: &doc.FinalizationID}
			if state == "pending" {
				f.archive.Receipt = nil
			} else {
				f.archive.Receipt = &v2.Receipt{Disposition: state}
			}
			status, err := f.readStatus(t.Context(), message.SessionID)
			if err != nil || status.Payload.(v2.ArchiveStatus).State != state {
				t.Fatalf("status=%+v err=%v", status, err)
			}
			content, err := f.readContent(t.Context(), message.SessionID)
			var fault *model.Fault
			if content != nil || !errors.As(err, &fault) || fault.Code != "archive_pending" {
				t.Fatalf("content=%v err=%v", content, err)
			}
		})
	}
}

func withinHistoryPhase[T any](f fixture, ctx context.Context, calls map[string]int, run func(context.Context) (T, error)) (T, error) {
	phase := f.dao.ContextPhase(ctx, calls)
	defer f.dao.FinishContext(phase)
	return run(phase)
}

func TestTerminalHistoryPaginationFindsOldClaimsAndHonorsDeletion(t *testing.T) {
	f, m, _ := historicalArchiveFixture(t)
	ctx := context.Background()
	var err error
	ids := []string{uuid.NewString(), uuid.NewString(), m.SessionID}
	oldRecord, err := decodeTerminalArchiveRecord(f.archive.Raw)
	if err != nil {
		t.Fatal(err)
	}
	oldRecord.Envelope.SessionID = ids[0]
	oldRecord.Envelope.ClaimID = uuid.NewString()
	oldRaw := encode(oldRecord)
	middleRecord := *oldRecord
	middleRecord.Envelope.SessionID = ids[1]
	middleRecord.Envelope.ClaimID = uuid.NewString()
	middleRaw := encode(middleRecord)
	priorRead := f.dao.LockTerminalFn
	f.dao.LockTerminalFn = func(ctx context.Context, id string) ([]byte, error) {
		if id == ids[0] {
			return oldRaw, nil
		}
		return priorRead(ctx, id)
	}
	created := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	rows := []store.TerminalHistoryRow{
		{ID: ids[2], Claim: m.ClaimID, Backend: "herdr", Created: created, Terminal: append([]byte(nil), f.archive.Raw...)},
		{ID: ids[1], Claim: middleRecord.Envelope.ClaimID, Backend: "herdr", Created: created.Add(-time.Second), Terminal: middleRaw},
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
	page, err := withinHistoryPhase(f.fixture, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "TerminalHistory": 1}, func(phase context.Context) (map[string]any, error) {
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
	next, err := withinHistoryPhase(f.fixture, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "TerminalHistory": 1}, func(phase context.Context) (map[string]any, error) {
		return f.s.TerminalHistory(phase, f.p, f.project, f.task, *token, 2)
	})
	if err != nil || len(next["items"].([]map[string]any)) != 1 || next["nextCursor"].(*string) != nil || next["items"].([]map[string]any)[0]["sessionId"] != ids[0] {
		t.Fatal(next, err)
	}
	if _, err = withinHistoryPhase(f.fixture, ctx, map[string]int{}, func(phase context.Context) (map[string]any, error) {
		return f.s.TerminalHistory(phase, f.p, f.project, uuid.NewString(), *token, 2)
	}); err == nil {
		t.Fatal("foreign task cursor")
	}
	if _, err = withinHistoryPhase(f.fixture, ctx, map[string]int{}, func(phase context.Context) (map[string]any, error) {
		return f.s.TerminalHistory(phase, f.p, f.project, f.task, "not base64", 2)
	}); err == nil {
		t.Fatal("malformed cursor")
	}
	if _, err = withinHistoryPhase(f.fixture, ctx, map[string]int{}, func(phase context.Context) (map[string]any, error) {
		return f.s.TerminalHistory(phase, f.p, f.project, f.task, "", 201)
	}); err == nil {
		t.Fatal("unbounded history")
	}
	f.data.Task.Status = "done"
	f.data.TaskDeleted = true
	if _, err = withinHistoryPhase(f.fixture, ctx, map[string]int{"LockTask": 1}, func(phase context.Context) (map[string]any, error) {
		return f.s.TerminalHistory(phase, f.p, f.project, f.task, "", 2)
	}); err == nil {
		t.Fatal("deleted history visible")
	}
	if _, err = withinHistoryPhase(f.fixture, ctx, map[string]int{"LockArchiveTask": 1, "LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1, "TerminalArchive": 1}, func(phase context.Context) (v2.Message, error) {
		return f.s.TerminalArchiveStatus(phase, f.p, f.project, f.task, ids[0])
	}); err != nil {
		t.Fatal("original owner cannot read deleted task archive status", err)
	}
}

func TestTerminalHistoryPreservesWebAndHerdrContentAcrossClaims(t *testing.T) {
	f, terminal, _ := historicalArchiveFixture(t)
	ctx := context.Background()
	webID, webClaim := uuid.NewString(), uuid.NewString()
	webGeneration := "1"
	rows := []store.TerminalHistoryRow{
		{ID: terminal.SessionID, Claim: terminal.ClaimID, Backend: "herdr", Created: time.Date(2026, 11, 1, 11, 0, 0, 0, time.UTC), Terminal: append([]byte(nil), f.archive.Raw...)},
		{ID: webID, Claim: webClaim, Backend: "web", Created: time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC), Snapshot: []byte(`{"executionGeneration":"1"}`)},
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
	native := byID[webID]
	if native["claimId"] != webClaim || native["executionGeneration"] != webGeneration || native["agentControlMode"] != "web" || native["contentKind"] != "native_timeline" || native["archive"].(map[string]any)["state"] != "unavailable" {
		t.Fatalf("web history was relabeled or rebound: %#v", native)
	}
	herdr := byID[terminal.SessionID]
	if herdr["claimId"] != terminal.ClaimID || herdr["executionGeneration"] != "1" || herdr["agentControlMode"] != "herdr" || herdr["contentKind"] != "terminal_recording" || herdr["archive"].(map[string]any)["state"] != "pending" {
		t.Fatalf("terminal history lost its native content type: %#v", herdr)
	}
	rows[1].Snapshot = []byte(`[]`)
	corruptPhase := f.TaskPhase(ctx, map[string]int{"TerminalHistory": 1})
	if _, err = f.s.TerminalHistory(corruptPhase, f.p, f.project, f.task, "", 20); err == nil {
		t.Fatal("corrupt web history was silently omitted from the mixed result")
	}
	f.dao.FinishContext(corruptPhase)
}

type failedHistoryObject struct {
	filestorage.Storage
	failure  error
	failOpen bool
	closed   *bool
}

func (s failedHistoryObject) Open(ctx context.Context, bucket, path string) (filestorage.Object, error) {
	if s.failOpen {
		return filestorage.Object{}, s.failure
	}
	obj, err := s.Storage.Open(ctx, bucket, path)
	if err != nil {
		return obj, err
	}
	obj.Body = &failedHistoryBody{ReadCloser: obj.Body, failure: s.failure, closed: s.closed}
	return obj, nil
}

type failedHistoryBody struct {
	io.ReadCloser
	failure error
	closed  *bool
}

func (r *failedHistoryBody) Read([]byte) (int, error) { return 0, r.failure }
func (r *failedHistoryBody) Close() error             { *r.closed = true; return r.ReadCloser.Close() }

func TestTerminalHistoryMissingStatusAndStorageFailures(t *testing.T) {
	t.Run("missing archive status", func(t *testing.T) {
		f, message, doc := historicalArchiveFixture(t)
		f.dao.TerminalArchiveFn = func(_ context.Context, id string) (v2.ArchiveStatus, *v2.Receipt, string, error) {
			if id != message.SessionID {
				t.Fatal("wrong archive")
			}
			return v2.ArchiveStatus{}, nil, "", model.ErrNotFound
		}
		status, err := f.readStatus(t.Context(), message.SessionID)
		if err != nil {
			t.Fatal(err)
		}
		payload := status.Payload.(v2.ArchiveStatus)
		if payload.State != "pending" || payload.FinalizationID == nil || *payload.FinalizationID != doc.FinalizationID {
			t.Fatalf("missing archive status: %+v", payload)
		}
	})
	for _, failOpen := range []bool{true, false} {
		t.Run(map[bool]string{true: "open", false: "read"}[failOpen], func(t *testing.T) {
			f, message, _ := historicalArchiveFixture(t)
			failure := errors.New("historical storage failure")
			closed := false
			f.s.files = failedHistoryObject{Storage: f.s.files, failure: failure, failOpen: failOpen, closed: &closed}
			content, err := f.readContent(t.Context(), message.SessionID)
			if content != nil || !errors.Is(err, failure) {
				t.Fatalf("content=%v err=%v", content, err)
			}
			if !failOpen && !closed {
				t.Fatal("failed object read did not close the body")
			}
		})
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
