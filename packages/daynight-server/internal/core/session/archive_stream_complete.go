package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func archiveStreamPurpose(requested, actual string) bool {
	return requested == actual || requested == "timeline" && actual == "resource"
}

func (op *ArchiveOperation) failArchiveStream(ctx context.Context, row store.ArchiveStagingRecord, code, message string, offset int64) error {
	return op.bundleAccess(ctx, func(_ *operationTx, _ *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
		d, err := archiveStagingDAO(dao)
		if err != nil {
			return err
		}
		current, err := d.ArchiveStagingRecord(ctx, op.id, row.FileID)
		if err != nil {
			return err
		}
		if !sameStreamRecord(current, row) || current.State != "receiving" {
			return archiveConflict()
		}
		ok, err := d.FinishArchiveStaging(ctx, row, "failed", offset, encode(sp.ImageError{Code: code, Message: message}))
		if err != nil {
			return err
		}
		if !ok {
			return archiveConflict()
		}
		if code != "staging_corrupt" && row.Purpose == "timeline" && bundle.TimelineID == row.FileID {
			bundle.Phase = "failed"
			return dao.SaveSessionArchiveBundle(ctx, bundle)
		}
		return nil
	})
}
func sameStreamRecord(a, b store.ArchiveStagingRecord) bool {
	return a.SessionID == b.SessionID && a.FileID == b.FileID && a.Purpose == b.Purpose && a.SHA256 == b.SHA256 && a.ByteLength == b.ByteLength && a.Path == b.Path && a.TimelineRevision == b.TimelineRevision && jsonEqual(a.Resource, b.Resource)
}

func (op *ArchiveOperation) CompleteArchiveFile(ctx context.Context, purpose, fileID string) (out sp.ArchiveFileReceipt, result error) {
	op.mu.Lock()
	defer op.mu.Unlock()
	if err := op.check(ArchiveV1Upload); err != nil {
		return out, err
	}
	if op.historyWriter != nil {
		return out, archiveConflict()
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
		if handle != nil {
			result = errors.Join(result, handle.Close())
		}
		finishErr := finish()
		result = errors.Join(result, finishErr)
		var releaseErr error
		if acquired {
			releaseErr = op.execution.releaseImageLease(context.WithoutCancel(ctx), op.principal, op.project, op.task, op.id, leaseID)
			result = errors.Join(result, releaseErr)
		}
		if terminal && finishErr == nil && releaseErr == nil {
			cleanup, cancelCleanup := filestorage.GateCleanupContext(archiveCtx)
			if e := op.cleanupArchiveStreamTerminal(cleanup); e != nil {
				slog.ErrorContext(ctx, "Archive staging cleanup failed", "session_id", op.id, "file_id", fileID, "error", e)
			}
			cancelCleanup()
		}
	}()
	var row store.ArchiveStagingRecord
	var epoch int64
	var inventoryRequired bool
	var resource *sp.Resource
	err = op.bundleAccess(ctx, func(tx *operationTx, _ *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
		d, e := archiveStagingDAO(dao)
		if e != nil {
			return e
		}
		row, e = d.ArchiveStagingRecord(ctx, op.id, fileID)
		if e != nil {
			return e
		}
		if !archiveStreamPurpose(purpose, row.Purpose) {
			return archiveConflict()
		}
		if row.State == "complete" || row.State == "failed" {
			return nil
		}
		if row.State != "receiving" || row.Purpose == "history" && (bundle.Phase != "settling" || bundle.HistoryID != fileID || bundle.Revision != row.TimelineRevision) || row.Purpose == "timeline" && (bundle.Phase != "sealed" || bundle.TimelineID != fileID || bundle.Revision != row.TimelineRevision) || row.Purpose == "resource" && (bundle.Phase != "settling" || row.TimelineRevision < 1 || row.TimelineRevision > bundle.Revision || !archiveResourceInLedger(bundle, row.Resource)) {
			return archiveConflict()
		}
		if row.Purpose == "resource" {
			var r sp.Resource
			if json.Unmarshal(row.Resource, &r) != nil {
				return archiveConflict()
			}
			resource = &r
		}
		if row.Purpose == "history" {
			var ledger archiveLedger
			if json.Unmarshal(bundle.Ledger, &ledger) != nil {
				return archiveConflict()
			}
			inventoryRequired = ledger.StoppedContentPolicy != ""
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
		epoch = usage.DeleteEpoch
		return acquireImageResourceLease(ctx, media, store.SessionResourceLease{SessionID: op.id, ID: leaseID, Kind: "archive", OwnerID: op.owner, DeleteEpoch: epoch})
	})
	if err != nil {
		return out, err
	}
	if row.State != "receiving" {
		terminal = true
		return stagingReceipt(row, row.TerminalOffset), nil
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
		if !sameStreamRecord(current, row) || current.State != "receiving" {
			return archiveConflict()
		}
		if row.Purpose == "history" && (bundle.Phase != "settling" || bundle.HistoryID != fileID || bundle.Revision != row.TimelineRevision) || row.Purpose == "timeline" && (bundle.Phase != "sealed" || bundle.TimelineID != fileID || bundle.Revision != row.TimelineRevision) || row.Purpose == "resource" && (bundle.Phase != "settling" || !archiveResourceInLedger(bundle, row.Resource)) {
			return archiveConflict()
		}
		return nil
	})
	if err != nil {
		return out, err
	}
	markCorrupt := func() (sp.ArchiveFileReceipt, error) {
		err := op.failArchiveStream(ctx, row, "staging_corrupt", "Archive staging is corrupt.", 0)
		if err != nil {
			return sp.ArchiveFileReceipt{}, err
		}
		row.State = "failed"
		row.TerminalError = encode(sp.ImageError{Code: "staging_corrupt", Message: "Archive staging is corrupt."})
		terminal = true
		op.markCommit(nil)
		return stagingReceipt(row, 0), nil
	}
	offset, err := handle.Observe(ctx, fileID, row.ByteLength)
	if err != nil {
		if stagingCorrupt(err) {
			return markCorrupt()
		}
		return out, err
	}
	if offset != row.ByteLength {
		return out, archiveConflict()
	}
	object, err := handle.Open(ctx, fileID, row.ByteLength)
	if err != nil {
		if stagingCorrupt(err) {
			return markCorrupt()
		}
		return out, err
	}
	hash := sha256.New()
	var content []byte
	var n int64
	if row.Purpose == "resource" {
		n, err = io.Copy(hash, object.Body)
	} else {
		content, err = io.ReadAll(io.TeeReader(object.Body, hash))
		n = int64(len(content))
	}
	err = errors.Join(err, object.Body.Close())
	if err != nil {
		return out, err
	}
	if n != row.ByteLength || hex.EncodeToString(hash.Sum(nil)) != row.SHA256 {
		return markCorrupt()
	}
	file := stagingBundleFile(row)
	file.AcceptedOffset = row.ByteLength
	if err = op.validateArchiveStreamContent(ctx, &file, row, epoch, inventoryRequired, resource, content, true); err != nil {
		return out, op.failStreamValidation(ctx, row, err, &terminal)
	}
	if _, err = handle.Publish(ctx, fileID, row.ByteLength, archiveFileBucket(file), archiveFilePath(file)); err != nil {
		return out, err
	}
	if err = op.validateArchiveStreamContent(ctx, &file, row, epoch, inventoryRequired, resource, content, false); err != nil {
		return out, op.failStreamValidation(ctx, row, err, &terminal)
	}
	row.State = "complete"
	row.TerminalOffset = row.ByteLength
	terminal = true
	op.markCommit(nil)
	return stagingReceipt(row, row.ByteLength), nil
}

func (op *ArchiveOperation) failStreamValidation(ctx context.Context, row store.ArchiveStagingRecord, err error, terminal *bool) error {
	invalid := definiteArchiveValidation(err)
	if invalid == nil {
		return err
	}
	code, message := "archive_incomplete", "Archive file validation failed."
	var refusal *model.Fault
	if errors.As(invalid.cause, &refusal) && refusal.Code == "quota_exceeded" {
		code, message = refusal.Code, refusal.Message
	}
	failure := op.failArchiveStream(ctx, row, code, message, row.ByteLength)
	if failure == nil {
		*terminal = true
		op.markCommit(nil)
	}
	return errors.Join(err, failure)
}
