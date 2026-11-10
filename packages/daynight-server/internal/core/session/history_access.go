package session

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type TaskCurrentIdentity struct {
	Status                               string
	ClaimID, AgentControlMode, SessionID *string
}
type LiveHistoryRequest struct {
	Epoch, Before                               string
	Limit, ResponseOverhead, ContentReadVersion int
}

// HistoryArchive retains the archive envelope and, for schema3, its independent
// timeline under one permit until the transport closes the result.
type HistoryArchive interface {
	Bytes() []byte
	TimelineBytes() []byte
	io.Closer
}

func (r *RetainedArchive) Bytes() []byte         { return r.Data }
func (r *RetainedArchive) TimelineBytes() []byte { return nil }

type historyTimelineArchive struct {
	*RetainedArchive
	manifest []byte
}

func (r *historyTimelineArchive) Bytes() []byte         { return r.manifest }
func (r *historyTimelineArchive) TimelineBytes() []byte { return r.Data }
func (s *Execution) SetTaskReadRunners(content BrowserRunner, task TaskRunner, archive ArchiveRunner) {
	s.taskContentReadRun, s.taskReadRun, s.taskArchiveReadRun = content, task, archive
}
func (s *Execution) taskReader() (*Execution, error) {
	if s.taskContentReadRun == nil || s.taskReadRun == nil || s.taskArchiveReadRun == nil {
		return nil, errors.New("Task history scopes are unavailable")
	}
	copy := *s
	copy.browserRun, copy.taskRun, copy.archiveRun = s.taskContentReadRun, s.taskReadRun, s.taskArchiveReadRun
	return &copy, nil
}

// LockTaskReadCredential is limited to Task observation/content scopes. All
// Controller, independent Session and upload operations keep their own admission.
func (op *Operation) LockTaskReadCredential(ctx context.Context, scope store.SessionScope, p model.Principal) error {
	if err := model.RequirePrincipal(p); err != nil {
		return err
	}
	if p.Kind != model.PATCredential && p.Kind != model.SessionCredential && p.Kind != model.OAuthCredential {
		return denied()
	}
	if err := scope.SessionDAO().LockCredential(ctx, p, op.engine.now()); err != nil {
		if errors.Is(err, model.ErrNotFound) {
			return fault("unauthenticated", "Credential expired or was revoked.")
		}
		return err
	}
	return nil
}
func (op *Operation) BindTaskRead(a *Access, t *TaskAccess, project, taskID string) error {
	r := a.record
	if r.Snapshot.TestExecutionID != "" || r.Snapshot.Identity.ProjectID != project || r.Snapshot.Identity.TaskID != taskID || !current(t.task, r) {
		return conflict()
	}
	a.task, a.write = t.task, false
	return nil
}
func (s *Execution) TaskCurrentIdentity(ctx context.Context, p model.Principal, project, taskID string) (TaskCurrentIdentity, error) {
	out := TaskCurrentIdentity{Status: "not_applicable"}
	reader, err := s.taskReader()
	if err != nil {
		return out, err
	}
	err = reader.taskRun(ctx, p, project, taskID, func(op *Operation, scope store.SessionScope, t *TaskAccess, _ func(string) (*Access, error)) error {
		w := t.task.Worker
		if w == nil {
			return nil
		}
		out.ClaimID = observationPointer(w.ClaimID)
		out.AgentControlMode = observationPointer(string(w.AgentControlMode))
		var id string
		var e error
		if w.AgentControlMode == model.AgentControlModeHerdr {
			id, e = scope.SessionDAO().CurrentTerminalSession(ctx, project, taskID, w.ClaimID)
		} else {
			id, e = scope.SessionDAO().CurrentTaskSession(ctx, project, taskID, w.ClaimID)
		}
		if errors.Is(e, model.ErrNotFound) {
			out.Status = "not_registered"
			return nil
		}
		if e != nil {
			return e
		}
		out.Status = "registered"
		out.SessionID = &id
		return nil
	})
	return out, err
}
func (s *Execution) TaskDirectory(ctx context.Context, p model.Principal, project, taskID, token string, limit int) (sp.TaskSessionList, error) {
	out := sp.TaskSessionList{Items: []sp.TaskSessionDirectoryItem{}}
	reader, err := s.taskReader()
	if err != nil {
		return out, err
	}
	raw, err := reader.terminalHistory(ctx, p, project, taskID, token, limit, true)
	if err != nil {
		return out, err
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return out, err
	}
	if err = json.Unmarshal(data, &out); err != nil {
		return out, err
	}
	return out, nil
}
func (s *Execution) TaskArchiveContent(ctx context.Context, p model.Principal, project, taskID, id string) (HistoryArchive, error) {
	reader, err := s.taskReader()
	if err != nil {
		return nil, err
	}
	archive, err := reader.ArchiveContent(ctx, p, project, taskID, id)
	if err != nil {
		return nil, err
	}
	var header struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if err = json.Unmarshal(archive.Data, &header); err != nil || header.SchemaVersion != 3 {
		return archive, nil
	}
	manifest, err := sp.DecodeArchiveManifest(archive.Data)
	if err != nil || manifest.RecordID != id {
		return nil, errors.Join(fault("source_corrupt", "The Session archive identity is inconsistent."), archive.Close())
	}
	// Transfer the manifest's existing permit to the timeline reader. A second
	// archive operation would compete with the capacity already held by this read.
	timeline, err := reader.archiveTimelineContent(ctx, archive.operation, manifest.Timeline.FileID, &manifest, v2.HashBytes(archive.Data))
	if err != nil {
		var invalid *archiveValidationError
		if errors.Is(err, fs.ErrNotExist) || errors.As(err, &invalid) {
			return nil, &model.Fault{Code: "source_corrupt", Message: "The ready Session archive timeline is missing or corrupt.", Cause: err}
		}
		return nil, err
	}
	return &historyTimelineArchive{RetainedArchive: timeline, manifest: archive.Data}, nil
}
func (s *Execution) TaskArchiveStatus(ctx context.Context, p model.Principal, project, taskID, id string) (sp.ArchiveStatus, error) {
	reader, err := s.taskReader()
	if err != nil {
		return sp.ArchiveStatus{}, err
	}
	return reader.ArchiveStatus(ctx, p, project, taskID, id)
}
