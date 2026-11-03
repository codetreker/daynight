package sessionrelay

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/jackc/pgx/v5"
)

const archiveBucket = "session-archives"

// Archive access follows the original session's scope, independently of a later
// task claim. This path grants no authority to reconnect or control an agent.
func (s *Service) archiveAccess(ctx context.Context, p core.Principal, project, taskID, id string, finalize bool, fn func(pgx.Tx, *record, task) error) error {
	return s.transact(ctx, func(tx pgx.Tx) error {
		t, deleted, err := scopeArchiveTask(ctx, tx, project, taskID, finalize)
		if err != nil {
			return err
		}
		if project != "" {
			if _, err = member(ctx, tx, p, project, s.now()); err != nil {
				return err
			}
		}
		r, err := load(ctx, tx, id)
		if err != nil {
			return err
		}
		v := r.Snapshot
		if v.Identity.ProjectID != project || v.Identity.TaskID != taskID || (project == "") != (v.TestExecutionID != "") {
			return conflict()
		}
		// Only the original controller owner may finish a deleted task's archive.
		// Browser content and ordinary session access retain the deletion boundary.
		if deleted && (p.Kind != core.PATCredential || p.UserID != r.Owner) {
			return denied()
		}
		if project == "" {
			if _, err = s.scopePermission(ctx, tx, p, r); err != nil {
				return err
			}
		}
		return fn(tx, r, t)
	})
}

func scopeArchiveTask(ctx context.Context, tx pgx.Tx, project, id string, finalize bool) (task, bool, error) {
	if !finalize || (project == "" && id == "") {
		t, err := scopeTask(ctx, tx, project, id)
		return t, false, err
	}
	var t task
	var deleted bool
	// Retain task-before-session lock ordering: deletion freezes the session in
	// the same transaction, so finalization sees either side of that transition.
	if err := tx.QueryRow(ctx, `SELECT status,deleted_at IS NOT NULL FROM tasks WHERE project_id=$1 AND id=$2 FOR SHARE`, project, id).Scan(&t.Status, &deleted); err != nil {
		return task{}, false, err
	}
	t, err := taskWorker(ctx, tx, id, t)
	return t, deleted, err
}
func archiveStatus(ctx context.Context, tx pgx.Tx, id string) (sp.ArchiveStatus, string, error) {
	out := sp.ArchiveStatus{State: "unavailable"}
	var path *string
	err := tx.QueryRow(ctx, `SELECT state,sha256,byte_length::text,error_code,object_path FROM session_archives WHERE session_id=$1`, id).Scan(&out.State, &out.SHA256, &out.ByteLength, &out.ErrorCode, &path)
	if errors.Is(err, pgx.ErrNoRows) {
		return sp.ArchiveStatus{State: "unavailable"}, "", nil
	}
	if path != nil {
		return out, *path, err
	}
	return out, "", err
}
func (s *Service) ArchiveStatus(ctx context.Context, p core.Principal, project, taskID, id string) (sp.ArchiveStatus, error) {
	var out sp.ArchiveStatus
	err := s.archiveAccess(ctx, p, project, taskID, id, true, func(tx pgx.Tx, _ *record, _ task) error {
		var err error
		out, _, err = archiveStatus(ctx, tx, id)
		return err
	})
	return out, err
}
func archiveWriter(p core.Principal, r *record, f sp.Fence, controller, instance string) error {
	if p.Kind != core.PATCredential || p.UserID != r.Owner {
		return denied()
	}
	if f != r.Snapshot.Fence || controller != r.Snapshot.Identity.ControllerID || instance != r.Snapshot.Identity.ControllerInstanceID {
		return conflict()
	}
	return nil
}
func (s *Service) UpdateArchive(ctx context.Context, p core.Principal, project, taskID, id string, in sp.ArchiveUpdate) (sp.ArchiveStatus, error) {
	var out sp.ArchiveStatus
	err := s.archiveAccess(ctx, p, project, taskID, id, true, func(tx pgx.Tx, r *record, _ task) error {
		if err := archiveWriter(p, r, in.Fence, in.ControllerID, in.ControllerInstanceID); err != nil {
			return err
		}
		var err error
		out, _, err = archiveStatus(ctx, tx, id)
		if err != nil || out.State == "ready" {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO session_archives(session_id,state,error_code) VALUES($1,$2,$3) ON CONFLICT(session_id) DO UPDATE SET state=excluded.state,error_code=excluded.error_code,updated_at=now()`, id, in.State, in.ErrorCode)
		out = sp.ArchiveStatus{State: in.State, ErrorCode: in.ErrorCode}
		return err
	})
	return out, err
}
func (s *Service) PutArchive(ctx context.Context, p core.Principal, project, taskID, id string, data []byte) (sp.ArchiveStatus, error) {
	var out sp.ArchiveStatus
	doc, err := sp.DecodeArchive(data)
	if err != nil {
		return out, fault("invalid_input", "Invalid session archive.")
	}
	hash := sha256.Sum256(data)
	digest := hex.EncodeToString(hash[:])
	size := strconv.Itoa(len(data))
	err = s.archiveAccess(ctx, p, project, taskID, id, true, func(tx pgx.Tx, r *record, t task) error {
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
		path := id + "/" + digest + ".json"
		info, err := s.files.Put(ctx, archiveBucket, path, bytes.NewReader(data))
		if err != nil {
			return err
		}
		if info.Size != int64(len(data)) {
			return errors.New("archive storage length mismatch")
		}
		_, err = tx.Exec(ctx, `INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path) VALUES($1,'ready',$2,$3,$4) ON CONFLICT(session_id) DO UPDATE SET state='ready',sha256=excluded.sha256,byte_length=excluded.byte_length,object_path=excluded.object_path,error_code=NULL,updated_at=now()`, id, digest, len(data), path)
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
func (s *Service) ArchiveContent(ctx context.Context, p core.Principal, project, taskID, id string) (json.RawMessage, error) {
	var out json.RawMessage
	err := s.archiveAccess(ctx, p, project, taskID, id, false, func(tx pgx.Tx, _ *record, _ task) error {
		status, path, err := archiveStatus(ctx, tx, id)
		if err != nil {
			return err
		}
		if status.State != "ready" || s.files == nil {
			return fault("not_found", "Session archive is not available.")
		}
		object, err := s.files.Open(ctx, archiveBucket, path)
		if err != nil {
			return err
		}
		defer object.Body.Close()
		data, err := io.ReadAll(io.LimitReader(object.Body, sp.MaxArchiveBytes+1))
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		if status.SHA256 == nil || status.ByteLength == nil || strconv.Itoa(len(data)) != *status.ByteLength || hex.EncodeToString(sum[:]) != *status.SHA256 {
			return errors.New("session archive integrity check failed")
		}
		if _, err = sp.DecodeArchive(data); err != nil {
			return err
		}
		out = data
		return nil
	})
	return out, err
}
