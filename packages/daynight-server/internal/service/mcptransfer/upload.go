package mcptransfer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"strconv"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	"github.com/google/uuid"
)

const MaxChunkBytes = 512 << 10

type UploadInput struct{ Action, Path, ContentType, TransferID, ChunkID, Offset, ContentBase64, SHA256, TotalBytes string }

type attachmentPut interface {
	Put(context.Context, model.Principal, string, string, string, string, io.Reader) (model.Attachment, bool, error)
	AdmitTransfer(context.Context, model.Principal, string, string, string, string, filestorage.TransferNamespace) (*attachmentservice.TransferAdmission, error)
	AcquireUploadLease(context.Context, model.Principal, string, string) (io.Closer, error)
}

type Uploads struct {
	lifecycle   *Lifecycle
	files       filestorage.TransferStorage
	attachments attachmentPut
}

func NewUploads(lifecycle *Lifecycle, files filestorage.TransferStorage, attachments attachmentPut) *Uploads {
	return &Uploads{lifecycle: lifecycle, files: files, attachments: attachments}
}

type uploadData = transfer.UploadData

func uploadDataOf(r model.PrivateTransfer) (uploadData, error) { return transfer.DecodeUploadData(r) }
func encodeUpload(d uploadData) json.RawMessage                { return transfer.EncodeUploadData(d) }
func decimal(n int64) string                                   { return strconv.FormatInt(n, 10) }
func number(s string) (int64, error) {
	n, e := strconv.ParseInt(s, 10, 64)
	if e != nil || n < 0 || decimal(n) != s {
		return 0, &model.Fault{Code: "invalid_input", Message: "Invalid byte count."}
	}
	return n, nil
}
func digest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func decodeContent(s string, nonempty bool) ([]byte, error) {
	b, e := base64.StdEncoding.Strict().DecodeString(s)
	if e != nil || len(b) > MaxChunkBytes || (nonempty && len(b) == 0) {
		return nil, &model.Fault{Code: "invalid_input", Message: "Invalid or oversized base64 content."}
	}
	return b, nil
}
func validHash(h string) bool {
	if len(h) != 64 {
		return false
	}
	b, e := hex.DecodeString(h)
	return e == nil && hex.EncodeToString(b) == h
}
func uploadFault(message string) error {
	return &model.Fault{Code: "transfer_conflict", Message: message}
}
func attachmentWire(a model.Attachment) map[string]any {
	return map[string]any{"path": a.Path, "contentType": a.ContentType, "sizeBytes": decimal(a.SizeBytes), "createdAt": a.CreatedAt.UTC(), "updatedAt": a.UpdatedAt.UTC()}
}
func uploadResult(r model.PrivateTransfer) (map[string]any, error) {
	d, e := uploadDataOf(r)
	if e != nil {
		return nil, e
	}
	cleanup := "pending"
	if r.State == "closed" {
		cleanup = "complete"
	}
	result := map[string]any{"transferId": r.ID, "direction": "upload", "state": r.State, "nextOffset": decimal(d.NextOffset), "expiresAt": r.ExpiresAt.UTC(), "cleanupState": cleanup}
	if d.OperationID != "" {
		result["operationId"] = d.OperationID
	}
	if d.TotalBytes != nil {
		result["totalBytes"] = decimal(*d.TotalBytes)
	}
	if d.SHA256 != "" {
		result["sha256"] = d.SHA256
	}
	if d.WriteOutcome != "" {
		result["writeOutcome"] = d.WriteOutcome
	}
	if d.Attachment != nil && d.Created != nil && d.WriteOutcome == "confirmed" {
		result["attachment"] = attachmentWire(*d.Attachment)
		result["created"] = *d.Created
	}
	return result, nil
}
func (s *Uploads) bound(ctx context.Context, a transfer.Actor, project, task, id string) (model.PrivateTransfer, error) {
	r, e := s.lifecycle.LookupBound(ctx, a, id)
	if e != nil {
		return r, e
	}
	if r.Direction != "upload" || r.ProjectID != project || r.TaskID != task {
		return model.PrivateTransfer{}, transfer.ErrConflict
	}
	return r, nil
}
func (s *Uploads) Execute(ctx context.Context, a transfer.Actor, project, task string, in UploadInput) (map[string]any, error) {
	if s == nil || s.lifecycle == nil || s.files == nil || s.attachments == nil {
		return nil, errors.New("upload service unavailable")
	}
	project, e := model.CanonicalID(project)
	if e != nil {
		return nil, e
	}
	task, e = model.CanonicalID(task)
	if e != nil {
		return nil, e
	}
	switch in.Action {
	case "inline":
		b, e := decodeContent(in.ContentBase64, false)
		if e != nil {
			return map[string]any{"writeOutcome": "not_committed"}, e
		}
		item, created, e := s.attachments.Put(ctx, a.Principal, project, task, in.Path, in.ContentType, bytes.NewReader(b))
		if e != nil {
			outcome := "not_committed"
			if attachmentservice.FileEffectPossible(e) {
				outcome = "unknown"
				if operation.CompletionFacts(e).Outcome == store.TransactionCommitted {
					return map[string]any{"writeOutcome": "confirmed", "attachment": attachmentWire(item), "created": created}, e
				}
			}
			return map[string]any{"writeOutcome": outcome}, e
		}
		return map[string]any{"attachment": attachmentWire(item), "created": created, "writeOutcome": "confirmed"}, nil
	case "begin":
		address, e := attachmentcore.NewAddress(project, task, in.Path)
		if e != nil {
			return nil, e
		}
		if e = attachmentcore.ValidateWritePath(address.RelativePath); e != nil {
			return nil, e
		}
		if e = attachmentcore.ValidateContentType(in.ContentType); e != nil {
			return nil, e
		}
		r, _, e := s.lifecycle.OpenRecord(ctx, a, transfer.Binding{ID: in.TransferID, Direction: "upload", ProjectID: project, TaskID: task, Path: address.RelativePath, ContentType: in.ContentType})
		if e != nil {
			return nil, e
		}
		result, e := uploadResult(r)
		if e == nil {
			result["maxChunkBytes"] = MaxChunkBytes
		}
		return result, e
	case "status":
		r, e := s.bound(ctx, a, project, task, in.TransferID)
		if e != nil {
			return nil, e
		}
		if r.State == "committing" && (r.LeaseUntil == nil || !time.Now().Before(*r.LeaseUntil)) {
			d, err := uploadDataOf(r)
			if err != nil {
				return nil, err
			}
			d.WriteOutcome = "unknown"
			r, e = s.lifecycle.Transition(ctx, a, r.ID, r.Version, "unknown", encodeUpload(d), nil)
			if e != nil {
				return nil, e
			}
		}
		return uploadResult(r)
	case "abort":
		if _, e := s.bound(ctx, a, project, task, in.TransferID); e != nil {
			return nil, e
		}
		r, e := s.lifecycle.RequestCleanup(ctx, a, in.TransferID)
		if e != nil {
			return nil, e
		}
		return uploadResult(r)
	case "chunk":
		return s.chunk(ctx, a, project, task, in)
	case "commit":
		return s.commit(ctx, a, project, task, in)
	default:
		return nil, &model.Fault{Code: "invalid_input", Message: "Unknown upload action."}
	}
}

func (s *Uploads) chunk(ctx context.Context, a transfer.Actor, project, task string, in UploadInput) (result map[string]any, err error) {
	if !transfer.Canonical(in.ChunkID) {
		return nil, uploadFault("Invalid chunk ID.")
	}
	off, e := number(in.Offset)
	if e != nil {
		return nil, e
	}
	b, e := decodeContent(in.ContentBase64, true)
	if e != nil {
		return nil, e
	}
	hash := digest(b)
	if in.SHA256 != "" && (!validHash(in.SHA256) || in.SHA256 != hash) {
		return nil, uploadFault("Chunk hash does not match.")
	}
	if _, e = s.bound(ctx, a, project, task, in.TransferID); e != nil {
		return nil, e
	}
	lease, e := s.attachments.AcquireUploadLease(ctx, a.Principal, project, task)
	if e != nil {
		return map[string]any{"transferId": in.TransferID, "writeOutcome": "not_committed"}, e
	}
	if !attachmentservice.RetainUploadLease(ctx, lease) {
		defer func() { err = errors.Join(err, lease.Close()) }()
	}
	p, e := s.lifecycle.AcquirePermit(ctx, a, in.TransferID)
	if e != nil {
		return nil, e
	}
	defer func() { err = errors.Join(err, p.Close()) }()
	r, e := s.lifecycle.admittedUploadRecord(p.Context, p)
	if e != nil {
		return nil, e
	}
	if r.State != "receiving" {
		return nil, transfer.ErrState
	}
	d, e := uploadDataOf(r)
	if e != nil {
		return nil, e
	}
	var prior model.UploadChunk
	var receiptMissing bool
	e = s.lifecycle.admittedUpload(p.Context, p, func(dao store.PrivateTransferDAO, current model.PrivateTransfer) error {
		var err error
		if err = dao.LockProjectLifecycle(p.Context, current.ProjectID, current.TaskID); err != nil {
			return projectcore.LookupError(err)
		}
		prior, err = dao.UploadChunk(p.Context, current.ID, in.ChunkID)
		receiptMissing = errors.Is(err, model.ErrNotFound)
		return err
	})
	if e == nil {
		if prior.Offset != off || prior.Size != int64(len(b)) || prior.SHA256 != hash {
			return nil, uploadFault("Chunk identity conflicts with its receipt.")
		}
		return chunkResult(r, prior, "already_accepted"), nil
	}
	facts := operation.CompletionFacts(e)
	databaseFailure, _ := store.DatabaseErrorFacts(e)
	if !receiptMissing || databaseFailure || facts.Outcome != store.TransactionNotCommitted || facts.CleanupFailed {
		return nil, e
	}
	if off != d.NextOffset || off > int64(^uint64(0)>>1)-int64(len(b)) {
		return nil, uploadFault("Chunk offset does not match the next offset.")
	}
	if d.NextOffset > attachmentcore.MaxFileBytes || int64(len(b)) > attachmentcore.MaxFileBytes-d.NextOffset {
		return map[string]any{"transferId": in.TransferID, "writeOutcome": "not_committed"}, attachmentcore.FileTooLarge()
	}
	r, e = s.lifecycle.reserveAdmittedUpload(p.Context, p, int64(len(b)))
	if e != nil {
		return map[string]any{"transferId": in.TransferID, "writeOutcome": "not_committed"}, e
	}
	namespace, e := filestorage.NewTransferNamespace(in.TransferID)
	if e != nil {
		return nil, e
	}
	chunk := model.UploadChunk{TransferID: in.TransferID, ChunkID: in.ChunkID, ObjectID: uuid.NewString(), Offset: off, Size: int64(len(b)), SHA256: hash}
	e = s.lifecycle.admittedUpload(p.Context, p, func(dao store.PrivateTransferDAO, current model.PrivateTransfer) error {
		var err error
		if err = dao.LockProjectLifecycle(p.Context, current.ProjectID, current.TaskID); err != nil {
			return projectcore.LookupError(err)
		}
		if current.State != "receiving" || current.Version != r.Version || !transfer.Live(current, time.Now()) {
			return transfer.ErrState
		}
		if _, err = s.files.PutTransfer(p.Context, namespace, chunk.ObjectID, bytes.NewReader(b)); err != nil {
			return err
		}
		next, err := transfer.AcceptUploadChunk(current, chunk, time.Now().UTC())
		if err != nil {
			return err
		}
		if err = dao.InsertUploadChunk(p.Context, chunk); err != nil {
			return err
		}
		current, err = transfer.ConsumeReservation(p.Context, dao, current.ID, chunk.Size, current.Version)
		if err != nil {
			return err
		}
		r, err = transfer.Update(p.Context, dao, next, current.Version)
		return err
	})
	if e != nil {
		return map[string]any{"transferId": in.TransferID}, e
	}
	return chunkResult(r, chunk, "accepted"), nil
}
func chunkResult(r model.PrivateTransfer, c model.UploadChunk, receipt string) map[string]any {
	return map[string]any{"transferId": r.ID, "state": r.State, "chunkId": c.ChunkID, "offset": decimal(c.Offset), "acceptedBytes": decimal(c.Size), "nextOffset": decimal(uploadNextOffset(r)), "sha256": c.SHA256, "receipt": receipt, "expiresAt": r.ExpiresAt.UTC()}
}

func uploadNextOffset(r model.PrivateTransfer) int64 { d, _ := uploadDataOf(r); return d.NextOffset }

// chunkStream opens one confirmed immutable object at a time; it never loads
// the complete receipt set or content into memory.
type chunkStream struct {
	ctx           context.Context
	service       *Uploads
	permit        *Permit
	lookup        func(context.Context, int64) (model.UploadChunk, error)
	namespace     filestorage.TransferNamespace
	offset, total int64
	current       io.ReadCloser
	remaining     int64
	chunkHash     hash.Hash
	expectedHash  string
}

func (s *chunkStream) Read(b []byte) (int, error) {
	for {
		if s.current != nil {
			n, e := s.current.Read(b)
			s.remaining -= int64(n)
			s.offset += int64(n)
			_, _ = s.chunkHash.Write(b[:n])
			if e == io.EOF {
				closeErr := s.current.Close()
				s.current = nil
				if s.remaining != 0 {
					return n, io.ErrUnexpectedEOF
				}
				if hex.EncodeToString(s.chunkHash.Sum(nil)) != s.expectedHash {
					return n, errors.New("upload object hash differs from receipt")
				}
				if closeErr != nil {
					return n, closeErr
				}
				if n > 0 {
					return n, nil
				}
				continue
			}
			return n, e
		}
		if s.offset == s.total {
			return 0, io.EOF
		}
		if s.offset > s.total {
			return 0, errors.New("upload receipt exceeds total")
		}
		var c model.UploadChunk
		var e error
		if s.lookup != nil {
			c, e = s.lookup(s.ctx, s.offset)
		} else {
			c, e = s.service.lifecycle.uploadChunkAt(s.ctx, s.permit, s.offset)
		}
		if e != nil {
			return 0, e
		}
		if c.Size <= 0 || c.Size > s.total-s.offset {
			return 0, errors.New("invalid upload chunk receipt")
		}
		obj, e := s.service.files.OpenTransfer(s.ctx, s.namespace, c.ObjectID)
		if e != nil {
			return 0, e
		}
		if obj.Info.Size != c.Size {
			_ = obj.Body.Close()
			return 0, errors.New("upload object size differs from receipt")
		}
		s.current = obj.Body
		s.remaining = c.Size
		s.chunkHash = sha256.New()
		s.expectedHash = c.SHA256
	}
}
func (s *chunkStream) Close() error {
	if s.current != nil {
		return s.current.Close()
	}
	return nil
}
func (s *Uploads) stream(ctx context.Context, p *Permit, id string, total int64) (*chunkStream, error) {
	n, e := filestorage.NewTransferNamespace(id)
	if e != nil {
		return nil, e
	}
	return &chunkStream{ctx: ctx, service: s, permit: p, namespace: n, total: total}, nil
}
func (s *Uploads) commit(ctx context.Context, a transfer.Actor, project, task string, in UploadInput) (result map[string]any, err error) {
	total, e := number(in.TotalBytes)
	if e != nil {
		return nil, e
	}
	if in.SHA256 != "" && !validHash(in.SHA256) {
		return nil, uploadFault("Invalid upload hash.")
	}
	observed, e := s.bound(ctx, a, project, task, in.TransferID)
	if e != nil {
		return nil, e
	}
	if observed.State != "receiving" {
		result, err := uploadResult(observed)
		if err != nil {
			return nil, err
		}
		return result, transfer.ErrState
	}
	lease, e := s.attachments.AcquireUploadLease(ctx, a.Principal, project, task)
	if e != nil {
		return map[string]any{"transferId": in.TransferID, "writeOutcome": "not_committed"}, e
	}
	if !attachmentservice.RetainUploadLease(ctx, lease) {
		defer func() { err = errors.Join(err, lease.Close()) }()
	}
	p, e := s.lifecycle.AcquirePermit(ctx, a, in.TransferID)
	if e != nil {
		if errors.Is(e, transfer.ErrState) {
			if current, readErr := s.bound(ctx, a, project, task, in.TransferID); readErr == nil && current.State != "receiving" {
				result, resultErr := uploadResult(current)
				if resultErr != nil {
					return nil, resultErr
				}
				return result, e
			}
		}
		return nil, e
	}
	defer func() { err = errors.Join(err, p.Close()) }()
	r, e := s.lifecycle.admittedUploadRecord(p.Context, p)
	if e != nil {
		return nil, e
	}
	d, e := uploadDataOf(r)
	if e != nil {
		return nil, e
	}
	if r.State != "receiving" {
		result, _ := uploadResult(r)
		return result, transfer.ErrState
	}
	if total > attachmentcore.MaxFileBytes || d.NextOffset > attachmentcore.MaxFileBytes {
		return map[string]any{"transferId": r.ID, "writeOutcome": "not_committed"}, attachmentcore.FileTooLarge()
	}
	if d.NextOffset != total {
		return nil, uploadFault("Total does not match accepted bytes.")
	}
	namespace, e := filestorage.NewTransferNamespace(r.ID)
	if e != nil {
		return nil, e
	}
	admission, e := s.attachments.AdmitTransfer(p.Context, a.Principal, project, task, r.Path, r.ContentType, namespace)
	if e != nil {
		return map[string]any{"transferId": r.ID, "writeOutcome": "not_committed"}, e
	}
	defer func() { err = errors.Join(err, admission.Close()) }()
	opCtx, cancel := context.WithCancel(p.Context)
	done := make(chan error, 1)
	opID := uuid.NewString()
	go func() {
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-opCtx.Done():
				done <- nil
				return
			case <-ticker.C:
				if err := s.lifecycle.keepAdmittedUpload(opCtx, p, opID); err != nil {
					cancel()
					done <- err
					return
				}
			}
		}
	}()
	stopped := false
	stop := func() error {
		if stopped {
			return nil
		}
		stopped = true
		cancel()
		return <-done
	}
	defer func() { err = errors.Join(err, stop()) }()
	reader, e := s.stream(opCtx, p, r.ID, total)
	if e != nil {
		return nil, e
	}
	h := sha256.New()
	_, e = io.Copy(h, reader)
	e = errors.Join(e, reader.Close())
	if e != nil {
		return map[string]any{"transferId": r.ID, "writeOutcome": "not_committed"}, errors.Join(e, stop())
	}
	whole := hex.EncodeToString(h.Sum(nil))
	if in.SHA256 != "" && in.SHA256 != whole {
		return map[string]any{"transferId": r.ID, "writeOutcome": "not_committed"}, uploadFault("Upload hash does not match.")
	}
	_, e = s.lifecycle.reserveAdmittedUpload(opCtx, p, total)
	if e != nil {
		return map[string]any{"transferId": r.ID, "writeOutcome": "not_committed"}, e
	}
	d.OperationID = opID
	d.TotalBytes = &total
	d.SHA256 = whole
	d.WriteOutcome = "unknown"
	r, e = s.lifecycle.startAdmittedCommit(opCtx, p, encodeUpload(d))
	if e != nil {
		return map[string]any{"transferId": in.TransferID, "writeOutcome": "not_committed"}, e
	}
	var item model.Attachment
	var created bool
	item, created, e = admission.PutFromWithLease(opCtx, lease, func(scope store.AttachmentMutationScope) (io.ReadCloser, error) {
		reader, err := s.stream(opCtx, p, r.ID, total)
		if err != nil {
			return nil, err
		}
		reader.lookup = func(ctx context.Context, offset int64) (model.UploadChunk, error) {
			return scope.UploadChunkAt(ctx, r.ID, offset)
		}
		return reader, nil
	})
	renewErr := stop()
	if e == nil || (attachmentservice.FileEffectPossible(e) && operation.CompletionFacts(e).Outcome == store.TransactionCommitted) {
		d.WriteOutcome = "confirmed"
		d.Attachment = &item
		d.Created = &created
		result, finishErr := s.lifecycle.FinishCommit(ctx, p, a, r.ID, 0, "committed", encodeUpload(d))
		if finishErr != nil {
			return map[string]any{"transferId": r.ID, "operationId": d.OperationID, "writeOutcome": "confirmed", "attachment": attachmentWire(item), "created": created}, errors.Join(e, renewErr, finishErr)
		}
		cleanupCtx, cleanupCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		cleanupErr := s.lifecycle.requestAdmittedCleanup(cleanupCtx, p, d.OperationID)
		cleanupCancel()
		confirmed, resultErr := uploadResult(result)
		return confirmed, errors.Join(e, renewErr, cleanupErr, resultErr)
	}
	outcome := "unknown"
	if !attachmentservice.FileEffectPossible(e) {
		outcome = "not_committed"
	}
	d.WriteOutcome = outcome
	var finishErr, cleanupErr error
	if outcome == "not_committed" {
		if _, finishErr = s.lifecycle.FinishCommit(ctx, p, a, r.ID, 0, "failed", encodeUpload(d)); finishErr == nil {
			cleanupCtx, cleanupCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			cleanupErr = s.lifecycle.requestAdmittedCleanup(cleanupCtx, p, d.OperationID)
			cleanupCancel()
		}
	} else {
		finishCtx, finishCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer finishCancel()
		finishErr = s.lifecycle.markAdmittedUnknown(finishCtx, p, d.OperationID, encodeUpload(d))
	}
	return map[string]any{"transferId": r.ID, "operationId": d.OperationID, "writeOutcome": outcome}, fmt.Errorf("upload commit: %w", errors.Join(e, renewErr, finishErr, cleanupErr))
}
