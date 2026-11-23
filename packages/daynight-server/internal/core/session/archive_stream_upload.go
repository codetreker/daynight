package session

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

// ArchiveStreamBody binds blocking reads to the admitted Session I/O context.
// Cancellation must interrupt an in-flight Read. The returned function restores
// the caller's read context after the last Read and before the I/O scope exits.
type ArchiveStreamBody interface {
	io.Reader
	BindReadContext(context.Context) func() error
}

func (op *ArchiveOperation) PutArchiveFileV2(ctx context.Context, purpose, fileID string, offset, length int64, digest string, body io.Reader) (sp.ArchiveFileReceipt, error) {
	return op.putArchiveStream(ctx, purpose, fileID, offset, length, digest, body, nil)
}
func (op *ArchiveOperation) PutArchiveResourceV2(ctx context.Context, fileID string, offset, length int64, digest string, body io.Reader, resource sp.Resource) (sp.ArchiveFileReceipt, error) {
	return op.putArchiveStream(ctx, "resource", fileID, offset, length, digest, body, &resource)
}

func validStreamIdentity(purpose, fileID string, offset, length int64, digest string, resource *sp.Resource) error {
	limit := int64(sp.MaxArchiveTimelineBytes)
	switch purpose {
	case "history":
		limit = sp.MaxArchiveHistoryBytes
	case "resource":
		limit = sp.MaxArchiveBlobBytes
		if resource == nil || resource.Revision != "" || resource.Status != "available" || resource.ByteLength == nil || resource.SHA256 == nil || *resource.ByteLength != decimal(length) || *resource.SHA256 != digest {
			return archiveConflict()
		}
	case "timeline":
	default:
		return archiveConflict()
	}
	id, err := model.CanonicalID(fileID)
	_, digestErr := hex.DecodeString(digest)
	if err != nil || id != fileID || digestErr != nil || len(digest) != 64 || strings.ToLower(digest) != digest || offset < 0 || offset > length || length < 0 || length > limit || (length == 0 && (purpose != "resource" || digest != archiveDigest(nil))) || (offset != length && offset%sessionarchive.BlockSize != 0) {
		return fault("invalid_input", "Invalid archive file identity or offset.")
	}
	return nil
}

func archiveStreamPhase(bundle store.ArchiveBundle, purpose string, resource *sp.Resource) error {
	if (purpose == "history" || purpose == "resource") && bundle.Phase != "settling" || purpose == "timeline" && bundle.Phase != "sealed" {
		return archiveConflict()
	}
	if purpose == "resource" {
		var ledger archiveLedger
		if json.Unmarshal(bundle.Ledger, &ledger) != nil || bundle.HistoryID == "" {
			return archiveConflict()
		}
		found := false
		for _, entry := range ledger.Resources {
			if jsonEqual(encode(entry), encode(resource)) {
				found = true
				break
			}
		}
		if !found {
			return archiveConflict()
		}
	}
	return nil
}

// A migration descriptor is bound to its registered file identity. A corrupt
// upload may only be replaced through its explicit successor transaction.

func archiveStreamResourceUnregistered(ctx context.Context, dao store.SessionArchiveDAO, sessionID string, resource *sp.Resource, checkLegacy bool) error {
	if checkLegacy {
		legacy, err := dao.SessionArchiveFiles(ctx, sessionID)
		if err != nil {
			return err
		}
		for _, row := range legacy {
			if row.Purpose == "resource" && (row.State == "receiving" || row.State == "complete") && jsonEqual(row.Resource, encode(resource)) {
				return archiveConflict()
			}
		}
	}
	d, ok := dao.(store.SessionArchiveStagingDAO)
	if !ok {
		return nil
	}
	rows, err := d.ArchiveStagingRecords(ctx, sessionID)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if row.Purpose != "resource" || !jsonEqual(row.Resource, encode(resource)) {
			continue
		}
		if row.State == "receiving" || row.State == "complete" {
			return archiveConflict()
		}
		if row.State == "failed" && row.SuccessorFileID == "" {
			var failure sp.ImageError
			if json.Unmarshal(row.TerminalError, &failure) == nil && failure.Code == "staging_corrupt" {
				return archiveConflict()
			}
		}
	}
	return nil
}
func streamIdentityMatches(v store.ArchiveStagingRecord, purpose, fileID string, length int64, digest string, resource *sp.Resource, bundle store.ArchiveBundle) bool {
	if v.FileID != fileID || v.Purpose != purpose || v.ByteLength != length || v.SHA256 != digest || v.State != "receiving" {
		return false
	}
	if purpose == "resource" && (!jsonEqual(v.Resource, encode(resource)) || v.TimelineRevision < 1 || v.TimelineRevision > bundle.Revision) {
		return false
	}
	return !(purpose == "history" && (bundle.HistoryID != fileID || v.TimelineRevision != bundle.Revision) || purpose == "timeline" && (bundle.TimelineID != fileID || v.TimelineRevision != bundle.Revision))
}

func (op *ArchiveOperation) putArchiveStream(ctx context.Context, purpose, fileID string, offset, length int64, digest string, body io.Reader, resource *sp.Resource) (out sp.ArchiveFileReceipt, result error) {
	op.mu.Lock()
	defer op.mu.Unlock()
	if err := op.check(ArchiveV1Upload); err != nil {
		return out, err
	}
	if op.historyWriter != nil {
		return out, archiveConflict()
	}
	if err := validStreamIdentity(purpose, fileID, offset, length, digest, resource); err != nil {
		return out, err
	}
	if body == nil {
		return out, fault("invalid_input", "Missing archive stream.")
	}
	bound, ok := body.(ArchiveStreamBody)
	if !ok {
		return out, fault("invalid_input", "Archive stream cannot be canceled.")
	}
	ctx, cancel := op.GateContext(ctx)
	defer cancel()
	leaseID := uuid.NewString()
	ctx, finish, err := op.execution.beginImageIO(ctx, op.id, leaseID)
	if err != nil {
		return out, err
	}
	acquired := false
	defer func() {
		result = errors.Join(result, finish())
		if acquired {
			result = errors.Join(result, op.execution.releaseImageLease(context.WithoutCancel(ctx), op.principal, op.project, op.task, op.id, leaseID))
		}
	}()
	unbind := bound.BindReadContext(ctx)
	if unbind == nil {
		return out, fault("capability_error", "Archive stream cancellation is unavailable.")
	}
	defer func() {
		result = archiveCleanupFailure(result, unbind())
		if cause := context.Cause(ctx); cause != nil {
			result = errors.Join(result, cause)
		}
	}()
	var row store.ArchiveStagingRecord
	var exists bool
	err = op.bundleAccess(ctx, func(tx *operationTx, r *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
		if e := archiveStreamPhase(bundle, purpose, resource); e != nil {
			return e
		}
		d, e := archiveStagingDAO(dao)
		if e != nil {
			return e
		}
		row, e = d.ArchiveStagingRecord(ctx, op.id, fileID)
		if e == nil {
			exists = true
			if !streamIdentityMatches(row, purpose, fileID, length, digest, resource, bundle) {
				return archiveConflict()
			}
		} else if errors.Is(e, model.ErrNotFound) {
			if !op.execution.archiveV2RegistrationEnabled || offset != 0 {
				return archiveConflict()
			}
			if purpose == "resource" {
				if e = archiveStreamResourceUnregistered(ctx, dao, op.id, resource, true); e != nil {
					return e
				}
			}
			if _, e = dao.SessionArchiveFile(ctx, op.id, fileID); e == nil {
				return archiveConflict()
			} else if !errors.Is(e, model.ErrNotFound) {
				return e
			}
			if purpose == "timeline" && bundle.TimelineID != "" && bundle.TimelineID != fileID {
				return archiveConflict()
			}
			if purpose == "history" && bundle.HistoryID != "" && bundle.HistoryID != fileID {
				previous, e := archiveFileAny(ctx, dao, op.id, bundle.HistoryID)
				if e != nil {
					return e
				}
				if previous.State != "complete" && previous.State != "failed" || previous.UploadVersion == 2 && previous.State == "failed" {
					return archiveConflict()
				}
				media, e := archiveMediaDAO(tx)
				if e != nil {
					return e
				}
				n, e := media.SessionResourceLeaseCount(ctx, op.id)
				if e != nil {
					return e
				}
				if n != 0 {
					return archiveConflict()
				}
			}
		} else {
			return e
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
		return acquireImageResourceLease(ctx, media, store.SessionResourceLease{SessionID: op.id, ID: leaseID, Kind: "archive", OwnerID: op.owner, DeleteEpoch: usage.DeleteEpoch})
	})
	if err != nil {
		return out, err
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
	handle, err := backend.AcquireArchiveStaging(ctx, namespace, !exists)
	if err != nil {
		if exists && stagingCorrupt(err) {
			return out, &ArchiveStagingCorruptError{Receipt: stagingReceipt(row, 0)}
		}
		return out, stagingBusy(err)
	}
	defer func() { result = archiveCleanupFailure(result, handle.Close()) }()
	// Recheck the original writer and exact identity after obtaining physical exclusion.
	err = op.bundleAccess(ctx, func(_ *operationTx, _ *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
		if e := archiveStreamPhase(bundle, purpose, resource); e != nil {
			return e
		}
		d, e := archiveStagingDAO(dao)
		if e != nil {
			return e
		}
		current, e := d.ArchiveStagingRecord(ctx, op.id, fileID)
		if exists {
			if e != nil {
				return e
			}
			if !streamIdentityMatches(current, purpose, fileID, length, digest, resource, bundle) {
				return archiveConflict()
			}
			row = current
			return nil
		}
		if e == nil {
			return archiveConflict()
		}
		if !errors.Is(e, model.ErrNotFound) {
			return e
		}
		if !op.execution.archiveV2RegistrationEnabled {
			return archiveConflict()
		}
		if purpose == "resource" {
			if e = archiveStreamResourceUnregistered(ctx, dao, op.id, resource, true); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return out, err
	}
	if !exists {
		err = handle.Create(ctx, fileID)
		if errors.Is(err, fs.ErrExist) {
			err = handle.AdoptEmpty(ctx, fileID)
		}
		if err != nil {
			return out, err
		}
		err = op.bundleAccess(ctx, func(_ *operationTx, r *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
			if e := archiveStreamPhase(bundle, purpose, resource); e != nil {
				return e
			}
			if !op.execution.archiveV2RegistrationEnabled {
				return archiveConflict()
			}
			if purpose == "resource" {
				if e := archiveStreamResourceUnregistered(ctx, dao, op.id, resource, true); e != nil {
					return e
				}
			}
			d, e := archiveStagingDAO(dao)
			if e != nil {
				return e
			}
			if _, e = d.ArchiveStagingRecord(ctx, op.id, fileID); e == nil {
				return archiveConflict()
			} else if !errors.Is(e, model.ErrNotFound) {
				return e
			}
			if purpose == "timeline" && bundle.TimelineID != "" && bundle.TimelineID != fileID {
				return archiveConflict()
			}
			if purpose == "history" && bundle.HistoryID != "" && bundle.HistoryID != fileID {
				prev, e := archiveFileAny(ctx, dao, op.id, bundle.HistoryID)
				if e != nil {
					return e
				}
				if prev.State != "complete" && prev.State != "failed" || prev.UploadVersion == 2 && prev.State == "failed" {
					return archiveConflict()
				}
				bundle.Revision++
			}
			row = store.ArchiveStagingRecord{SessionID: op.id, FileID: fileID, Purpose: purpose, SHA256: digest, State: "receiving", ByteLength: length, TimelineRevision: bundle.Revision, Path: namespace.Directory() + "/files/" + fileID}
			if purpose == "history" {
				row.Resource = encode(historySourceIdentity{SourceEpoch: sourceEpoch(r)})
			} else if purpose == "resource" {
				row.Resource = encode(resource)
				row.Path, e = BlobAddress(op.project, op.owner, op.id, fileID)
				if e != nil {
					return e
				}
			}
			inserted, e := d.InsertArchiveStaging(ctx, row)
			if e != nil {
				return e
			}
			if !inserted {
				return archiveConflict()
			}
			if purpose == "history" {
				bundle.HistoryID = fileID
			} else if purpose == "timeline" {
				bundle.TimelineID = fileID
			}
			return dao.SaveSessionArchiveBundle(ctx, bundle)
		})
		if err != nil {
			return out, err
		}
		op.markCommit(nil)
	}
	actual, err := handle.Observe(ctx, fileID, length)
	if err != nil {
		if stagingCorrupt(err) {
			return out, &ArchiveStagingCorruptError{Receipt: stagingReceipt(row, 0)}
		}
		return out, err
	}
	if actual != offset {
		return out, archiveConflict()
	}
	buffer := make([]byte, sessionarchive.BlockSize)
	for actual < length {
		size := min(int64(len(buffer)), length-actual)
		if _, err = io.ReadFull(body, buffer[:size]); err != nil {
			return out, err
		}
		actual, err = handle.Append(ctx, fileID, length, actual, buffer[:size])
		if err != nil {
			return out, err
		}
	}
	var extra [1]byte
	n, readErr := io.ReadFull(body, extra[:])
	if n != 0 {
		return out, fault("invalid_input", "Archive stream exceeds declared length.")
	}
	if !errors.Is(readErr, io.EOF) {
		return out, readErr
	}
	if err = context.Cause(ctx); err != nil {
		return out, err
	}
	return stagingReceipt(row, actual), nil
}
