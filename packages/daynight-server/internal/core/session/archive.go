package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

const archiveBucket = sessionarchive.Bucket

// Archive access follows the original session's scope, independently of a later
// task claim. This path grants no authority to reconnect or control an agent.
func (s *Execution) archiveAccess(ctx context.Context, p model.Principal, project, taskID, id string, finalize bool, fn func(*operationTx, *record, task) error) error {
	return s.archiveRun(ctx, p, project, taskID, id, finalize, func(a *Access) error {
		return fn(a.tx, a.record, a.task)
	})
}

func scopeArchiveTask(ctx context.Context, tx *operationTx, project, id string, finalize bool) (task, bool, error) {
	if !finalize || (project == "" && id == "") {
		t, err := scopeTask(ctx, tx, project, id)
		return t, false, err
	}
	// Retain task-before-session lock ordering: deletion freezes the session in
	// the same transaction, so finalization sees either side of that transition.
	persisted, deleted, err := tx.dao.LockArchiveTask(ctx, project, id)
	return task{Worker: persisted.Worker, Status: persisted.Status, StartupReport: persisted.StartupReport}, deleted, err
}
func archiveStatus(ctx context.Context, tx *operationTx, id string) (sp.ArchiveStatus, string, error) {
	return tx.dao.SessionArchive(ctx, id)
}
func (s *Execution) ArchiveStatus(ctx context.Context, p model.Principal, project, taskID, id string) (sp.ArchiveStatus, error) {
	var out sp.ArchiveStatus
	err := s.archiveAccess(ctx, p, project, taskID, id, true, func(tx *operationTx, _ *record, _ task) error {
		var err error
		out, _, err = archiveStatus(ctx, tx, id)
		return err
	})
	return out, err
}
func archiveWriter(p model.Principal, r *record, f sp.Fence, controller, instance string) error {
	if p.Kind != model.PATCredential || p.UserID != r.Owner {
		return denied()
	}
	if f != r.Snapshot.Fence || controller != r.Snapshot.Identity.ControllerID || instance != r.Snapshot.Identity.ControllerInstanceID {
		return conflict()
	}
	return nil
}
func (s *Execution) UpdateArchive(ctx context.Context, p model.Principal, project, taskID, id string, in sp.ArchiveUpdate) (sp.ArchiveStatus, error) {
	var out sp.ArchiveStatus
	err := s.archiveAccess(ctx, p, project, taskID, id, true, func(tx *operationTx, r *record, _ task) error {
		if err := archiveWriter(p, r, in.Fence, in.ControllerID, in.ControllerInstanceID); err != nil {
			return err
		}
		var err error
		out, _, err = archiveStatus(ctx, tx, id)
		if err != nil || out.State == "ready" {
			return err
		}
		err = tx.dao.SetSessionArchiveState(ctx, id, in.State, in.ErrorCode)
		out = sp.ArchiveStatus{State: in.State, ErrorCode: in.ErrorCode}
		return err
	})
	return out, err
}
func (s *Execution) PutArchive(ctx context.Context, p model.Principal, project, taskID, id string, data []byte) (out sp.ArchiveStatus, err error) {
	op, err := s.BeginArchive(ctx, p, project, taskID, id, ArchiveV1Upload)
	if err != nil {
		return out, err
	}
	defer func() { err = errors.Join(err, op.Close()) }()
	return op.PutArchive(ctx, data)
}

func (s *Execution) putArchive(ctx context.Context, op *ArchiveOperation, data []byte) (sp.ArchiveStatus, error) {
	p, project, taskID, id := op.principal, op.project, op.task, op.id
	var out sp.ArchiveStatus
	doc, err := sp.DecodeArchive(data)
	if err != nil {
		return out, fault("invalid_input", "Invalid session archive.")
	}
	hash := sha256.Sum256(data)
	digest := hex.EncodeToString(hash[:])
	size := strconv.Itoa(len(data))
	err = s.archiveAccess(ctx, p, project, taskID, id, true, func(tx *operationTx, r *record, t task) error {
		if r.Owner != op.owner {
			return conflict()
		}
		if err := archiveWriter(p, r, doc.Fence, doc.ControllerID, doc.ControllerInstanceID); err != nil {
			return err
		}
		if doc.Provider != r.Snapshot.Identity.Provider || r.Snapshot.Identity.NativeSessionID != nil && !jsonEqual(encode(doc.NativeSessionID), encode(r.Snapshot.Identity.NativeSessionID)) {
			return conflict()
		}
		if r.Snapshot.TestExecutionID != "" {
			if r.Snapshot.Lifecycle != "archived" {
				return conflict()
			}
		} else if active(t, r) || (r.Snapshot.Lifecycle == "active" && t.Status == "in_progress") {
			return conflict()
		}
		var err error
		out, _, err = archiveStatus(ctx, tx, id)
		if err != nil {
			return err
		}
		if out.State == "ready" {
			if out.SHA256 == nil || *out.SHA256 != digest {
				return conflict()
			}
			return nil
		}
		if s.files == nil {
			return fault("controller_offline", "Archive file storage is unavailable.")
		}
		path, err := archiveObjectPath(r.Snapshot.Identity.ProjectID, r.Owner, id, digest)
		if err != nil {
			return err
		}
		info, err := s.files.Put(ctx, archiveBucket, path, bytes.NewReader(data))
		if err != nil {
			return err
		}
		if info.Size != int64(len(data)) {
			return errors.New("archive storage length mismatch")
		}
		err = tx.dao.SetSessionArchiveReady(ctx, id, digest, len(data), path)
		if err != nil {
			return err
		}
		// A disconnected controller may have created the native session after its
		// last acknowledged state. Final archival may establish that identity,
		// but can never replace an identity the relay already observed.
		if r.Snapshot.Identity.NativeSessionID == nil && doc.NativeSessionID != nil {
			r.Snapshot.Identity.NativeSessionID = doc.NativeSessionID
			if err = save(ctx, tx, r); err != nil {
				return err
			}
		}
		out = sp.ArchiveStatus{State: "ready", SHA256: &digest, ByteLength: &size}
		return nil
	})
	return out, err
}
func (s *Execution) ArchiveContent(ctx context.Context, p model.Principal, project, taskID, id string) (*RetainedArchive, error) {
	reservation, err := s.TryReserveArchivePreflight()
	if err != nil {
		return nil, err
	}
	return s.ArchiveContentReserved(ctx, p, project, taskID, id, reservation)
}

func (s *Execution) ArchiveContentReserved(ctx context.Context, p model.Principal, project, taskID, id string, reservation *ArchivePreflightReservation) (*RetainedArchive, error) {
	op, err := s.BeginArchiveReserved(ctx, p, project, taskID, id, ArchiveV1Read, reservation)
	if err != nil {
		return nil, err
	}
	op.mu.Lock()
	data, err := s.archiveContent(ctx, op)
	op.mu.Unlock()
	if err != nil {
		return nil, errors.Join(err, op.Close())
	}
	return &RetainedArchive{Data: data, operation: op}, nil
}

func (s *Execution) archiveContent(ctx context.Context, op *ArchiveOperation) (json.RawMessage, error) {
	p, project, taskID, id := op.principal, op.project, op.task, op.id
	var out json.RawMessage
	err := s.archiveAccess(ctx, p, project, taskID, id, false, func(tx *operationTx, r *record, _ task) (result error) {
		if r.Owner != op.owner {
			return conflict()
		}
		status, path, err := archiveStatus(ctx, tx, id)
		if err != nil {
			return err
		}
		if status.State != "ready" || s.files == nil {
			return fault("not_found", "Session archive is not available.")
		}
		object, err := s.files.Open(ctx, archiveBucket, path)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return &model.Fault{Code: "source_corrupt", Message: "The ready Session archive file is missing.", Cause: err}
			}
			return err
		}
		defer func() { result = archiveCleanupFailure(result, object.Body.Close()) }()
		data, err := io.ReadAll(io.LimitReader(object.Body, sp.MaxArchiveBytes+1))
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		if status.SHA256 == nil || status.ByteLength == nil || strconv.Itoa(len(data)) != *status.ByteLength || hex.EncodeToString(sum[:]) != *status.SHA256 {
			return fault("source_corrupt", "Session archive integrity check failed.")
		}
		if _, err = sp.DecodeArchive(data); err != nil {
			return &model.Fault{Code: "source_corrupt", Message: "The Session archive format is invalid.", Cause: err}
		}
		out = data
		return nil
	})
	return out, err
}
