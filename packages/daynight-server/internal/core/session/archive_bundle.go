package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

const archiveChunkBytes = 1048576

// This documents the upper bound implied by existing collection geometry; it is
// not a separate admission limit on accepted content.
const maxArchiveLedgerBytes = 64 * 1024 * 1024
const maxArchiveHistoryOccurrences = 100000

type archiveValidationError struct{ cause error }

func (e *archiveValidationError) Error() string                { return "Archive file validation failed." }
func (e *archiveValidationError) Unwrap() error                { return e.cause }
func (e *archiveValidationError) PreserveSessionRefusal() bool { return e != nil && e.cause != nil }
func invalidArchiveFile(cause error) error                     { return &archiveValidationError{cause: cause} }

func archiveContentFailure(err error) error {
	var capacity *contentCapacityError
	if errors.As(err, &capacity) {
		return invalidArchiveFile(err)
	}
	return err
}

func definiteArchiveValidation(err error) *archiveValidationError {
	if err == nil {
		return nil
	}
	if tx, ok := err.(*store.TransactionError); ok {
		if tx.Outcome != store.TransactionNotCommitted || tx.CommitAttempted || tx.CleanupFailed {
			return nil
		}
		return definiteArchiveValidation(tx.Cause)
	}
	if invalid, ok := err.(*archiveValidationError); ok {
		return invalid
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		children := joined.Unwrap()
		if len(children) != 1 {
			return nil
		}
		return definiteArchiveValidation(children[0])
	}
	return definiteArchiveValidation(errors.Unwrap(err))
}

type archiveLedgerEntry struct {
	ID           string `json:"i"`
	Sequence     string `json:"s"`
	Revision     string `json:"r"`
	SHA256       string `json:"h"`
	SourceSHA256 string `json:"o"`
	ByteLength   int    `json:"b"`
}
type archiveLedger struct {
	HistoryEpoch, SourceThrough, HistoryID string
	FinalSourceThrough                     string `json:",omitempty"`
	FinalHistoryEpoch                      string `json:",omitempty"`
	SourceEpoch, TargetSourceEpoch         string `json:",omitempty"`
	Sealable                               bool
	Entries                                []archiveLedgerEntry
	Resources                              []sp.Resource
	Occurrences                            []archiveLedgerOccurrence
}

func (l archiveLedger) latestHistoryEpoch() string {
	if l.FinalHistoryEpoch != "" {
		return l.FinalHistoryEpoch
	}
	return l.HistoryEpoch
}

func archiveDigest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func archiveConflict() error {
	return fault("archive_conflict", "Archive identity or content no longer matches.")
}
func makeArchiveLedger(history sp.ArchiveHistoryContent, epoch string, through int64) (archiveLedger, error) {
	if history.HistoryEpoch != epoch || history.SourceThrough != decimal(through) {
		return archiveLedger{}, archiveConflict()
	}
	refs, _, err := sp.ArchiveHistoryReferences(history.Entries)
	if err != nil {
		return archiveLedger{}, fault("archive_incomplete", "Archive projection is incomplete.")
	}
	if len(refs) != len(history.Resources) {
		return archiveLedger{}, archiveConflict()
	}
	for _, resource := range history.Resources {
		if !refs[resource.ResourceID] {
			return archiveLedger{}, archiveConflict()
		}
	}
	result := archiveLedger{HistoryEpoch: epoch, SourceThrough: history.SourceThrough, Entries: []archiveLedgerEntry{}, Resources: history.Resources}
	_, _, projectionErr := sp.ArchiveReferences(history.Entries)
	result.Sealable = projectionErr == nil
	result.Occurrences, err = archiveHistoryOccurrences(history.Entries)
	if err != nil {
		return archiveLedger{}, err
	}
	for _, entry := range history.Entries {
		data, err := sp.MarshalWire(entry)
		if err != nil {
			return archiveLedger{}, err
		}
		result.Entries = append(result.Entries, archiveLedgerEntry{ID: entry.EntryID, Sequence: entry.EntrySeq, Revision: entry.Revision, SHA256: archiveDigest(data), SourceSHA256: archiveSourceDigest(data), ByteLength: len(data)})
	}
	if len(encode(result.Resources)) > sp.MaxArchiveManifestBytes {
		return archiveLedger{}, fault("quota_exceeded", "Complete history metadata exceeds its durable budget.")
	}
	return result, nil
}

// PostgreSQL jsonb adds one space after structural commas and colons. Its
// normalization of escaped strings never exceeds this canonical JSON bound.
func archiveLedgerStorageBytes(data []byte) int {
	size, quoted, escaped := len(data), false, false
	for _, c := range data {
		if quoted {
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				quoted = false
			}
			continue
		}
		if c == '"' {
			quoted = true
		} else if c == ',' || c == ':' {
			size++
		}
	}
	return size
}
func verifyArchiveLedger(ledger archiveLedger, timeline sp.ArchiveTimeline) error {
	if len(ledger.Entries) != len(timeline.Entries) {
		return archiveConflict()
	}
	for i, entry := range timeline.Entries {
		data, err := sp.MarshalWire(entry)
		if err != nil {
			return err
		}
		want := ledger.Entries[i]
		if want.ID != entry.EntryID || want.Sequence != entry.EntrySeq || want.Revision != entry.Revision || want.ByteLength != len(data) || want.SHA256 != archiveDigest(data) {
			return archiveConflict()
		}
	}
	return nil
}
func putArchiveChunk(ctx context.Context, files filestorage.Storage, path string, data []byte, digest string) error {
	if len(data) < 1 || len(data) > archiveChunkBytes || archiveDigest(data) != digest {
		return fault("invalid_input", "Invalid archive chunk.")
	}
	info, err := files.Put(ctx, archiveBucket, path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	if info.Size != int64(len(data)) {
		return errors.New("archive chunk storage length mismatch")
	}
	return nil
}
func verifyArchiveChunk(ctx context.Context, files filestorage.Storage, path string, data []byte) (result error) {
	object, err := files.Open(ctx, archiveBucket, path)
	if err != nil {
		return err
	}
	defer func() { result = archiveCleanupFailure(result, object.Body.Close()) }()
	actual, err := io.ReadAll(io.LimitReader(object.Body, archiveChunkBytes+1))
	if err != nil {
		return err
	}
	if !bytes.Equal(actual, data) {
		return archiveConflict()
	}
	return nil
}
func archiveDAO(tx *operationTx) (store.SessionArchiveDAO, error) {
	dao, ok := tx.dao.(store.SessionArchiveDAO)
	if !ok {
		return nil, errors.New("unified archive storage unavailable")
	}
	return dao, nil
}
func archiveMediaDAO(tx *operationTx) (store.SessionResourceDAO, error) {
	dao, ok := tx.dao.(store.SessionResourceDAO)
	if !ok {
		return nil, errors.New("archive resource storage unavailable")
	}
	return dao, nil
}
func archiveStopped(r *record, t task) error {
	if r.Snapshot.TestExecutionID != "" {
		if r.Snapshot.Lifecycle != "archived" {
			return conflict()
		}
	} else if active(t, r) || (r.Snapshot.Lifecycle == "active" && !t.Deleted && t.Status == "in_progress") {
		return conflict()
	}
	return nil
}
func bundleReceipt(bundle store.ArchiveBundle) sp.ArchivePrepareReceipt {
	refs := []sp.ArchiveResourceReference{}
	var revision *string
	phase := bundle.Phase
	if phase == "committed" || phase == "verified" {
		phase = "sealed"
	}
	if phase == "sealed" {
		_ = json.Unmarshal(bundle.Resources, &refs)
		value := decimal(bundle.Revision)
		revision = &value
	}
	var ledger archiveLedger
	_ = json.Unmarshal(bundle.Ledger, &ledger)
	out := sp.ArchivePrepareReceipt{RecordID: bundle.SessionID, Phase: phase, Resources: refs, TimelineRevision: revision, HistoryEpoch: ledger.latestHistoryEpoch(), SourceThrough: ledger.SourceThrough}
	if ledger.FinalSourceThrough != "" {
		out.SourceThrough = ledger.FinalSourceThrough
	}
	if phase == "failed" {
		out.Error = &sp.ImageError{Code: "archive_incomplete", Message: "Archive file validation failed."}
	}
	return out
}
func fileReceipt(file store.ArchiveBundleFile) sp.ArchiveFileReceipt {
	result := sp.ArchiveFileReceipt{FileID: file.FileID, State: file.State, AcceptedOffset: decimal(file.AcceptedOffset), ByteLength: decimal(file.ByteLength), SHA256: file.SHA256}
	if file.State == "failed" {
		result.Error = &sp.ImageError{Code: "archive_incomplete", Message: "Archive file validation failed."}
		var saved struct {
			Failure *sp.ImageError `json:"failure"`
		}
		if json.Unmarshal(file.Resource, &saved) == nil && saved.Failure != nil && saved.Failure.Code == "quota_exceeded" {
			result.Error = saved.Failure
		}
	}
	if file.State == "complete" {
		revision := decimal(file.TimelineRevision)
		if revision == "0" {
			revision = "1"
		}
		result.TimelineRevision = &revision
	}
	return result
}
func (op *ArchiveOperation) bundleAccess(ctx context.Context, fn func(*operationTx, *record, store.SessionArchiveDAO, store.ArchiveBundle) error) error {
	return op.execution.archiveAccess(ctx, op.principal, op.project, op.task, op.id, true, func(tx *operationTx, r *record, t task) error {
		if r.Owner != op.owner {
			return conflict()
		}
		if op.historyWriter != nil {
			if err := op.validateHistoryWriter(r, t); err != nil {
				return err
			}
		} else if err := archiveStopped(r, t); err != nil {
			return err
		}
		dao, err := archiveDAO(tx)
		if err != nil {
			return err
		}
		bundle, err := dao.SessionArchiveBundle(ctx, op.id)
		if err != nil {
			return err
		}
		var identity sp.ArchivePrepareRequest
		if json.Unmarshal(bundle.Identity, &identity) != nil {
			return errors.New("invalid persisted archive identity")
		}
		if err := archiveWriter(op.principal, r, identity.Fence, identity.ControllerID, identity.ControllerInstanceID); err != nil {
			return err
		}
		return fn(tx, r, dao, bundle)
	})
}
func (op *ArchiveOperation) PrepareArchive(ctx context.Context, in sp.ArchivePrepareRequest) (out sp.ArchivePrepareReceipt, err error) {
	op.mu.Lock()
	defer op.mu.Unlock()
	if err = op.check(ArchiveV1Upload); err != nil {
		return out, err
	}
	if _, err = sp.DecodeArchivePrepareRequest(encode(in)); err != nil {
		return out, fault("invalid_input", "Invalid archive preparation.")
	}
	if err = op.SettleExpiredUploads(ctx); err != nil {
		return out, err
	}
	identity := in
	identity.ExpectedTimelineRevision = ""
	identity.FailedFileID = ""
	err = op.execution.archiveAccess(ctx, op.principal, op.project, op.task, op.id, true, func(tx *operationTx, r *record, t task) error {
		if r.Owner != op.owner {
			return conflict()
		}
		if err := archiveWriter(op.principal, r, in.Fence, in.ControllerID, in.ControllerInstanceID); err != nil {
			return err
		}
		if err := archiveStopped(r, t); err != nil {
			return err
		}
		dao, err := archiveDAO(tx)
		if err != nil {
			return err
		}
		bundle, err := dao.SessionArchiveBundle(ctx, op.id)
		if errors.Is(err, model.ErrNotFound) {
			if in.FailedFileID != "" {
				return archiveConflict()
			}
			bundle = store.ArchiveBundle{SessionID: op.id, PrepareID: in.ControllerInstanceID, Phase: "settling", Revision: 1, Identity: encode(identity), Resources: json.RawMessage(`[]`), Ledger: encode(archiveLedger{HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: decimal(r.SourceSeq), Entries: []archiveLedgerEntry{}, Resources: []sp.Resource{}})}
			if err = dao.SaveSessionArchiveBundle(ctx, bundle); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		if !jsonEqual(bundle.Identity, encode(identity)) {
			return archiveConflict()
		}
		if bundle.Phase == "active" {
			if e := settleActiveHistory(ctx, tx, dao, &bundle, r); e != nil {
				return e
			}
		}
		if in.FailedFileID != "" {
			if err = resetArchivePreparation(ctx, tx, dao, &bundle, in); err != nil {
				return err
			}
		}
		out = bundleReceipt(bundle)
		return nil
	})
	op.markCommit(err)
	return out, err
}
func (s *Execution) ArchivePreparation(ctx context.Context, p model.Principal, project, taskID, id string) (out sp.ArchivePrepareReceipt, err error) {
	err = s.archiveAccess(ctx, p, project, taskID, id, true, func(tx *operationTx, r *record, t task) error {
		if p.Kind != model.PATCredential || p.UserID != r.Owner {
			return denied()
		}
		dao, e := archiveDAO(tx)
		if e != nil {
			return e
		}
		bundle, e := dao.SessionArchiveBundle(ctx, id)
		if e != nil {
			return e
		}
		if e = observeArchivePreparation(p, r, t, bundle); e != nil {
			return e
		}
		out = bundleReceipt(bundle)
		return nil
	})
	return
}
func (s *Execution) ArchiveFileStatus(ctx context.Context, p model.Principal, project, taskID, id, fileID string) (out sp.ArchiveFileReceipt, err error) {
	err = s.archiveAccess(ctx, p, project, taskID, id, true, func(tx *operationTx, r *record, t task) error {
		if p.Kind != model.PATCredential || p.UserID != r.Owner {
			return denied()
		}
		dao, e := archiveDAO(tx)
		if e != nil {
			return e
		}
		bundle, e := dao.SessionArchiveBundle(ctx, id)
		if e != nil {
			return e
		}
		if e = observeArchivePreparation(p, r, t, bundle); e != nil {
			return e
		}
		file, e := dao.SessionArchiveFile(ctx, id, fileID)
		if e != nil {
			return e
		}
		out = fileReceipt(file)
		return nil
	})
	return
}

// PutArchiveFile persists each immutable chunk before acknowledging its offset.
// A lost SQL result is reconciled with the original file ID, never a new file.
func (op *ArchiveOperation) PutArchiveFile(ctx context.Context, purpose, fileID string, offset, length int64, digest, chunkDigest string, data []byte) (sp.ArchiveFileReceipt, error) {
	return op.putArchiveFile(ctx, purpose, fileID, offset, length, digest, chunkDigest, data, nil)
}
func (op *ArchiveOperation) PutArchiveResource(ctx context.Context, fileID string, offset, length int64, digest, chunkDigest string, data []byte, resource sp.Resource) (sp.ArchiveFileReceipt, error) {
	return op.putArchiveFile(ctx, "resource", fileID, offset, length, digest, chunkDigest, data, &resource)
}
func (op *ArchiveOperation) putArchiveFile(ctx context.Context, purpose, fileID string, offset, length int64, digest, chunkDigest string, data []byte, resource *sp.Resource) (out sp.ArchiveFileReceipt, err error) {
	op.mu.Lock()
	defer op.mu.Unlock()
	if err = op.check(ArchiveV1Upload); err != nil {
		return out, err
	}
	limit := int64(sp.MaxArchiveTimelineBytes)
	if purpose == "history" {
		limit = sp.MaxArchiveHistoryBytes
	} else if purpose == "resource" {
		limit = sp.MaxArchiveBlobBytes
		if resource == nil || resource.Revision != "" || resource.Status != "available" || resource.ByteLength == nil || resource.SHA256 == nil || *resource.ByteLength != decimal(length) || *resource.SHA256 != digest {
			return out, archiveConflict()
		}
	} else if purpose != "timeline" {
		return out, archiveConflict()
	}
	canonical, e := model.CanonicalID(fileID)
	_, digestErr := hex.DecodeString(digest)
	emptyLegacy := purpose == "resource" && length == 0 && offset == 0 && len(data) == 0 && digest == archiveDigest(nil)
	if digestErr != nil || len(digest) != 64 || strings.ToLower(digest) != digest || e != nil || canonical != fileID || offset < 0 || (length < 1 || len(data) < 1) && !emptyLegacy || length > limit || len(data) > archiveChunkBytes || offset+int64(len(data)) > length || archiveDigest(data) != chunkDigest {
		return out, fault("invalid_input", "Invalid archive file chunk.")
	}
	var file store.ArchiveBundleFile
	var chunk store.ArchiveBundleChunk
	var epoch int64
	leaseID := uuid.NewString()
	var finish func() error
	ctx, finish, err = op.execution.beginImageIO(ctx, op.id, leaseID)
	if err != nil {
		return out, err
	}
	leaseAcquired := false
	defer func() {
		if invalid := definiteArchiveValidation(err); invalid != nil {
			err = errors.Join(err, op.failArchiveFile(context.WithoutCancel(ctx), file, invalid.cause))
		}
		err = joinImageCleanup(err, finish)
		if leaseAcquired {
			releaseErr := op.execution.releaseImageLease(context.WithoutCancel(ctx), op.principal, op.project, op.task, op.id, leaseID)
			err = errors.Join(err, releaseErr)
			if purpose == "history" && releaseErr == nil {
				cleanupErr := op.cleanupRetiredHistory(context.WithoutCancel(ctx))
				if err != nil {
					err = errors.Join(err, cleanupErr)
				} else if cleanupErr != nil {
					slog.ErrorContext(ctx, "Retired Session history cleanup failed", "session_id", op.id, "error", cleanupErr)
				}
			}
		}
	}()
	if purpose == "history" {
		if err = op.cleanupRetiredHistory(ctx); err != nil {
			return out, err
		}
	}
	duplicate := false
	err = op.bundleAccess(ctx, func(tx *operationTx, r *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
		if (purpose == "history" && bundle.Phase != "active" || purpose == "resource") && bundle.Phase != "settling" || purpose == "timeline" && bundle.Phase != "sealed" {
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
		epoch = usage.DeleteEpoch
		if purpose == "resource" {
			var ledger archiveLedger
			if json.Unmarshal(bundle.Ledger, &ledger) != nil || bundle.HistoryID == "" {
				return archiveConflict()
			}
			found := false
			for _, r := range ledger.Resources {
				if jsonEqual(encode(r), encode(resource)) {
					found = true
					break
				}
			}
			if !found {
				return archiveConflict()
			}
		}
		file, e = dao.SessionArchiveFile(ctx, op.id, fileID)
		if errors.Is(e, model.ErrNotFound) {
			if offset != 0 {
				return archiveConflict()
			}
			if purpose == "timeline" && bundle.TimelineID != "" && bundle.TimelineID != fileID {
				return archiveConflict()
			}
			if purpose == "history" && bundle.HistoryID != "" && bundle.HistoryID != fileID {
				previous, e := dao.SessionArchiveFile(ctx, op.id, bundle.HistoryID)
				if e != nil {
					return e
				}
				if previous.State != "complete" && previous.State != "failed" {
					return archiveConflict()
				}
				leases, e := media.SessionResourceLeaseCount(ctx, op.id)
				if e != nil {
					return e
				}
				if leases != 0 {
					return archiveConflict()
				}
				bundle.Revision++
			}
			namespace, e := archiveNamespace(op.project, op.owner, op.id)
			if e != nil {
				return e
			}
			file = store.ArchiveBundleFile{SessionID: op.id, FileID: fileID, Purpose: purpose, SHA256: digest, State: "receiving", ByteLength: length, TimelineRevision: bundle.Revision, Path: namespace.Directory() + "/files/" + fileID}
			if purpose == "history" {
				file.Resource = encode(historySourceIdentity{SourceEpoch: sourceEpoch(r)})
			}
			if purpose == "resource" {
				file.Resource = encode(resource)
				file.Path, e = BlobAddress(op.project, op.owner, op.id, fileID)
				if e != nil {
					return e
				}
			}
			if e = dao.SaveSessionArchiveFile(ctx, file); e != nil {
				return e
			}
			if purpose == "timeline" {
				bundle.TimelineID = fileID
			} else if purpose == "history" {
				bundle.HistoryID = fileID
			}
			if e = dao.SaveSessionArchiveBundle(ctx, bundle); e != nil {
				return e
			}
		} else if e != nil {
			return e
		}
		if file.Purpose != purpose || file.SHA256 != digest || file.ByteLength != length || file.State == "failed" || purpose == "resource" && !jsonEqual(file.Resource, encode(resource)) {
			return archiveConflict()
		}
		if purpose == "history" && bundle.HistoryID != fileID || purpose == "timeline" && (bundle.TimelineID != fileID || file.TimelineRevision != bundle.Revision) {
			return archiveConflict()
		}
		namespace, e := archiveNamespace(op.project, op.owner, op.id)
		if e != nil {
			return e
		}
		chunk = store.ArchiveBundleChunk{SessionID: op.id, FileID: fileID, Offset: offset, ByteLength: int64(len(data)), SHA256: chunkDigest, Path: namespace.Directory() + "/files/" + fileID + "/chunks/" + decimal(offset)}
		if emptyLegacy && file.State == "complete" && file.AcceptedOffset == 0 {
			duplicate = true
		} else if offset < file.AcceptedOffset {
			chunks, e := dao.SessionArchiveChunks(ctx, op.id, fileID)
			if e != nil {
				return e
			}
			for _, old := range chunks {
				if old.Offset == offset && old.ByteLength == chunk.ByteLength && old.SHA256 == chunk.SHA256 && old.Path == chunk.Path {
					duplicate = true
					break
				}
			}
			if !duplicate {
				return archiveConflict()
			}
		} else if offset != file.AcceptedOffset || file.State != "receiving" {
			return archiveConflict()
		}
		return acquireImageResourceLease(ctx, media, store.SessionResourceLease{SessionID: op.id, ID: leaseID, Kind: "archive", OwnerID: op.owner, DeleteEpoch: epoch})
	})
	if err != nil {
		return out, err
	}
	leaseAcquired = true
	if duplicate {
		if file.State == "complete" {
			if err = op.cleanupArchiveStaging(ctx, file); err != nil {
				return out, err
			}
			return fileReceipt(file), nil
		}
		if err = verifyArchiveChunk(ctx, op.execution.files, chunk.Path, data); err != nil {
			return out, err
		}
		if file.AcceptedOffset != file.ByteLength {
			err = op.bundleAccess(ctx, func(_ *operationTx, r *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
				current, e := dao.SessionArchiveFile(ctx, op.id, file.FileID)
				if e != nil {
					return e
				}
				if (current.State != "receiving" && current.State != "complete") || current.AcceptedOffset < file.AcceptedOffset || current.SHA256 != file.SHA256 || current.ByteLength != file.ByteLength || !jsonEqual(current.Resource, file.Resource) || purpose == "history" && bundle.HistoryID != fileID {
					return archiveConflict()
				}
				if purpose == "history" {
					var identity historySourceIdentity
					if len(current.Resource) != 0 && string(current.Resource) != "null" && (json.Unmarshal(current.Resource, &identity) != nil || identity.SourceEpoch != sourceEpoch(r)) {
						return archiveConflict()
					}
				}
				file = current
				return nil
			})
			if err != nil {
				return out, err
			}
			return fileReceipt(file), nil
		}
	}
	if !duplicate && !emptyLegacy {
		if err = putArchiveChunk(ctx, op.execution.files, chunk.Path, data, chunkDigest); err != nil {
			return out, err
		}
	}
	var chunks []store.ArchiveBundleChunk
	err = op.bundleAccess(ctx, func(tx *operationTx, _ *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
		media, e := archiveMediaDAO(tx)
		if e != nil {
			return e
		}
		usage, e := media.SessionResourceUsage(ctx, op.id)
		if e != nil {
			return e
		}
		if usage.Deleting || usage.DeleteEpoch != epoch {
			return conflict()
		}
		current, e := dao.SessionArchiveFile(ctx, op.id, fileID)
		if e != nil {
			return e
		}
		if current.SHA256 != file.SHA256 || current.ByteLength != file.ByteLength || current.TimelineRevision != file.TimelineRevision || purpose == "history" && bundle.HistoryID != fileID || purpose == "timeline" && bundle.TimelineID != fileID {
			return archiveConflict()
		}
		if !duplicate && (current.AcceptedOffset != offset || current.State != "receiving") {
			return archiveConflict()
		}
		if !duplicate {
			if !emptyLegacy {
				if e = dao.InsertSessionArchiveChunk(ctx, chunk); e != nil {
					return e
				}
			}
			file.AcceptedOffset = offset + int64(len(data))
			if e = dao.SaveSessionArchiveFile(ctx, file); e != nil {
				return e
			}
		}
		chunks, e = dao.SessionArchiveChunks(ctx, op.id, fileID)
		return e
	})
	if err != nil {
		return out, err
	}
	if file.AcceptedOffset == file.ByteLength {
		if err = op.assembleArchiveFile(ctx, file, chunks); err != nil {
			return out, err
		}
		var content []byte
		content, err = op.readBundleFile(ctx, file, limit)
		if err != nil {
			return out, err
		}
		// Decode and construct the complete candidate outside the Session lock.
		var candidate archiveLedger
		var history sp.ArchiveHistoryContent
		var timeline sp.ArchiveTimeline
		if purpose == "history" {
			history, err = sp.DecodeArchiveHistory(content)
			if err == nil {
				candidate, err = makeArchiveLedger(history, history.HistoryEpoch, number(history.SourceThrough))
			}
			if err != nil {
				return out, invalidArchiveFile(err)
			}
			candidate.HistoryID = fileID
		} else if purpose == "timeline" {
			timeline, err = sp.DecodeArchiveTimeline(content)
			if err != nil {
				return out, invalidArchiveFile(err)
			}
		}
		err = op.bundleAccess(ctx, func(tx *operationTx, r *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
			media, e := archiveMediaDAO(tx)
			if e != nil {
				return e
			}
			usage, e := media.SessionResourceUsage(ctx, op.id)
			if e != nil {
				return e
			}
			if usage.Deleting || usage.DeleteEpoch != epoch {
				return conflict()
			}
			if purpose == "history" && bundle.HistoryID != fileID || purpose == "timeline" && (bundle.TimelineID != fileID || bundle.Revision != file.TimelineRevision) {
				return archiveConflict()
			}
			if purpose == "history" {
				var identity historySourceIdentity
				if len(file.Resource) != 0 && string(file.Resource) != "null" {
					if json.Unmarshal(file.Resource, &identity) != nil || identity.SourceEpoch != sourceEpoch(r) {
						return invalidArchiveFile(archiveConflict())
					}
				} else {
					var prior archiveLedger
					if json.Unmarshal(bundle.Ledger, &prior) != nil || prior.TargetSourceEpoch != "" {
						return invalidArchiveFile(archiveConflict())
					}
				}
				through := r.SourceSeq
				if op.historyWriter != nil {
					through = number(history.SourceThrough)
					if through > r.SourceSeq {
						return invalidArchiveFile(archiveConflict())
					}
				}
				ledger := candidate
				ledger.SourceEpoch = sourceEpoch(r)
				if history.HistoryEpoch != r.Snapshot.HistoryEpoch || history.SourceThrough != decimal(through) {
					return invalidArchiveFile(archiveConflict())
				}
				var previous archiveLedger
				if json.Unmarshal(bundle.Ledger, &previous) != nil {
					return archiveConflict()
				}
				if previous.HistoryID != "" {
					if op.historyWriter != nil {
						e = verifySourceHistoryAdvance(previous, ledger)
					} else if op.historyWriter == nil && previous.FinalSourceThrough != "" {
						e = verifySourceHistoryAdvance(previous, ledger)
					} else if op.historyWriter == nil && file.TimelineRevision > 1 {
						e = verifyArchiveHistoryAdvance(previous, ledger)
					}
					if e != nil {
						return invalidArchiveFile(e)
					}
				}
				if e = checkContentPublication(ctx, tx, op.id, historyContentChange{ledger}); e != nil {
					return archiveContentFailure(e)
				}
				bundle.Ledger = encode(ledger)
				if e = dao.SaveSessionArchiveBundle(ctx, bundle); e != nil {
					return e
				}
			} else if purpose == "resource" {
				if e = checkContentPublication(ctx, tx, op.id, resourceContentChange{*resource}); e != nil {
					return archiveContentFailure(e)
				}
				if e = media.InsertSessionResource(ctx, store.SessionResourceRecord{SessionID: op.id, Resource: *resource, BlobID: fileID, BlobPath: file.Path, MigrationID: fileID}); e != nil {
					return e
				}
			} else {
				var ledger archiveLedger
				if json.Unmarshal(bundle.Ledger, &ledger) != nil {
					return errors.New("invalid persisted archive ledger")
				}
				if e = verifyArchiveLedger(ledger, timeline); e != nil {
					return invalidArchiveFile(e)
				}
			}
			file.State = "complete"
			return dao.SaveSessionArchiveFile(ctx, file)
		})
		if err != nil {
			return out, err
		}
		if err = op.cleanupArchiveStaging(ctx, file); err != nil {
			return out, err
		}
	}
	op.markCommit(err)
	return fileReceipt(file), nil
}
func (op *ArchiveOperation) assembleArchiveFile(ctx context.Context, file store.ArchiveBundleFile, chunks []store.ArchiveBundleChunk) (result error) {
	readers := []io.Reader{}
	closers := []io.Closer{}
	defer func() {
		for _, closer := range closers {
			result = archiveCleanupFailure(result, closer.Close())
		}
	}()
	var offset int64
	for _, chunk := range chunks {
		if chunk.Offset != offset {
			return archiveConflict()
		}
		object, err := op.execution.files.Open(ctx, archiveBucket, chunk.Path)
		if err != nil {
			return err
		}
		closers = append(closers, object.Body)
		if object.Info.Size != chunk.ByteLength {
			return invalidArchiveFile(errors.New("corrupt archive chunk"))
		}
		readers = append(readers, object.Body)
		offset += chunk.ByteLength
	}
	if offset != file.ByteLength {
		return archiveConflict()
	}
	hash := sha256.New()
	info, err := op.execution.files.Put(ctx, archiveFileBucket(file), archiveFilePath(file), io.TeeReader(io.MultiReader(readers...), hash))
	if err != nil {
		return err
	}
	if info.Size != file.ByteLength || hex.EncodeToString(hash.Sum(nil)) != file.SHA256 {
		return invalidArchiveFile(errors.New("archive file integrity check failed"))
	}
	return nil
}
func (op *ArchiveOperation) readBundleFile(ctx context.Context, file store.ArchiveBundleFile, limit int64) (data []byte, result error) {
	object, err := op.execution.files.Open(ctx, archiveFileBucket(file), archiveFilePath(file))
	if err != nil {
		return nil, err
	}
	defer func() { result = archiveCleanupFailure(result, object.Body.Close()) }()
	data, err = io.ReadAll(io.LimitReader(object.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != file.ByteLength || int64(len(data)) > limit || archiveDigest(data) != file.SHA256 {
		return nil, invalidArchiveFile(errors.New("archive file integrity check failed"))
	}
	return data, nil
}

// Seal freezes the exact ledger and resource descriptors after final history sync.
func (op *ArchiveOperation) SealArchive(ctx context.Context) (out sp.ArchivePrepareReceipt, err error) {
	op.mu.Lock()
	defer op.mu.Unlock()
	if err = op.check(ArchiveV1Upload); err != nil {
		return out, err
	}
	if err = op.SettleExpiredUploads(ctx); err != nil {
		return out, err
	}
	err = op.bundleAccess(ctx, func(tx *operationTx, _ *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
		if bundle.Phase == "sealed" || bundle.Phase == "committed" || bundle.Phase == "verified" {
			out = bundleReceipt(bundle)
			return nil
		}
		if bundle.Phase != "settling" || bundle.HistoryID == "" {
			return archiveConflict()
		}
		history, e := dao.SessionArchiveFile(ctx, op.id, bundle.HistoryID)
		if e != nil {
			return e
		}
		if history.State != "complete" {
			return archiveConflict()
		}
		var ledger archiveLedger
		if json.Unmarshal(bundle.Ledger, &ledger) != nil {
			return errors.New("invalid persisted archive ledger")
		}
		if !ledger.Sealable {
			return fault("archive_incomplete", "Archive projection is incomplete.")
		}
		media, e := archiveMediaDAO(tx)
		if e != nil {
			return e
		}
		unsettled, e := media.UnsettledSessionResourceWrites(ctx, op.id)
		if e != nil {
			return e
		}
		if unsettled != 0 {
			return fault("archive_incomplete", "Archive has unsettled resource writes or operations.")
		}
		for _, descriptor := range ledger.Resources {
			if descriptor.Status == "pending" {
				return fault("archive_incomplete", "Archive has unsettled resources.")
			}
		}
		if e = checkContentPublication(ctx, tx, op.id, sealedDescriptorsChange{ledger.Resources}); e != nil {
			return e
		}
		refs := []sp.ArchiveResourceReference{}
		for _, descriptor := range ledger.Resources {
			ref := sp.ArchiveResourceReference{Resource: descriptor}
			if descriptor.Status == "pending" {
				return fault("archive_incomplete", "Archive has unsettled resources.")
			}
			if descriptor.Status == "available" {
				saved, e := media.SavedSessionResource(ctx, op.id, descriptor.ResourceID)
				if e != nil {
					return e
				}
				if !jsonEqual(encode(saved.Resource), encode(descriptor)) || saved.BlobID == "" {
					return archiveConflict()
				}
				id := saved.BlobID
				ref.BlobID = &id
			}
			if descriptor.Status != "available" {
				saved, e := media.SavedSessionResource(ctx, op.id, descriptor.ResourceID)
				if errors.Is(e, model.ErrNotFound) {
					if e = media.InsertSessionResource(ctx, store.SessionResourceRecord{SessionID: op.id, Resource: descriptor}); e != nil {
						return e
					}
				} else if e != nil {
					return e
				} else if !jsonEqual(encode(saved.Resource), encode(descriptor)) || saved.BlobID != "" || saved.BlobPath != "" || saved.HasInlineContent || saved.GCPending {
					return archiveConflict()
				}
			}
			refs = append(refs, ref)
			if e = media.AddSessionResourceReference(ctx, store.SessionResourceReference{SessionID: op.id, ResourceID: descriptor.ResourceID, Kind: "archive", ReferenceID: bundle.PrepareID}); e != nil {
				return e
			}
		}
		bundle.Resources = encode(refs)
		bundle.Phase = "sealed"
		if e = dao.SaveSessionArchiveBundle(ctx, bundle); e != nil {
			return e
		}
		out = bundleReceipt(bundle)
		return nil
	})
	op.markCommit(err)
	return
}
func (op *ArchiveOperation) PutArchiveManifest(ctx context.Context, data []byte) (out sp.ArchiveStatus, err error) {
	op.mu.Lock()
	defer op.mu.Unlock()
	if err = op.check(ArchiveV1Upload); err != nil {
		return out, err
	}
	manifest, e := sp.DecodeArchiveManifest(data)
	if e != nil {
		return out, fault("invalid_input", "Invalid archive manifest.")
	}
	digest := archiveDigest(data)
	var file store.ArchiveBundleFile
	var refs []store.SessionResourceRecord
	var epoch int64
	leaseID := uuid.NewString()
	var finish func() error
	ctx, finish, err = op.execution.beginImageIO(ctx, op.id, leaseID)
	if err != nil {
		return out, err
	}
	leaseAcquired := false
	defer func() {
		err = joinImageCleanup(err, finish)
		if leaseAcquired {
			err = errors.Join(err, op.execution.releaseImageLease(context.WithoutCancel(ctx), op.principal, op.project, op.task, op.id, leaseID))
		}
	}()
	var path string
	err = op.bundleAccess(ctx, func(tx *operationTx, r *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
		if manifest.RecordID != op.id || archiveWriter(op.principal, r, manifest.Fence, manifest.ControllerID, manifest.ControllerInstanceID) != nil || manifest.Provider != r.Snapshot.Identity.Provider || r.Snapshot.Identity.NativeSessionID != nil && !sameNative(manifest.NativeSessionID, r.Snapshot.Identity.NativeSessionID) {
			return archiveConflict()
		}
		if bundle.ManifestHash != "" && bundle.ManifestHash != digest {
			return archiveConflict()
		}
		if bundle.Phase != "sealed" && bundle.Phase != "committed" && bundle.Phase != "verified" {
			return archiveConflict()
		}
		if !jsonEqual(bundle.Resources, encode(manifest.Resources)) {
			return archiveConflict()
		}
		var e error
		file, e = dao.SessionArchiveFile(ctx, op.id, manifest.Timeline.FileID)
		if e != nil {
			return e
		}
		if file.State != "complete" || file.FileID != bundle.TimelineID || file.SHA256 != manifest.Timeline.SHA256 || decimal(file.ByteLength) != manifest.Timeline.ByteLength {
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
		epoch = usage.DeleteEpoch
		for _, reference := range manifest.Resources {
			if reference.Resource.Status != "available" {
				continue
			}
			saved, e := media.SavedSessionResource(ctx, op.id, reference.Resource.ResourceID)
			if e != nil {
				return e
			}
			if reference.BlobID == nil || saved.BlobID != *reference.BlobID || !jsonEqual(encode(saved.Resource), encode(reference.Resource)) {
				return archiveConflict()
			}
			refs = append(refs, saved)
		}
		path, e = archiveObjectPath(op.project, op.owner, op.id, digest)
		if e != nil {
			return e
		}
		bundle.ManifestHash = digest
		bundle.ManifestLength = decimal(int64(len(data)))
		bundle.ManifestPath = path
		if e = dao.SaveSessionArchiveBundle(ctx, bundle); e != nil {
			return e
		}
		return acquireImageResourceLease(ctx, media, store.SessionResourceLease{SessionID: op.id, ID: leaseID, Kind: "archive", OwnerID: op.owner, DeleteEpoch: epoch})
	})
	if err != nil {
		return out, err
	}
	leaseAcquired = true
	timeline, e := op.readBundleFile(ctx, file, sp.MaxArchiveTimelineBytes)
	if e != nil {
		return out, e
	}
	byID := map[string]store.SessionResourceRecord{}
	for _, ref := range refs {
		byID[ref.Resource.ResourceID] = ref
	}
	if _, e = sp.VerifyArchiveClosure(manifest, timeline, func(ref sp.ArchiveResourceReference) (data []byte, result error) {
		saved := byID[ref.Resource.ResourceID]
		object, e := op.execution.files.Open(ctx, sessionresource.Bucket, saved.BlobPath)
		if e != nil {
			return nil, e
		}
		defer func() { result = archiveCleanupFailure(result, object.Body.Close()) }()
		data, e = io.ReadAll(io.LimitReader(object.Body, sp.MaxArchiveBlobBytes+1))
		return data, e
	}); e != nil {
		return out, e
	}
	info, e := op.execution.files.Put(ctx, archiveBucket, path, bytes.NewReader(data))
	if e != nil {
		return out, e
	}
	if info.Size != int64(len(data)) {
		return out, errors.New("archive manifest storage length mismatch")
	}
	err = op.bundleAccess(ctx, func(tx *operationTx, r *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
		media, e := archiveMediaDAO(tx)
		if e != nil {
			return e
		}
		usage, e := media.SessionResourceUsage(ctx, op.id)
		if e != nil {
			return e
		}
		if usage.Deleting || usage.DeleteEpoch != epoch || bundle.ManifestHash != digest || !jsonEqual(bundle.Resources, encode(manifest.Resources)) {
			return conflict()
		}
		if manifest.Provider != r.Snapshot.Identity.Provider || r.Snapshot.Identity.NativeSessionID != nil && !sameNative(manifest.NativeSessionID, r.Snapshot.Identity.NativeSessionID) {
			return archiveConflict()
		}
		if bundle.Phase != "committed" && bundle.Phase != "verified" {
			if e = checkContentPublication(ctx, tx, op.id, manifestContentChange{data}); e != nil {
				return e
			}
		}
		if e = dao.SetUnifiedSessionArchiveReady(ctx, op.id, digest, len(data), path, manifest.Completeness); e != nil {
			return e
		}
		// A stopped original writer may have created its native session after
		// the last relay acknowledgement, but cannot replace a known identity.
		if r.Snapshot.Identity.NativeSessionID == nil && manifest.NativeSessionID != nil {
			r.Snapshot.Identity.NativeSessionID = manifest.NativeSessionID
			if e = save(ctx, tx, r); e != nil {
				return e
			}
		}
		bundle.Phase = "committed"
		if e = dao.SaveSessionArchiveBundle(ctx, bundle); e != nil {
			return e
		}
		size := decimal(int64(len(data)))
		out = sp.ArchiveStatus{State: "ready", SHA256: &digest, ByteLength: &size, SchemaVersion: 3, Completeness: &manifest.Completeness}
		return nil
	})
	op.markCommit(err)
	return
}

func (s *Execution) ArchiveTimelineContentReserved(ctx context.Context, p model.Principal, project, taskID, id, fileID string, reservation *ArchivePreflightReservation) (out *RetainedArchive, result error) {
	op, err := s.BeginArchiveReserved(ctx, p, project, taskID, id, ArchiveV1Read, reservation)
	if err != nil {
		return nil, err
	}
	return s.archiveTimelineContent(ctx, op, fileID, nil, "")
}

func (s *Execution) archiveTimelineContent(ctx context.Context, op *ArchiveOperation, fileID string, manifest *sp.ArchiveManifest, manifestHash string) (out *RetainedArchive, result error) {
	p, project, taskID, id := op.principal, op.project, op.task, op.id
	leaseID := uuid.NewString()
	ctx, finish, err := s.beginImageIO(ctx, id, leaseID)
	if err != nil {
		return nil, errors.Join(err, op.Close())
	}
	leaseAcquired := false
	cleanup := func() error {
		err := finish()
		if leaseAcquired {
			err = errors.Join(err, s.releaseImageLease(context.WithoutCancel(ctx), p, project, taskID, id, leaseID))
		}
		return err
	}
	defer func() {
		if result != nil {
			result = errors.Join(result, cleanup(), op.Close())
		}
	}()
	var file store.ArchiveBundleFile
	var bundle store.ArchiveBundle
	var ledger archiveLedger
	var status sp.ArchiveStatus
	var archivePath string
	var deleteEpoch int64
	err = s.archiveAccess(ctx, p, project, taskID, id, false, func(tx *operationTx, r *record, _ task) error {
		if r.Owner != op.owner {
			return conflict()
		}
		var e error
		status, archivePath, e = archiveStatus(ctx, tx, id)
		if e != nil {
			return e
		}
		if status.State != "ready" || status.SchemaVersion != 3 {
			return fault("not_found", "Unified archive is unavailable.")
		}
		if manifest != nil && (status.SHA256 == nil || *status.SHA256 != manifestHash) {
			return archiveConflict()
		}
		dao, e := archiveDAO(tx)
		if e != nil {
			return e
		}
		bundle, e = dao.SessionArchiveBundle(ctx, id)
		if e != nil {
			return e
		}
		if bundle.TimelineID != fileID {
			return archiveConflict()
		}
		if json.Unmarshal(bundle.Ledger, &ledger) != nil {
			return errors.New("invalid archive ledger")
		}
		file, e = dao.SessionArchiveFile(ctx, id, fileID)
		if e != nil {
			return e
		}
		if file.State != "complete" || file.Purpose != "timeline" {
			return archiveConflict()
		}
		if manifest != nil && (manifest.RecordID != id || manifest.Timeline.FileID != file.FileID || manifest.Timeline.SHA256 != file.SHA256 || manifest.Timeline.ByteLength != decimal(file.ByteLength)) {
			return archiveConflict()
		}
		media, e := archiveMediaDAO(tx)
		if e != nil {
			return e
		}
		usage, e := media.SessionResourceUsage(ctx, id)
		if e != nil {
			return e
		}
		if usage.Deleting {
			return conflict()
		}
		deleteEpoch = usage.DeleteEpoch
		return acquireImageResourceLease(ctx, media, store.SessionResourceLease{SessionID: id, ID: leaseID, Kind: "read", OwnerID: r.Owner, DeleteEpoch: deleteEpoch})
	})
	if err != nil {
		return nil, err
	}
	leaseAcquired = true
	data, err := op.readBundleFile(ctx, file, sp.MaxArchiveTimelineBytes)
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	timeline, err := sp.DecodeArchiveTimeline(data)
	if err != nil {
		return nil, err
	}
	if err = verifyArchiveLedger(ledger, timeline); err != nil {
		return nil, err
	}
	// File I/O is outside the authorization transaction. Recheck the ordinary
	// historical scope and the original archive before publishing retained bytes.
	err = s.archiveAccess(ctx, p, project, taskID, id, false, func(tx *operationTx, r *record, _ task) error {
		if r.Owner != op.owner {
			return conflict()
		}
		currentStatus, currentPath, e := archiveStatus(ctx, tx, id)
		if e != nil {
			return e
		}
		if currentPath != archivePath || !jsonEqual(encode(currentStatus), encode(status)) {
			return archiveConflict()
		}
		dao, e := archiveDAO(tx)
		if e != nil {
			return e
		}
		currentBundle, e := dao.SessionArchiveBundle(ctx, id)
		if e != nil {
			return e
		}
		if !jsonEqual(encode(currentBundle), encode(bundle)) {
			return archiveConflict()
		}
		currentFile, e := dao.SessionArchiveFile(ctx, id, fileID)
		if e != nil {
			return e
		}
		if !jsonEqual(encode(currentFile), encode(file)) {
			return archiveConflict()
		}
		media, e := archiveMediaDAO(tx)
		if e != nil {
			return e
		}
		usage, e := media.SessionResourceUsage(ctx, id)
		if e != nil {
			return e
		}
		if usage.Deleting || usage.DeleteEpoch != deleteEpoch {
			return conflict()
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	return &RetainedArchive{Data: data, operation: op, closeFn: cleanup}, nil
}

func archiveFileBucket(file store.ArchiveBundleFile) string {
	if file.Purpose == "resource" {
		return sessionresource.Bucket
	}
	return archiveBucket
}
func archiveFilePath(file store.ArchiveBundleFile) string {
	if file.Purpose == "resource" {
		return file.Path
	}
	return file.Path + "/content"
}

func resetArchivePreparation(ctx context.Context, tx *operationTx, dao store.SessionArchiveDAO, bundle *store.ArchiveBundle, in sp.ArchivePrepareRequest) error {
	if decimal(bundle.Revision) != in.ExpectedTimelineRevision || bundle.ManifestHash != "" || bundle.ManifestPath != "" || bundle.Phase == "committed" || bundle.Phase == "verified" {
		return archiveConflict()
	}
	if in.FailedFileID != bundle.TimelineID && in.FailedFileID != bundle.HistoryID {
		return archiveConflict()
	}
	file, err := dao.SessionArchiveFile(ctx, bundle.SessionID, in.FailedFileID)
	if err != nil {
		return err
	}
	if file.State != "failed" || file.TimelineRevision != bundle.Revision {
		return archiveConflict()
	}
	media, err := archiveMediaDAO(tx)
	if err != nil {
		return err
	}
	usage, err := media.SessionResourceUsage(ctx, bundle.SessionID)
	if err != nil {
		return err
	}
	if usage.Deleting {
		return conflict()
	}
	leases, err := media.SessionResourceLeaseCount(ctx, bundle.SessionID)
	if err != nil {
		return err
	}
	if leases != 0 {
		return archiveConflict()
	}
	files, err := dao.SessionArchiveFiles(ctx, bundle.SessionID)
	if err != nil {
		return err
	}
	for _, current := range files {
		if current.State == "receiving" {
			return archiveConflict()
		}
	}
	var refs []sp.ArchiveResourceReference
	if json.Unmarshal(bundle.Resources, &refs) != nil {
		return archiveConflict()
	}
	for _, ref := range refs {
		if err = media.RemoveSessionResourceReference(ctx, store.SessionResourceReference{SessionID: bundle.SessionID, ResourceID: ref.Resource.ResourceID, Kind: "archive", ReferenceID: bundle.PrepareID}); err != nil {
			return err
		}
	}
	bundle.Revision++
	bundle.Phase = "settling"
	bundle.Resources = json.RawMessage(`[]`)
	bundle.TimelineID = ""
	if file.Purpose == "history" {
		bundle.HistoryID = ""
	}
	return dao.SaveSessionArchiveBundle(ctx, *bundle)
}

// A later synchronization may only revise the same stopped-source entries.
// Unchanged entries retain their original revision; changed projections advance it.
func verifyArchiveHistoryAdvance(previous, next archiveLedger) error {
	if previous.HistoryEpoch != next.HistoryEpoch || previous.SourceThrough != next.SourceThrough || len(previous.Entries) != len(next.Entries) {
		return archiveConflict()
	}
	changed := false
	for i, old := range previous.Entries {
		current := next.Entries[i]
		if old.ID != current.ID || old.Sequence != current.Sequence || old.SourceSHA256 != current.SourceSHA256 {
			return archiveConflict()
		}
		if old.SHA256 == current.SHA256 {
			if old.Revision != current.Revision {
				return archiveConflict()
			}
			continue
		}
		if number(current.Revision) <= number(old.Revision) {
			return archiveConflict()
		}
		changed = true
	}
	if !changed {
		return archiveConflict()
	}
	return nil
}

func verifyStoppedHistoryAdvance(previous, next archiveLedger) error {
	return verifyHistoryAdvance(previous, next, true)
}

func verifySourceHistoryAdvance(previous, next archiveLedger) error {
	sameEpoch := previous.SourceEpoch == "" || previous.SourceEpoch == next.SourceEpoch
	if !sameEpoch && (previous.TargetSourceEpoch == "" || previous.TargetSourceEpoch != next.SourceEpoch) {
		return archiveConflict()
	}
	return verifyHistoryAdvance(previous, next, sameEpoch)
}

func verifyHistoryAdvance(previous, next archiveLedger, sameEpoch bool) error {
	if previous.latestHistoryEpoch() != next.HistoryEpoch || sameEpoch && number(next.SourceThrough) < number(previous.SourceThrough) || len(next.Entries) < len(previous.Entries) {
		return archiveConflict()
	}
	sameSource := sameEpoch && next.SourceThrough == previous.SourceThrough
	if sameSource && len(next.Entries) != len(previous.Entries) {
		return archiveConflict()
	}
	for i, old := range previous.Entries {
		current := next.Entries[i]
		if old.ID != current.ID || old.Sequence != current.Sequence || number(current.Revision) < number(old.Revision) || old.Revision == current.Revision && old.SHA256 != current.SHA256 || sameSource && old.SourceSHA256 != current.SourceSHA256 {
			return archiveConflict()
		}
	}
	return nil
}

func archiveSourceDigest(data []byte) string {
	var value any
	if json.Unmarshal(data, &value) != nil {
		return ""
	}
	var source func(any) any
	source = func(value any) any {
		switch item := value.(type) {
		case []any:
			out := []any{}
			for _, v := range item {
				if object, ok := v.(map[string]any); ok && (object["type"] == "image" || object["type"] == "image_unavailable" || object["type"] == "markdown") {
					continue
				}
				out = append(out, source(v))
			}
			return out
		case map[string]any:
			out := map[string]any{}
			for key, v := range item {
				switch key {
				case "revision", "imageProjectionError", "partId", "textSha256", "complete", "truncated", "bindings", "retainedImages":
					continue
				}
				out[key] = source(v)
			}
			return out
		default:
			return value
		}
	}
	return archiveDigest(encode(source(value)))
}

func (op *ArchiveOperation) failArchiveFile(ctx context.Context, file store.ArchiveBundleFile, causes ...error) error {
	if file.FileID == "" {
		return nil
	}
	err := op.bundleAccess(ctx, func(tx *operationTx, _ *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
		current, err := dao.SessionArchiveFile(ctx, op.id, file.FileID)
		if err != nil {
			return err
		}
		if current.State != "receiving" || current.SHA256 != file.SHA256 || current.ByteLength != file.ByteLength || current.TimelineRevision != file.TimelineRevision {
			return archiveConflict()
		}
		if len(causes) > 0 {
			var f *model.Fault
			if errors.As(causes[0], &f) && f.Code == "quota_exceeded" {
				failureDAO, ok := tx.dao.(store.SessionArchiveFailureDAO)
				if !ok {
					return errors.New("archive failure storage unavailable")
				}
				original := current.Resource
				if len(original) == 0 {
					original = json.RawMessage(`null`)
				}
				metadata := encode(struct {
					Original json.RawMessage `json:"original"`
					Failure  *sp.ImageError  `json:"failure"`
				}{original, &sp.ImageError{Code: f.Code, Message: f.Message}})
				if err = failureDAO.FailSessionArchiveFile(ctx, current, metadata); err != nil {
					return err
				}
				current.Resource = metadata
			} else {
				current.State = "failed"
				if err = dao.SaveSessionArchiveFile(ctx, current); err != nil {
					return err
				}
			}
		} else {
			current.State = "failed"
			if err = dao.SaveSessionArchiveFile(ctx, current); err != nil {
				return err
			}
		}
		if file.Purpose == "timeline" && bundle.TimelineID == file.FileID {
			bundle.Phase = "failed"
			return dao.SaveSessionArchiveBundle(ctx, bundle)
		}
		return nil
	})
	if err != nil {
		return err
	}
	file.State = "failed"
	return op.cleanupArchiveStaging(ctx, file)
}

func observeArchivePreparation(p model.Principal, r *record, t task, bundle store.ArchiveBundle) error {
	if err := archiveStopped(r, t); err != nil {
		return err
	}
	var identity sp.ArchivePrepareRequest
	if json.Unmarshal(bundle.Identity, &identity) != nil {
		return archiveConflict()
	}
	return archiveWriter(p, r, identity.Fence, identity.ControllerID, identity.ControllerInstanceID)
}

// Retired history owns both acknowledged chunks and the next immutable chunk
// path: its writer may have published that path before its SQL acknowledgement.
// Wait for archive writers to drain before deleting either.
type archiveCleanupAccess func(context.Context, func(*operationTx, *record, store.SessionArchiveDAO, store.ArchiveBundle) error) error

func (op *ArchiveOperation) cleanupRetiredHistory(ctx context.Context) error {
	return op.execution.cleanupRetiredHistory(ctx, op.id, op.bundleAccess)
}
func (s *Execution) cleanupRetiredHistory(ctx context.Context, id string, access archiveCleanupAccess) error {
	var retired []store.ArchiveBundleFile
	err := access(ctx, func(tx *operationTx, _ *record, dao store.SessionArchiveDAO, _ store.ArchiveBundle) error {
		files, err := dao.SessionArchiveFiles(ctx, id)
		if err != nil {
			return err
		}
		for _, file := range files {
			if file.Purpose == "history" && file.State == "failed" && !file.StagingReleased {
				retired = append(retired, file)
			}
		}
		if len(retired) == 0 {
			return nil
		}
		media, err := archiveMediaDAO(tx)
		if err != nil {
			return err
		}
		leases, err := media.ListSessionResourceLeases(ctx, id)
		if err != nil {
			return err
		}
		for _, lease := range leases {
			if lease.Kind == "archive" {
				retired = nil
				break
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, file := range retired {
		if err = s.files.Delete(ctx, archiveBucket, file.Path+"/chunks/"+decimal(file.AcceptedOffset)); err != nil {
			return err
		}
		if err = s.cleanupArchiveStaging(ctx, id, file, access); err != nil {
			return err
		}
	}
	return nil
}

// A complete receipt fixes the original identity; its chunk hashes remain as
// retry tombstones after staging is removed. Final timeline and resource bytes
// remain under their permanent owners.
func (op *ArchiveOperation) cleanupArchiveStaging(ctx context.Context, file store.ArchiveBundleFile) error {
	return op.execution.cleanupArchiveStaging(ctx, op.id, file, op.bundleAccess)
}
func (s *Execution) cleanupArchiveStaging(ctx context.Context, id string, file store.ArchiveBundleFile, access archiveCleanupAccess) error {
	if file.StagingReleased {
		return nil
	}
	var chunks []store.ArchiveBundleChunk
	err := access(ctx, func(_ *operationTx, _ *record, dao store.SessionArchiveDAO, _ store.ArchiveBundle) error {
		current, e := dao.SessionArchiveFile(ctx, id, file.FileID)
		if e != nil {
			return e
		}
		if current.State != file.State || (current.State != "complete" && current.State != "failed") || current.SHA256 != file.SHA256 {
			return archiveConflict()
		}
		chunks, e = dao.SessionArchiveChunks(ctx, id, file.FileID)
		return e
	})
	if err != nil {
		return err
	}
	for _, chunk := range chunks {
		if err = s.files.Delete(ctx, archiveBucket, chunk.Path); err != nil {
			return err
		}
	}
	if file.Purpose == "history" || file.State == "failed" {
		if err = s.files.Delete(ctx, archiveFileBucket(file), archiveFilePath(file)); err != nil {
			return err
		}
	}
	return access(ctx, func(_ *operationTx, _ *record, dao store.SessionArchiveDAO, _ store.ArchiveBundle) error {
		current, e := dao.SessionArchiveFile(ctx, id, file.FileID)
		if e != nil {
			return e
		}
		if current.State != file.State || (current.State != "complete" && current.State != "failed") || current.SHA256 != file.SHA256 {
			return archiveConflict()
		}
		current.StagingReleased = true
		return dao.SaveSessionArchiveFile(ctx, current)
	})
}
