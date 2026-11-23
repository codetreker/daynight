package session

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ArchiveStagingCorruptError is a non-mutating observation of an unavailable
// registered object. Only complete can establish the durable terminal receipt.
type ArchiveStagingCorruptError struct{ Receipt sp.ArchiveFileReceipt }

func (e *ArchiveStagingCorruptError) Error() string { return "archive staging is corrupt" }

func stagingCorrupt(err error) bool {
	return errors.Is(err, filestorage.ErrArchiveStagingMissing) || errors.Is(err, filestorage.ErrArchiveStagingCorrupt)
}
func stagingBusy(err error) error {
	if errors.Is(err, filestorage.ErrGateBusy) {
		return errors.Join(archiveBusy("staging_busy"), err)
	}
	return err
}
func stagingReceipt(v store.ArchiveStagingRecord, offset int64) sp.ArchiveFileReceipt {
	out := sp.ArchiveFileReceipt{UploadVersion: 2, FileID: v.FileID, State: v.State, AcceptedOffset: decimal(offset), ByteLength: decimal(v.ByteLength), SHA256: v.SHA256}
	if v.State == "complete" {
		rev := decimal(v.TimelineRevision)
		out.TimelineRevision = &rev
	}
	if v.State == "failed" {
		var e sp.ImageError
		if json.Unmarshal(v.TerminalError, &e) == nil && e.Code != "" {
			out.Error = &e
		}
	}
	if v.SuccessorFileID != "" {
		successor := v.SuccessorFileID
		out.SuccessorFileID = &successor
	}
	return out
}

func (s *Execution) ArchiveFileStatus(ctx context.Context, p model.Principal, project, taskID, id, fileID string) (out sp.ArchiveFileReceipt, result error) {
	var owner string
	var row store.ArchiveStagingRecord
	read := func() error {
		return s.archiveAccess(ctx, p, project, taskID, id, true, func(tx *operationTx, r *record, t task) error {
			if p.Kind != model.PATCredential || p.UserID != r.Owner {
				return denied()
			}
			dao, err := archiveDAO(tx)
			if err != nil {
				return err
			}
			bundle, err := dao.SessionArchiveBundle(ctx, id)
			if err != nil {
				return err
			}
			if err = observeArchivePreparation(p, r, t, bundle); err != nil {
				return err
			}
			owner = r.Owner
			if d, ok := dao.(store.SessionArchiveStagingDAO); ok {
				row, err = d.ArchiveStagingRecord(ctx, id, fileID)
				if err == nil {
					out = stagingReceipt(row, row.TerminalOffset)
					return nil
				}
				if !errors.Is(err, model.ErrNotFound) {
					return err
				}
			}
			file, err := dao.SessionArchiveFile(ctx, id, fileID)
			if err != nil {
				return err
			}
			out = fileReceipt(file)
			out.UploadVersion = 1
			return nil
		})
	}
	if err := read(); err != nil {
		return out, err
	}
	if out.UploadVersion != 2 || row.State != "receiving" {
		return out, nil
	}
	namespace, err := archiveNamespace(project, owner, id)
	if err != nil {
		return out, err
	}
	backend, ok := s.files.(filestorage.ArchiveStagingBackend)
	if !ok {
		return out, errors.New("archive staging unavailable")
	}
	handle, err := backend.AcquireArchiveStaging(ctx, namespace, false)
	if err != nil {
		if stagingCorrupt(err) {
			return out, &ArchiveStagingCorruptError{Receipt: out}
		}
		return out, stagingBusy(err)
	}
	defer func() { result = archiveCleanupFailure(result, handle.Close()) }()
	previous := row
	if err = read(); err != nil {
		return out, err
	}
	if out.UploadVersion != 2 || row.State != "receiving" || row.FileID != previous.FileID || row.SHA256 != previous.SHA256 || row.ByteLength != previous.ByteLength || row.Purpose != previous.Purpose || row.TimelineRevision != previous.TimelineRevision {
		return out, archiveConflict()
	}
	offset, err := handle.Observe(ctx, row.FileID, row.ByteLength)
	if err != nil {
		if stagingCorrupt(err) {
			return out, &ArchiveStagingCorruptError{Receipt: out}
		}
		return out, stagingBusy(err)
	}
	return stagingReceipt(row, offset), nil
}
