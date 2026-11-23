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
	"log/slog"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

var errArchiveStagingCorrupt = errors.New("archive staging is corrupt")

// v2Assembly reads at most one block into memory. Returning an integrity error
// before EOF prevents the storage Put from publishing its temporary object.
type v2Assembly struct {
	ctx       context.Context
	files     filestorage.Storage
	namespace sessionarchive.Namespace
	file      store.ArchiveBundleFile
	offset    int64
	buffer    []byte
	proof     [sha256.Size]byte
	hash      io.Writer
	sum       interface{ Sum([]byte) []byte }
	done      bool
}

func (r *v2Assembly) Read(p []byte) (int, error) {
	if len(r.buffer) > 0 {
		n := copy(p, r.buffer)
		r.buffer = r.buffer[n:]
		return n, nil
	}
	if r.done {
		return 0, io.EOF
	}
	if r.offset == r.file.ByteLength {
		r.done = true
		if !bytes.Equal(r.proof[:], r.file.PrefixProof) {
			return 0, errArchiveStagingCorrupt
		}
		if hex.EncodeToString(r.sum.Sum(nil)) != r.file.SHA256 {
			return 0, invalidArchiveFile(errors.New("archive file integrity check failed"))
		}
		return 0, io.EOF
	}
	path, err := r.namespace.BlockPath(r.file.FileID, r.offset)
	if err != nil {
		return 0, err
	}
	obj, err := r.files.Open(r.ctx, archiveBucket, path)
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, model.ErrNotFound) || errors.Is(err, filestorage.ErrNotRegular) || errors.Is(err, filestorage.ErrPathConflict) {
		return 0, errArchiveStagingCorrupt
	}
	if err != nil {
		return 0, err
	}
	size := sessionarchive.BlockSize
	if remaining := r.file.ByteLength - r.offset; remaining < size {
		size = remaining
	}
	data, readErr := io.ReadAll(io.LimitReader(obj.Body, size+1))
	err = errors.Join(readErr, obj.Body.Close())
	if err != nil {
		return 0, err
	}
	if int64(len(data)) != size {
		return 0, errArchiveStagingCorrupt
	}
	digest := sha256.Sum256(data)
	r.proof = sessionarchive.AdvancePrefixProof(r.proof, uint64(r.offset), uint32(size), digest)
	_, _ = r.hash.Write(data)
	r.offset += size
	r.buffer = data
	return r.Read(p)
}

func (op *ArchiveOperation) assembleArchiveV2(ctx context.Context, file store.ArchiveBundleFile) error {
	namespace, err := archiveNamespace(op.project, op.owner, op.id)
	if err != nil {
		return err
	}
	hash := sha256.New()
	input := &v2Assembly{ctx: ctx, files: op.execution.files, namespace: namespace, file: file, proof: sessionarchive.InitialPrefixProof(), hash: hash, sum: hash}
	info, err := op.execution.files.Put(ctx, archiveFileBucket(file), archiveFilePath(file), input)
	if err != nil {
		return err
	}
	if info.Size != file.ByteLength {
		return errors.New("archive file storage length mismatch")
	}
	return nil
}

func (op *ArchiveOperation) failArchiveStaging(ctx context.Context, file store.ArchiveBundleFile, epoch int64) error {
	return op.bundleAccess(ctx, func(tx *operationTx, _ *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
		media, err := archiveMediaDAO(tx)
		if err != nil {
			return err
		}
		usage, err := media.SessionResourceUsage(ctx, op.id)
		if err != nil {
			return err
		}
		if usage.Deleting || usage.DeleteEpoch != epoch {
			return conflict()
		}
		current, err := dao.SessionArchiveFile(ctx, op.id, file.FileID)
		if err != nil {
			return err
		}
		if current.UploadVersion != 2 || current.State != "receiving" || current.AcceptedOffset != file.AcceptedOffset || !bytes.Equal(current.PrefixProof, file.PrefixProof) || current.SHA256 != file.SHA256 || current.ByteLength != file.ByteLength || current.TimelineRevision != file.TimelineRevision || (file.Purpose == "history" && bundle.HistoryID != file.FileID) || (file.Purpose == "timeline" && bundle.TimelineID != file.FileID) {
			return archiveConflict()
		}
		next := current
		next.State = "failed"
		next.TerminalError = encode(sp.ImageError{Code: "staging_corrupt", Message: "Archive staging is corrupt."})
		v2, ok := dao.(store.SessionArchiveV2DAO)
		if !ok {
			return errors.New("archive v2 storage unavailable")
		}
		return v2.CompareAndSwapSessionArchiveFile(ctx, current, next)
	})
}

func archiveResourceInLedger(bundle store.ArchiveBundle, raw json.RawMessage) bool {
	var ledger archiveLedger
	if json.Unmarshal(bundle.Ledger, &ledger) != nil {
		return false
	}
	for _, resource := range ledger.Resources {
		if jsonEqual(raw, encode(resource)) {
			return true
		}
	}
	return false
}

func archiveV2Purpose(requested, actual string) bool {
	return requested == actual || requested == "timeline" && actual == "resource"
}

func (op *ArchiveOperation) CompleteArchiveFile(ctx context.Context, purpose, fileID string) (out sp.ArchiveFileReceipt, err error) {
	op.mu.Lock()
	defer op.mu.Unlock()
	if err = op.check(ArchiveV1Upload); err != nil {
		return out, err
	}
	ctx, cancel := op.GateContext(ctx)
	defer cancel()
	leaseID := uuid.NewString()
	archiveCtx := ctx
	ctx, finish, err := op.execution.beginImageIO(ctx, op.id, leaseID)
	if err != nil {
		return out, err
	}
	var file store.ArchiveBundleFile
	var epoch int64
	var inventoryRequired, acquired, terminalKnown bool
	var resource *sp.Resource
	defer func() {
		if invalid := definiteArchiveValidation(err); invalid != nil {
			cleanup, cancel := filestorage.GateCleanupContext(ctx)
			failureErr := op.failArchiveFile(cleanup, file, invalid.cause)
			cancel()
			if failureErr == nil && file.FileID != "" {
				terminalKnown = true
			}
			err = errors.Join(err, failureErr)
		}
		finishErr := finish()
		err = errors.Join(err, finishErr)
		var releaseErr error
		if acquired {
			releaseErr = op.execution.releaseImageLease(context.WithoutCancel(ctx), op.principal, op.project, op.task, op.id, leaseID)
			err = errors.Join(err, releaseErr)
		}
		if finishErr == nil && releaseErr == nil && terminalKnown {
			cleanup, cancel := filestorage.GateCleanupContext(archiveCtx)
			cleanupErr := op.cleanupV2Terminal(cleanup)
			cancel()
			if cleanupErr != nil {
				slog.ErrorContext(ctx, "Archive staging cleanup failed", "session_id", op.id, "file_id", fileID, "error", cleanupErr)
			}
		}
	}()
	err = op.bundleAccess(ctx, func(tx *operationTx, _ *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
		var e error
		file, e = dao.SessionArchiveFile(ctx, op.id, fileID)
		if e != nil {
			return e
		}
		if file.UploadVersion != 2 || !archiveV2Purpose(purpose, file.Purpose) {
			return archiveConflict()
		}
		if file.State == "complete" || file.State == "failed" {
			return nil
		}
		if file.State != "receiving" || file.AcceptedOffset != file.ByteLength || file.Purpose == "history" && (bundle.Phase != "settling" || bundle.HistoryID != fileID) || file.Purpose == "timeline" && (bundle.Phase != "sealed" || bundle.TimelineID != fileID || bundle.Revision != file.TimelineRevision) || file.Purpose == "resource" && bundle.Phase != "settling" {
			return archiveConflict()
		}
		if file.Purpose == "resource" {
			if file.TimelineRevision < 1 || file.TimelineRevision > bundle.Revision || !archiveResourceInLedger(bundle, file.Resource) {
				return archiveConflict()
			}
			var value sp.Resource
			if json.Unmarshal(file.Resource, &value) != nil {
				return archiveConflict()
			}
			resource = &value
		}
		if file.Purpose == "history" {
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
	if file.State != "receiving" {
		terminalKnown = true
		return fileReceipt(file), nil
	}
	acquired = true
	if err = op.assembleArchiveV2(ctx, file); err != nil {
		if errors.Is(err, errArchiveStagingCorrupt) {
			failureErr := op.failArchiveStaging(ctx, file, epoch)
			terminalKnown = failureErr == nil
			err = errors.Join(err, failureErr)
		}
		return out, err
	}
	if err = op.publishArchiveFile(ctx, &file, epoch, inventoryRequired, resource); err != nil {
		return out, err
	}
	terminalKnown = true
	op.markCommit(nil)
	return fileReceipt(file), nil
}

// cleanupV2Terminal never treats GET as a cleanup opportunity. The Session
// permit and absence of durable archive leases fence previous writers.
func (op *ArchiveOperation) cleanupV2Terminal(ctx context.Context) error {
	var files []store.ArchiveBundleFile
	err := op.bundleAccess(ctx, func(tx *operationTx, _ *record, dao store.SessionArchiveDAO, _ store.ArchiveBundle) error {
		all, err := dao.SessionArchiveFiles(ctx, op.id)
		if err != nil {
			return err
		}
		media, err := archiveMediaDAO(tx)
		if err != nil {
			return err
		}
		leases, err := media.ListSessionResourceLeases(ctx, op.id)
		if err != nil {
			return err
		}
		for _, lease := range leases {
			if lease.Kind == "archive" {
				return nil
			}
		}
		for _, file := range all {
			if file.UploadVersion == 2 && !file.StagingReleased && (file.State == "complete" || file.State == "failed") {
				files = append(files, file)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	namespace, err := archiveNamespace(op.project, op.owner, op.id)
	if err != nil {
		return err
	}
	var result error
	for _, file := range files {
		result = errors.Join(result, op.cleanupV2File(ctx, namespace, file))
	}
	return result
}

func (op *ArchiveOperation) cleanupV2File(ctx context.Context, namespace sessionarchive.Namespace, file store.ArchiveBundleFile) error {
	blocks, ok := op.execution.files.(filestorage.ArchiveBlockDeleter)
	if !ok {
		return errors.New("durable archive block deletion unavailable")
	}
	for offset := int64(0); offset < file.AcceptedOffset; offset += sessionarchive.BlockSize {
		if err := blocks.DeleteArchiveBlock(ctx, namespace, file.FileID, offset); err != nil {
			return err
		}
	}
	// The next block can be durable even if its database transaction was lost.
	if file.AcceptedOffset < file.ByteLength {
		if err := blocks.DeleteArchiveBlock(ctx, namespace, file.FileID, file.AcceptedOffset); err != nil {
			return err
		}
	}
	if file.Purpose == "history" || file.State == "failed" {
		staging, ok := op.execution.files.(filestorage.ArchiveStagingDeleter)
		if !ok {
			return errors.New("durable archive staging deletion unavailable")
		}
		if err := staging.DeleteArchiveStaging(ctx, archiveFileBucket(file), archiveFilePath(file)); err != nil {
			return err
		}
	}
	err := op.bundleAccess(ctx, func(_ *operationTx, _ *record, dao store.SessionArchiveDAO, _ store.ArchiveBundle) error {
		current, err := dao.SessionArchiveFile(ctx, op.id, file.FileID)
		if err != nil {
			return err
		}
		if current.UploadVersion != 2 || current.State != file.State || current.SHA256 != file.SHA256 || current.AcceptedOffset != file.AcceptedOffset {
			return archiveConflict()
		}
		if current.StagingReleased {
			return nil
		}
		next := current
		next.StagingReleased = true
		v2, ok := dao.(store.SessionArchiveV2DAO)
		if !ok {
			return errors.New("archive v2 storage unavailable")
		}
		return v2.CompareAndSwapSessionArchiveFile(ctx, current, next)
	})
	if err != nil {
		return err
	}
	return nil
}

func (op *ArchiveOperation) RestartArchiveFile(ctx context.Context, purpose, fileID, replacementFileID string) (out sp.ArchiveFileReceipt, err error) {
	op.mu.Lock()
	defer op.mu.Unlock()
	if err = op.check(ArchiveV1Upload); err != nil {
		return out, err
	}
	ctx, cancel := op.GateContext(ctx)
	defer cancel()
	canonical, e := model.CanonicalID(replacementFileID)
	if e != nil || canonical != replacementFileID || replacementFileID == fileID {
		return out, fault("invalid_input", "Invalid replacement archive file identity.")
	}
	err = op.bundleAccess(ctx, func(tx *operationTx, _ *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
		old, e := dao.SessionArchiveFile(ctx, op.id, fileID)
		if e != nil {
			return e
		}
		if old.UploadVersion != 2 || old.State != "failed" || !archiveV2Purpose(purpose, old.Purpose) {
			return archiveConflict()
		}
		var reason sp.ImageError
		if json.Unmarshal(old.TerminalError, &reason) != nil || reason.Code != "staging_corrupt" {
			return archiveConflict()
		}
		if old.SuccessorFileID != "" {
			if old.SuccessorFileID != replacementFileID {
				return archiveConflict()
			}
			out = fileReceipt(old)
			return nil
		}
		if old.Purpose == "history" && (bundle.Phase != "settling" || bundle.HistoryID != fileID) || old.Purpose == "timeline" && (bundle.Phase != "sealed" || bundle.TimelineID != fileID || bundle.Revision != old.TimelineRevision) || old.Purpose == "resource" && (bundle.Phase != "settling" || old.TimelineRevision < 1 || old.TimelineRevision > bundle.Revision || !archiveResourceInLedger(bundle, old.Resource)) {
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
				return conflict()
			}
		}
		_, e = dao.SessionArchiveFile(ctx, op.id, replacementFileID)
		if e == nil {
			return archiveConflict()
		}
		if !errors.Is(e, model.ErrNotFound) {
			return e
		}
		namespace, e := archiveNamespace(op.project, op.owner, op.id)
		if e != nil {
			return e
		}
		next := old
		next.FileID = replacementFileID
		next.State = "receiving"
		next.AcceptedOffset = 0
		next.SuccessorFileID = ""
		next.TerminalError = nil
		next.StagingReleased = false
		proof := sessionarchive.InitialPrefixProof()
		next.PrefixProof = proof[:]
		next.Path = namespace.Directory() + "/files/" + replacementFileID
		if next.Purpose == "resource" {
			next.Path, e = BlobAddress(op.project, op.owner, op.id, replacementFileID)
			if e != nil {
				return e
			}
		}
		if e = dao.SaveSessionArchiveFile(ctx, next); e != nil {
			return e
		}
		updated := old
		updated.SuccessorFileID = replacementFileID
		v2, ok := dao.(store.SessionArchiveV2DAO)
		if !ok {
			return errors.New("archive v2 storage unavailable")
		}
		if e = v2.CompareAndSwapSessionArchiveFile(ctx, old, updated); e != nil {
			return e
		}
		if old.Purpose == "history" {
			bundle.HistoryID = replacementFileID
		} else if old.Purpose == "timeline" {
			bundle.TimelineID = replacementFileID
		}
		if e = dao.SaveSessionArchiveBundle(ctx, bundle); e != nil {
			return e
		}
		out = fileReceipt(updated)
		return nil
	})
	if err == nil {
		op.markCommit(nil)
		if cleanupErr := op.cleanupV2Terminal(ctx); cleanupErr != nil {
			slog.ErrorContext(ctx, "Archive staging cleanup failed", "session_id", op.id, "file_id", fileID, "error", cleanupErr)
		}
	}
	return
}
