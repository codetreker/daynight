package session

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type terminalEvidenceFixture struct {
	Generation int64
	ID         string
	Revision   int64
	Hash       string
}

type terminalFixtureData struct {
	Raw              []byte
	Registration     store.TerminalRegistration
	FindID           string
	CurrentID        string
	Status           v2.ArchiveStatus
	Receipt          *v2.Receipt
	Path             string
	Evidence         []terminalEvidenceFixture
	History          []store.TerminalHistoryRow
	ProposedRaw      []byte
	ProposedReceipt  *v2.Receipt
	ProposedPath     *string
	ProposedStatus   *v2.ArchiveStatus
	ProposedEvidence []terminalEvidenceFixture
}

func (d *terminalFixtureData) Record(t *testing.T) *terminalRecord {
	t.Helper()
	r := &terminalRecord{}
	if err := json.Unmarshal(d.Raw, r); err != nil {
		t.Fatal(err)
	}
	return r
}

func (d *terminalFixtureData) SetRecord(t *testing.T, r *terminalRecord) {
	t.Helper()
	d.Raw = encode(r)
}

func terminalFixtureID(t *testing.T, got, want string) error {
	t.Helper()
	if got != want {
		err := fmt.Errorf("terminal DAO id = %q, want %q", got, want)
		t.Error(err)
		return err
	}
	return nil
}

func endTerminalTask(t *testing.T, f fixture, state model.WorkerState) {
	t.Helper()
	worker := *f.data.Task.Worker
	worker.State = state
	f.data.Task.Worker = &worker
	if state == model.WorkerCompleted {
		f.data.Task.Status = "done"
	}
}

func (f fixture) TerminalPhase(ctx context.Context, finalize bool, work map[string]int) context.Context {
	counts := map[string]int{"LockCredential": 1, "ProjectAccess": 1, "LockTerminal": 1}
	if finalize {
		counts["LockArchiveTask"] = 1
	} else {
		counts["LockTask"] = 1
	}
	return f.dao.ContextPhase(ctx, mergeFixtureCounts(counts, work))
}

func (f fixture) TerminalRegistrationPhase(ctx context.Context, work map[string]int) context.Context {
	counts := map[string]int{"LockTaskRegistration": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTerminalRegistration": 1}
	return f.dao.ContextPhase(ctx, mergeFixtureCounts(counts, work))
}

func (f fixture) TerminalUploadPhase(ctx context.Context, work map[string]int) context.Context {
	counts := map[string]int{"ReadCredential": 1, "ArchiveMetadata": 1, "ProjectAccess": 2, "LockArchiveTask": 1, "LockCredential": 1, "LockTerminal": 1, "TerminalArchive": 1, "SaveTerminalReceipt": 1}
	return f.dao.ContextPhase(ctx, mergeFixtureCounts(counts, work))
}

func (f fixture) TerminalReadPhase(ctx context.Context, work map[string]int) context.Context {
	counts := map[string]int{"ReadCredential": 1, "ArchiveMetadata": 1, "ProjectAccess": 2, "LockTask": 1, "LockCredential": 1, "LockTerminal": 1, "TerminalArchive": 1}
	return f.dao.ContextPhase(ctx, mergeFixtureCounts(counts, work))
}

func fixtureTerminalUpload(f fixture, ctx context.Context, p model.Principal, project, taskID, id string, data []byte, work map[string]int) (v2.Message, error) {
	phase := f.TerminalUploadPhase(ctx, work)
	defer f.dao.FinishContext(phase)
	return f.s.PutTerminalArchive(phase, p, project, taskID, id, data)
}

func fixtureTerminalContent(f fixture, execution *Execution, ctx context.Context, p model.Principal, project, taskID, id string, work map[string]int) (*RetainedArchive, error) {
	phase := f.TerminalReadPhase(ctx, work)
	defer f.dao.FinishContext(phase)
	return execution.TerminalArchiveContent(phase, p, project, taskID, id)
}

func fixtureTerminalHistory(f fixture, execution *Execution, ctx context.Context, p model.Principal, project, taskID, cursor string, limit int, work map[string]int) (map[string]any, error) {
	phase := f.TaskPhase(ctx, mergeFixtureCounts(map[string]int{"TerminalHistory": 1}, work))
	defer f.dao.FinishContext(phase)
	return execution.TerminalHistory(phase, p, project, taskID, cursor, limit)
}

func fixtureTerminalStatus(f fixture, execution *Execution, ctx context.Context, p model.Principal, project, taskID, id string, work map[string]int) (v2.Message, error) {
	phase := f.TerminalPhase(ctx, true, mergeFixtureCounts(map[string]int{"TerminalArchive": 1}, work))
	defer f.dao.FinishContext(phase)
	return execution.TerminalArchiveStatus(phase, p, project, taskID, id)
}

func fixtureTerminalReceipt(f fixture, execution *Execution, ctx context.Context, p model.Principal, project, taskID, id string, work map[string]int) (v2.Message, error) {
	phase := f.TerminalPhase(ctx, true, mergeFixtureCounts(map[string]int{"TerminalArchive": 1}, work))
	defer f.dao.FinishContext(phase)
	return execution.TerminalReceipt(phase, p, project, taskID, id)
}

func configureTerminalFixture(t *testing.T, f *fixture, m v2.Message) {
	t.Helper()
	d := &terminalFixtureData{CurrentID: m.SessionID, Status: v2.ArchiveStatus{State: "pending"}}
	f.terminal = d
	check := func(id string) error { return terminalFixtureID(t, id, m.SessionID) }
	f.dao.LockTerminalFn = func(_ context.Context, id string) ([]byte, error) {
		if err := check(id); err != nil {
			return nil, err
		}
		return append([]byte(nil), d.Raw...), nil
	}
	f.dao.SaveTerminalFn = func(_ context.Context, id string, raw []byte, lastSeen *time.Time, instance string) error {
		if err := check(id); err != nil {
			return err
		}
		var record terminalRecord
		if err := json.Unmarshal(raw, &record); err != nil {
			return err
		}
		if record.Envelope.SessionID != id || record.ServerInstance != instance || !sameFixtureTime(record.LastSeen, lastSeen) {
			t.Error("terminal write changed its identity or separate metadata")
			return fmt.Errorf("invalid terminal write metadata")
		}
		d.ProposedRaw = append([]byte(nil), raw...)
		return nil
	}
	f.dao.FindTerminalRegistrationFn = func(_ context.Context, id, project, registration, taskID, claim string) (string, error) {
		if id != m.SessionID || project != f.project || taskID != f.task || claim != m.ClaimID || registration != m.Payload.(v2.Registration).RegistrationID {
			t.Error("terminal registration lookup changed its scope")
			return "", fmt.Errorf("invalid terminal registration lookup")
		}
		if d.FindID == "" {
			return "", model.ErrNotFound
		}
		return d.FindID, nil
	}
	f.dao.InsertTerminalFn = func(_ context.Context, in store.TerminalRegistration) error {
		registration := m.Payload.(v2.Registration)
		if in.SessionID != m.SessionID || in.ProjectID != f.project || in.TaskID != f.task || in.ClaimID != m.ClaimID || in.OwnerID != f.p.UserID || in.RegistrationID != registration.RegistrationID || string(in.Registration) != string(encode(registration)) {
			t.Error("terminal insert changed the registration, owner, claim or scope")
			return fmt.Errorf("invalid terminal registration arguments")
		}
		d.Registration = in
		d.ProposedRaw = append([]byte(nil), in.State...)
		return nil
	}
	f.dao.TerminalArchiveFn = func(_ context.Context, id string) (v2.ArchiveStatus, *v2.Receipt, string, error) {
		if err := check(id); err != nil {
			return v2.ArchiveStatus{}, nil, "", err
		}
		return d.Status, d.Receipt, d.Path, nil
	}
	f.dao.ArchiveMetadataFn = func(_ context.Context, id string) (store.ArchiveMetadata, error) {
		if err := check(id); err != nil {
			return store.ArchiveMetadata{}, err
		}
		return store.ArchiveMetadata{Owner: f.p.UserID, Project: f.project, Task: f.task, Backend: "herdr", TaskExists: true, TaskDeleted: f.data.TaskDeleted, ProjectLive: true, BotValid: true}, nil
	}
	f.dao.SaveTerminalReceiptFn = func(_ context.Context, id string, receipt v2.Receipt, path *string) error {
		if err := check(id); err != nil {
			return err
		}
		d.ProposedReceipt = &receipt
		d.ProposedPath = path
		return nil
	}
	f.dao.SaveTerminalArchiveStatusFn = func(_ context.Context, id string, status v2.ArchiveStatus) error {
		if err := check(id); err != nil {
			return err
		}
		d.ProposedStatus = &status
		return nil
	}
	f.dao.CurrentTerminalSessionFn = func(_ context.Context, project, taskID, claim string) (string, error) {
		if project != f.project || taskID != f.task || claim != f.data.Task.Worker.ClaimID {
			t.Error("current terminal lookup changed scope or claim")
			return "", fmt.Errorf("invalid current terminal arguments")
		}
		if d.CurrentID == "" {
			return "", model.ErrNotFound
		}
		return d.CurrentID, nil
	}
	f.dao.TerminalHistoryFn = func(_ context.Context, project, taskID string, before *time.Time, beforeID *string, limit int) ([]store.TerminalHistoryRow, error) {
		if project != f.project || taskID != f.task || before != nil || beforeID != nil || limit < 2 {
			t.Error("terminal history lookup changed its expected scope or initial page")
			return nil, fmt.Errorf("invalid terminal history arguments")
		}
		return d.History, nil
	}
	f.dao.TerminalRecordingEvidenceFn = func(_ context.Context, id string, generation int64, evidence string) (string, string, error) {
		if err := check(id); err != nil {
			return "", "", err
		}
		for _, known := range d.Evidence {
			if known.Generation == generation && known.ID == evidence {
				return known.Hash, decimal(known.Revision), nil
			}
		}
		return "", "", model.ErrNotFound
	}
	f.dao.InsertRecordingEvidenceFn = func(_ context.Context, id string, generation int64, evidence string, revision int64, hash string) error {
		if err := check(id); err != nil {
			return err
		}
		if generation < 1 || evidence == "" || revision < 1 || hash == "" {
			t.Error("recording evidence write lost its identity or revision")
			return fmt.Errorf("invalid recording evidence arguments")
		}
		d.ProposedEvidence = append(d.ProposedEvidence, terminalEvidenceFixture{Generation: generation, ID: evidence, Revision: revision, Hash: hash})
		return nil
	}
	f.dao.InvalidateTerminalOperationsFn = func(_ context.Context, id string) error { return check(id) }
	f.dao.ExpireTerminalOperationsFn = func(_ context.Context, id string, _ time.Time) error { return check(id) }
	f.dao.TerminalInputPendingFn = func(_ context.Context, id string) (bool, error) { return false, check(id) }
}

func terminalNext(t *testing.T, f fixture) {
	t.Helper()
	if f.terminal.ProposedRaw == nil {
		return
	}
	var record terminalRecord
	if err := json.Unmarshal(f.terminal.ProposedRaw, &record); err != nil {
		t.Fatal(err)
	}
	if record.Envelope.SessionID == "" || record.Envelope.ClaimID == "" || record.Owner.OwnerUserID != f.p.UserID {
		t.Fatal("captured terminal write lost its identity")
	}
	f.terminal.Raw = append([]byte(nil), f.terminal.ProposedRaw...)
	f.terminal.ProposedRaw = nil
}

func terminalRecordStep(t *testing.T, f fixture, fn func() (v2.Message, error)) (v2.Message, error) {
	t.Helper()
	f.terminal.ProposedRaw = nil
	message, err := fn()
	if err == nil {
		terminalNext(t, f)
	}
	return message, err
}

func terminalErrorStep(t *testing.T, f fixture, fn func() error) error {
	t.Helper()
	f.terminal.ProposedRaw = nil
	err := fn()
	if err == nil {
		terminalNext(t, f)
	}
	return err
}

func terminalStateStep(t *testing.T, f fixture, fn func() (map[string]any, error)) (map[string]any, error) {
	t.Helper()
	f.terminal.ProposedRaw = nil
	state, err := fn()
	if err == nil {
		terminalNext(t, f)
	}
	return state, err
}

func terminalRegistrationStep(t *testing.T, f fixture, id string, fn func() (v2.Message, error)) (v2.Message, error) {
	t.Helper()
	message, err := terminalRecordStep(t, f, fn)
	if err == nil {
		if message.SessionID != id {
			t.Fatal("registration response changed the selected Session")
		}
		f.terminal.FindID = id
	}
	return message, err
}

func terminalRecordingStep(t *testing.T, f fixture, input v2.Message, fn func() (v2.Message, error)) (v2.Message, error) {
	t.Helper()
	f.terminal.ProposedEvidence = nil
	message, err := terminalRecordStep(t, f, fn)
	if err != nil || input.Type != "recording_evidence" {
		return message, err
	}
	evidence := input.Payload.(v2.RecordingEvidence)
	canonical, err := v2.CanonicalJSON(input)
	if err != nil {
		t.Fatal(err)
	}
	expected := terminalEvidenceFixture{Generation: number(input.ExecutionGeneration), ID: evidence.EvidenceID, Revision: number(evidence.Revision), Hash: v2.HashBytes(canonical)}
	for _, supplied := range f.terminal.Evidence {
		if supplied == expected {
			if len(f.terminal.ProposedEvidence) != 0 {
				t.Fatal("idempotent evidence replay attempted another insertion")
			}
			return message, nil
		}
	}
	if len(f.terminal.ProposedEvidence) != 1 || f.terminal.ProposedEvidence[0] != expected {
		t.Fatal("recording evidence write did not preserve the selected body")
	}
	f.terminal.Evidence = append(f.terminal.Evidence, expected)
	return message, nil
}

func sameFixtureTime(a, b *time.Time) bool {
	return a == nil && b == nil || a != nil && b != nil && a.Equal(*b)
}

func selectUnavailableTerminalReceipt(t *testing.T, f fixture, message v2.Message) {
	t.Helper()
	receipt := message.Payload.(v2.Receipt)
	if receipt.Disposition != "unavailable" || f.terminal.ProposedReceipt == nil || !reflect.DeepEqual(*f.terminal.ProposedReceipt, receipt) || f.terminal.ProposedPath != nil {
		t.Fatal("unavailable receipt write changed its selected disposition or evidence")
	}
	f.terminal.Receipt = &receipt
	f.terminal.Status = v2.ArchiveStatus{State: "unavailable", FinalizationID: &receipt.FinalizationID}
}
