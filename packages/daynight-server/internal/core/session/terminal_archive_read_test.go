package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	f.s.terminalRun, f.s.taskRun = nil, nil
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
