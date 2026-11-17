package session

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type terminalRecording struct {
	Responsibility  *v2.RecordingResponsibility
	Evidence        *v2.RecordingEvidence
	ObservedContent bool
}

// terminalArchiveRecord is the persisted subset needed to read a recording.
// Unrelated live state remains in the stored JSON and is never rewritten here.
type terminalArchiveRecord struct {
	Envelope       v2.Envelope
	Owner          v2.Owner
	Runs           []v2.Run
	Recording      map[string]terminalRecording
	FinalizationID *string
}

func decodeTerminalArchiveRecord(raw []byte) (*terminalArchiveRecord, error) {
	var r terminalArchiveRecord
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

type TerminalHistoryAccess struct {
	tx     *operationTx
	record *terminalArchiveRecord
}

type TerminalHistoryRunner func(context.Context, model.Principal, string, string, string, bool, func(*TerminalHistoryAccess) error) error
type TerminalDirectoryRunner func(context.Context, model.Principal, string, string, func(*Operation, store.SessionScope, *TaskAccess) error) error

func (s *Execution) SetTerminalDirectoryRunners(directory, taskDirectory TerminalDirectoryRunner) {
	s.terminalDirectoryRun, s.taskTerminalDirectoryRun = directory, taskDirectory
}

func (s *Execution) SetTerminalHistoryRunner(run TerminalHistoryRunner) { s.terminalHistoryRun = run }

func (op *Operation) LoadTerminalHistory(ctx context.Context, scope store.SessionScope, id string) (*TerminalHistoryAccess, error) {
	_, tx := op.scoped(scope)
	raw, err := tx.dao.LockTerminal(ctx, id)
	if err != nil {
		return nil, err
	}
	r, err := decodeTerminalArchiveRecord(raw)
	if err != nil {
		return nil, err
	}
	return &TerminalHistoryAccess{tx: tx, record: r}, nil
}

func (op *Operation) BindTerminalHistory(a *TerminalHistoryAccess, p model.Principal, project, taskID string, deleted bool) error {
	owner := a.record.Owner
	if owner.ProjectID != project || owner.TaskID != taskID {
		return conflict()
	}
	if deleted && (p.Kind != model.PATCredential || p.UserID != owner.OwnerUserID) {
		return denied()
	}
	return nil
}

func (s *Execution) terminalHistoryAccess(ctx context.Context, p model.Principal, project, taskID, id string, finalize bool, work func(*operationTx, *terminalArchiveRecord) error) error {
	if s.terminalHistoryRun == nil {
		return errors.New("terminal history scope unavailable")
	}
	return s.terminalHistoryRun(ctx, p, project, taskID, id, finalize, func(a *TerminalHistoryAccess) error { return work(a.tx, a.record) })
}

func terminalArchiveReadStatus(ctx context.Context, tx *operationTx, r *terminalArchiveRecord) (v2.ArchiveStatus, *v2.Receipt, string, error) {
	status, receipt, path, err := tx.dao.TerminalArchive(ctx, r.Envelope.SessionID)
	if errors.Is(err, model.ErrNotFound) {
		return v2.ArchiveStatus{State: "pending", FinalizationID: r.FinalizationID}, nil, "", nil
	}
	return status, receipt, path, err
}

func historyClosedRecording(r *terminalArchiveRecord, generation string) (terminalRecording, error) {
	rec := r.Recording[generation]
	if rec.Responsibility == nil || rec.Evidence == nil || !rec.Evidence.Closed {
		return rec, fault("source_corrupt", "The recording responsibility lacks immutable closed evidence.")
	}
	return rec, nil
}
func verifyTerminalArchiveRecord(r *terminalArchiveRecord, doc v2.Archive) error {
	if r.FinalizationID == nil || doc.FinalizationID != *r.FinalizationID || doc.SessionID != r.Envelope.SessionID || doc.ClaimID != r.Envelope.ClaimID || doc.ExecutionGeneration != r.Envelope.ExecutionGeneration || doc.Owner != r.Owner || !reflect.DeepEqual(doc.Runs, r.Runs) {
		return conflict()
	}
	for _, run := range r.Runs {
		rec, err := historyClosedRecording(r, run.ExecutionGeneration)
		if err != nil {
			return err
		}
		count := 0
		for _, file := range doc.Files {
			for _, segment := range run.SegmentIDs {
				if file.SegmentID == segment {
					count++
					break
				}
			}
		}
		amount := strconv.Itoa(count)
		if rec.Evidence.SelectedFrameCount != amount || rec.Evidence.RegisteredFrameCount != amount {
			return fault("source_corrupt", "The archive omits registered or selected recording content.")
		}
		digest, err := v2.SourceDigest(doc, run.ExecutionGeneration)
		if err != nil {
			return err
		}
		if digest != rec.Evidence.SourceSHA256 {
			return fault("source_corrupt", "The archive differs from the closed recording source.")
		}
		if rec.Evidence.CaptureError != nil {
			covered := false
			if *rec.Evidence.CaptureError == "recording_limit" && count > 0 && doc.Completeness == "partial" {
				for _, gap := range doc.Gaps {
					if gap.Interval == nil || gap.Interval.Reason != "recording_limit" {
						continue
					}
					for _, segment := range run.SegmentIDs {
						if gap.Interval.SegmentID == segment {
							covered = true
						}
					}
				}
			}
			if !covered {
				return fault("source_corrupt", "The run's capture failure lacks a matching recording-limit gap.")
			}
		}
		if count == 0 {
			found := false
			for _, zero := range doc.UnavailableRuns {
				if zero.ExecutionGeneration == run.ExecutionGeneration {
					found = true
					if zero.Evidence.RecordingEnabled != rec.Responsibility.RecordingEnabled || zero.Evidence.CaptureError != nil {
						return conflict()
					}
				}
			}
			if !found {
				return conflict()
			}
		} else if !rec.Responsibility.RecordingEnabled {
			return conflict()
		}
	}
	return nil
}

func (s *Execution) TerminalArchiveStatus(ctx context.Context, p model.Principal, project, taskID, id string) (v2.Message, error) {
	var out v2.Message
	err := s.terminalHistoryAccess(ctx, p, project, taskID, id, true, func(tx *operationTx, r *terminalArchiveRecord) error {
		status, _, _, err := terminalArchiveReadStatus(ctx, tx, r)
		e := r.Envelope
		e.Type = "archive_status"
		out = v2.Message{Envelope: e, Payload: status}
		return err
	})
	return out, err
}

func (s *Execution) readTerminalObject(ctx context.Context, op *ArchiveOperation, path string, hash string, size string) (data []byte, result error) {
	if op == nil || op.execution != s || op.closed || (op.mode != ArchiveV2Read && op.mode != ArchiveV2Upload) {
		return nil, errors.New("invalid archive operation")
	}
	if s.files == nil {
		return nil, fault("archive_pending", "Archive file storage is unavailable.")
	}
	obj, err := s.files.Open(ctx, archiveBucket, path)
	if err != nil {
		return nil, err
	}
	defer func() { result = archiveCleanupFailure(result, obj.Body.Close()) }()
	data, err = io.ReadAll(io.LimitReader(obj.Body, v2.MaxArchiveBytes+1))
	if err != nil {
		return nil, err
	}
	if strconv.Itoa(len(data)) != size || obj.Info.Size != int64(len(data)) || v2.HashBytes(data) != hash {
		return nil, fault("source_corrupt", "Session archive storage integrity failed.")
	}
	return data, nil
}

func (s *Execution) TerminalArchiveContent(ctx context.Context, p model.Principal, project, taskID, id string) (*RetainedArchive, error) {
	reservation, err := s.TryReserveArchivePreflight()
	if err != nil {
		return nil, err
	}
	return s.TerminalArchiveContentReserved(ctx, p, project, taskID, id, reservation)
}

func (s *Execution) TerminalArchiveContentReserved(ctx context.Context, p model.Principal, project, taskID, id string, reservation *ArchivePreflightReservation) (*RetainedArchive, error) {
	op, err := s.BeginArchiveReserved(ctx, p, project, taskID, id, ArchiveV2Read, reservation)
	if err != nil {
		return nil, err
	}
	op.mu.Lock()
	data, err := s.terminalArchiveContent(ctx, op)
	op.mu.Unlock()
	if err != nil {
		return nil, errors.Join(err, op.Close())
	}
	return &RetainedArchive{Data: data, operation: op}, nil
}

func (s *Execution) terminalArchiveContent(ctx context.Context, op *ArchiveOperation) (json.RawMessage, error) {
	p, project, taskID, id := op.principal, op.project, op.task, op.id
	var out json.RawMessage
	err := s.terminalHistoryAccess(ctx, p, project, taskID, id, false, func(tx *operationTx, r *terminalArchiveRecord) error {
		if r.Owner.OwnerUserID != op.owner {
			return conflict()
		}
		status, receipt, path, err := terminalArchiveReadStatus(ctx, tx, r)
		if err != nil {
			return err
		}
		if status.State != "ready" || receipt == nil || status.SHA256 == nil || status.ByteLength == nil {
			return fault("archive_pending", "No terminal archive is ready.")
		}
		data, err := s.readTerminalObject(ctx, op, path, *status.SHA256, *status.ByteLength)
		if err != nil {
			return err
		}
		doc, err := v2.DecodeArchive(data)
		if err != nil {
			return err
		}
		if err = verifyTerminalArchiveRecord(r, doc); err != nil {
			return err
		}
		if status.Completeness == nil || doc.Completeness != *status.Completeness {
			return conflict()
		}
		out = data
		return nil
	})
	return out, err
}

type terminalHistoryCursor struct{ Project, Task, Created, ID string }

func (s *Execution) TerminalHistory(ctx context.Context, p model.Principal, project, taskID, token string, limit int) (map[string]any, error) {
	return s.terminalHistory(ctx, p, project, taskID, token, limit, false)
}

func (s *Execution) terminalHistory(ctx context.Context, p model.Principal, project, taskID, token string, limit int, includeBinding bool) (map[string]any, error) {
	if limit < 1 || limit > 200 || len(token) > v2.MaxHistoryCursorBytes {
		return nil, fault("invalid_payload", "Invalid Session history page.")
	}
	var position terminalHistoryCursor
	var before *time.Time
	var beforeID *string
	if token != "" {
		raw, err := base64.RawURLEncoding.DecodeString(token)
		if err != nil || json.Unmarshal(raw, &position) != nil || position.Project != project || position.Task != taskID {
			return nil, fault("invalid_payload", "Invalid Session history cursor.")
		}
		at, err := time.Parse(time.RFC3339Nano, position.Created)
		if err != nil {
			return nil, fault("invalid_payload", "Invalid Session history timestamp.")
		}
		if _, err = uuid.Parse(position.ID); err != nil {
			return nil, fault("invalid_payload", "Invalid Session history identity.")
		}
		before = &at
		beforeID = &position.ID
	}
	var out map[string]any
	if s.terminalDirectoryRun == nil {
		return nil, errors.New("terminal directory scope unavailable")
	}
	err := s.terminalDirectoryRun(ctx, p, project, taskID, func(op *Operation, scope store.SessionScope, task *TaskAccess) error {
		if task.task.Type == model.TaskTypeGoal {
			out = map[string]any{"items": []map[string]any{}, "nextCursor": (*string)(nil)}
			return nil
		}
		_, tx := op.scoped(scope)
		rows, err := tx.dao.TerminalHistory(ctx, project, taskID, before, beforeID, limit+1)
		if err != nil {
			return err
		}
		items := []map[string]any{}
		var nextCursor *string
		for _, row := range rows {
			id, claim, backend, created := row.ID, row.Claim, row.Backend, row.Created
			snapshot, terminal := row.Snapshot, row.Terminal
			state, hash, size, completeness := row.State, row.Hash, row.Size, row.Completeness
			if len(items) == limit {
				last := items[len(items)-1]
				value := base64.RawURLEncoding.EncodeToString(encode(terminalHistoryCursor{Project: project, Task: taskID, Created: last["createdAt"].(string), ID: last["sessionId"].(string)}))
				nextCursor = &value
				break
			}
			content := "native_timeline"
			generation := ""
			var ended *string
			if backend == "herdr" {
				content = "terminal_recording"
				r, decodeErr := decodeTerminalArchiveRecord(terminal)
				if decodeErr != nil {
					return decodeErr
				}
				generation = r.Envelope.ExecutionGeneration
				if len(r.Runs) > 0 {
					ended = r.Runs[len(r.Runs)-1].StoppedAt
				}
			}
			if backend == "web" {
				var v struct {
					ExecutionGeneration string `json:"executionGeneration"`
				}
				if err = json.Unmarshal(snapshot, &v); err != nil {
					return err
				}
				generation = v.ExecutionGeneration
			}
			archiveState := "unavailable"
			if backend == "herdr" {
				archiveState = "pending"
			}
			if state != nil {
				archiveState = *state
			}
			items = append(items, map[string]any{"sessionId": id, "claimId": claim, "executionGeneration": generation, "agentControlMode": backend, "contentKind": content, "createdAt": created.UTC().Format(time.RFC3339Nano), "endedAt": ended, "archive": map[string]any{"state": archiveState, "sha256": hash, "byteLength": size, "completeness": completeness}})
			if includeBinding {
				w := task.task.Worker
				items[len(items)-1]["currentBinding"] = w != nil && w.ClaimID == claim && string(w.AgentControlMode) == backend
			}
		}
		out = map[string]any{"items": items, "nextCursor": nextCursor}
		return nil
	})
	return out, err
}
