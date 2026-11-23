package session

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func (op *ArchiveOperation) RestartArchiveFile(ctx context.Context, purpose, fileID, replacement string) (out sp.ArchiveFileReceipt, result error) {
	op.mu.Lock()
	defer op.mu.Unlock()
	if err := op.check(ArchiveV1Upload); err != nil {
		return out, err
	}
	if op.historyWriter != nil {
		return out, archiveConflict()
	}
	canonical, err := model.CanonicalID(replacement)
	if err != nil || canonical != replacement || replacement == fileID {
		return out, fault("invalid_input", "Invalid replacement archive file identity.")
	}
	ctx, cancel := op.GateContext(ctx)
	defer cancel()
	archiveCtx := ctx
	leaseID := uuid.NewString()
	ctx, finish, err := op.execution.beginImageIO(ctx, op.id, leaseID)
	if err != nil {
		return out, err
	}
	acquired := false
	var handle filestorage.ArchiveStaging
	terminal := false
	defer func() {
		var closeErr error
		if handle != nil {
			closeErr = handle.Close()
			result = archiveCleanupFailure(result, closeErr)
		}
		finishErr := finish()
		result = errors.Join(result, finishErr)
		var releaseErr error
		if acquired {
			releaseErr = op.execution.releaseImageLease(context.WithoutCancel(ctx), op.principal, op.project, op.task, op.id, leaseID)
			result = errors.Join(result, releaseErr)
		}
		if terminal && closeErr == nil && finishErr == nil && releaseErr == nil {
			cleanup, done := filestorage.GateCleanupContext(archiveCtx)
			if e := op.cleanupArchiveStreamTerminal(cleanup); e != nil {
				slog.ErrorContext(ctx, "Archive staging cleanup failed", "session_id", op.id, "file_id", fileID, "error", e)
			}
			done()
		}
	}()
	var old store.ArchiveStagingRecord
	err = op.bundleAccess(ctx, func(tx *operationTx, _ *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
		d, e := archiveStagingDAO(dao)
		if e != nil {
			return e
		}
		old, e = d.ArchiveStagingRecord(ctx, op.id, fileID)
		if e != nil {
			return e
		}
		if old.State != "failed" || !archiveStreamPurpose(purpose, old.Purpose) {
			return archiveConflict()
		}
		var reason sp.ImageError
		if json.Unmarshal(old.TerminalError, &reason) != nil || reason.Code != "staging_corrupt" {
			return archiveConflict()
		}
		if old.SuccessorFileID != "" {
			if old.SuccessorFileID != replacement {
				return archiveConflict()
			}
			out = stagingReceipt(old, old.TerminalOffset)
			return nil
		}
		if old.Purpose == "history" && (bundle.Phase != "settling" || bundle.HistoryID != fileID || bundle.Revision != old.TimelineRevision) || old.Purpose == "timeline" && (bundle.Phase != "sealed" || bundle.TimelineID != fileID || bundle.Revision != old.TimelineRevision) || old.Purpose == "resource" && (bundle.Phase != "settling" || old.TimelineRevision < 1 || old.TimelineRevision > bundle.Revision || !archiveResourceInLedger(bundle, old.Resource)) {
			return archiveConflict()
		}
		media, e := archiveMediaDAO(tx)
		if e != nil {
			return e
		}
		usage, e := media.SessionResourceUsage(ctx, op.id)
		if e != nil {
			return e
		}
		if usage.Deleting {
			return conflict()
		}
		leases, e := media.ListSessionResourceLeases(ctx, op.id)
		if e != nil {
			return e
		}
		for _, lease := range leases {
			if lease.Kind == "archive" {
				return archiveBusy("staging_busy")
			}
		}
		return acquireImageResourceLease(ctx, media, store.SessionResourceLease{SessionID: op.id, ID: leaseID, Kind: "archive", OwnerID: op.owner, DeleteEpoch: usage.DeleteEpoch})
	})
	if err != nil {
		return out, err
	}
	if old.SuccessorFileID != "" {
		terminal = true
		return out, nil
	}
	acquired = true
	namespace, err := archiveNamespace(op.project, op.owner, op.id)
	if err != nil {
		return out, err
	}
	backend, ok := op.execution.files.(filestorage.ArchiveStagingBackend)
	if !ok {
		return out, errors.New("archive staging unavailable")
	}
	handle, err = backend.AcquireArchiveStaging(ctx, namespace, true)
	if err != nil {
		return out, stagingBusy(err)
	}
	err = op.bundleAccess(ctx, func(_ *operationTx, _ *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
		d, e := archiveStagingDAO(dao)
		if e != nil {
			return e
		}
		current, e := d.ArchiveStagingRecord(ctx, op.id, fileID)
		if e != nil {
			return e
		}
		if !sameStreamRecord(current, old) || current.State != "failed" || current.SuccessorFileID != "" {
			return archiveConflict()
		}
		if old.Purpose == "history" && (bundle.Phase != "settling" || bundle.HistoryID != fileID || bundle.Revision != old.TimelineRevision) || old.Purpose == "timeline" && (bundle.Phase != "sealed" || bundle.TimelineID != fileID || bundle.Revision != old.TimelineRevision) || old.Purpose == "resource" && (bundle.Phase != "settling" || !archiveResourceInLedger(bundle, old.Resource)) {
			return archiveConflict()
		}
		if _, e = d.ArchiveStagingRecord(ctx, op.id, replacement); e == nil {
			return archiveConflict()
		} else if !errors.Is(e, model.ErrNotFound) {
			return e
		}
		if _, e = dao.SessionArchiveFile(ctx, op.id, replacement); e == nil {
			return archiveConflict()
		} else if !errors.Is(e, model.ErrNotFound) {
			return e
		}
		return nil
	})
	if err != nil {
		return out, err
	}
	err = handle.Create(ctx, replacement)
	if errors.Is(err, fs.ErrExist) {
		err = handle.AdoptEmpty(ctx, replacement)
	}
	if err != nil {
		return out, err
	}
	err = op.bundleAccess(ctx, func(_ *operationTx, _ *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
		d, e := archiveStagingDAO(dao)
		if e != nil {
			return e
		}
		current, e := d.ArchiveStagingRecord(ctx, op.id, fileID)
		if e != nil {
			return e
		}
		if !sameStreamRecord(current, old) || current.State != "failed" || current.SuccessorFileID != "" {
			return archiveConflict()
		}
		if old.Purpose == "history" && (bundle.Phase != "settling" || bundle.HistoryID != fileID || bundle.Revision != old.TimelineRevision) || old.Purpose == "timeline" && (bundle.Phase != "sealed" || bundle.TimelineID != fileID || bundle.Revision != old.TimelineRevision) || old.Purpose == "resource" && (bundle.Phase != "settling" || !archiveResourceInLedger(bundle, old.Resource)) {
			return archiveConflict()
		}
		next := old
		next.FileID = replacement
		next.State = "receiving"
		next.TerminalOffset = 0
		next.StagingReleased = false
		next.TerminalError = nil
		next.SuccessorFileID = ""
		next.Path = namespace.Directory() + "/files/" + replacement
		if old.Purpose == "resource" {
			next.Path, e = BlobAddress(op.project, op.owner, op.id, replacement)
			if e != nil {
				return e
			}
		}
		inserted, e := d.InsertArchiveStaging(ctx, next)
		if e != nil {
			return e
		}
		if !inserted {
			return archiveConflict()
		}
		changed, e := d.SetArchiveStagingSuccessor(ctx, old, replacement)
		if e != nil {
			return e
		}
		if !changed {
			return archiveConflict()
		}
		if old.Purpose == "history" {
			bundle.HistoryID = replacement
		} else if old.Purpose == "timeline" {
			bundle.TimelineID = replacement
		}
		if e = dao.SaveSessionArchiveBundle(ctx, bundle); e != nil {
			return e
		}
		old.SuccessorFileID = replacement
		return nil
	})
	if err != nil {
		return out, err
	}
	op.markCommit(nil)
	terminal = true
	return stagingReceipt(old, old.TerminalOffset), nil
}
