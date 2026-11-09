// Package mcpdownload implements bounded reads of immutable attachment snapshots.
package mcpdownload

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"time"
	"unicode/utf8"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
)

const MaxChunkBytes = 512 << 10
const DefaultBytes = 8 << 10
const MaxPathBytes = 4096

type Opener interface {
	Open(context.Context, model.Principal, string, string, string) (model.Attachment, filestorage.Object, error)
}

type Input struct {
	ProjectID, TaskID, Path, Action, TransferID, Offset, Format string
	MaxBytes                                                    int
}

type Service struct {
	attachments   Opener
	lifecycle     *mcptransfer.Lifecycle
	files         filestorage.TransferStorage
	renewInterval time.Duration
}

func New(attachments Opener, lifecycle *mcptransfer.Lifecycle, files filestorage.TransferStorage) *Service {
	return &Service{attachments: attachments, lifecycle: lifecycle, files: files, renewInterval: 20 * time.Second}
}

type snapshot struct {
	Attachment model.Attachment `json:"attachment"`
	ObjectID   string           `json:"objectId"`
	TotalBytes int64            `json:"totalBytes"`
	SHA256     string           `json:"sha256"`
	Text       bool             `json:"text"`
}

func invalid(message string) error { return &model.Fault{Code: "invalid_input", Message: message} }
func stateError() error {
	return &model.Fault{Code: "transfer_state_conflict", Message: "Transfer is not readable."}
}
func wireAttachment(a model.Attachment) map[string]any {
	return map[string]any{"path": a.Path, "contentType": a.ContentType, "sizeBytes": strconv.FormatInt(a.SizeBytes, 10), "createdAt": a.CreatedAt.UTC(), "updatedAt": a.UpdatedAt.UTC()}
}
func reference(i Input) map[string]any {
	result := map[string]any{"projectId": i.ProjectID, "taskId": i.TaskID}
	if i.TransferID != "" {
		result["transferId"] = i.TransferID
	} else {
		result["path"] = i.Path
	}
	return result
}
func (s *Service) Read(ctx context.Context, actor mcptransfer.Actor, in Input) (map[string]any, error) {
	return s.ReadAdmitted(ctx, actor, in, nil)
}

// ReadAdmitted invokes admitContent before new snapshot work can wait on I/O.
// Existing transfers need only the bounded control path.
func (s *Service) ReadAdmitted(ctx context.Context, actor mcptransfer.Actor, in Input, admitContent func(context.Context) error) (map[string]any, error) {
	if s == nil || s.attachments == nil || s.lifecycle == nil || s.files == nil {
		return nil, errors.New("download dependencies are required")
	}
	if in.Action == "" {
		in.Action = "inspect"
	}
	if in.Format == "" {
		in.Format = "auto"
	}
	if in.MaxBytes == 0 {
		in.MaxBytes = DefaultBytes
	}
	if in.Format != "auto" && in.Format != "text" && in.Format != "base64" {
		return nil, invalid("Invalid read format.")
	}
	if in.MaxBytes < 1 || in.MaxBytes > MaxChunkBytes {
		return nil, invalid("Invalid maximum byte count.")
	}
	project, err := model.CanonicalID(in.ProjectID)
	if err != nil {
		return nil, err
	}
	in.ProjectID = project
	task, err := model.CanonicalID(in.TaskID)
	if err != nil {
		return nil, err
	}
	in.TaskID = task
	switch in.Action {
	case "inspect", "inline", "open":
		if _, err := attachmentcore.NewAddress(in.ProjectID, in.TaskID, in.Path); err != nil {
			return nil, err
		}
		if len(in.Path) > MaxPathBytes {
			return nil, &model.Fault{Code: "resource_conflict", Message: "Attachment path exceeds the supported read limit."}
		}
	case "chunk", "close":
		if _, err := model.CanonicalID(in.TransferID); err != nil {
			return nil, err
		}
	default:
		return nil, invalid("Invalid read action.")
	}
	switch in.Action {
	case "inspect":
		return s.inspect(ctx, actor, in)
	case "inline":
		return s.inline(ctx, actor, in)
	case "open":
		return s.open(ctx, actor, in, admitContent)
	case "chunk":
		return s.chunk(ctx, actor, in)
	default:
		return s.close(ctx, actor, in)
	}
}
func (s *Service) inspect(ctx context.Context, a mcptransfer.Actor, in Input) (map[string]any, error) {
	metadata, obj, err := s.source(ctx, a, in)
	if err != nil {
		return nil, err
	}
	if err = obj.Body.Close(); err != nil {
		return nil, err
	}
	if err = s.lifecycle.Authorize(ctx, a, in.ProjectID, in.TaskID); err != nil {
		return nil, err
	}
	return map[string]any{"attachment": wireAttachment(metadata), "sizeBytes": strconv.FormatInt(obj.Info.Size, 10), "contentRef": reference(in), "contentIncluded": false}, nil
}
func (s *Service) inline(ctx context.Context, a mcptransfer.Actor, in Input) (map[string]any, error) {
	metadata, obj, err := s.source(ctx, a, in)
	if err != nil {
		return nil, err
	}
	defer obj.Body.Close()
	if err = s.lifecycle.Authorize(ctx, a, in.ProjectID, in.TaskID); err != nil {
		return nil, err
	}
	if obj.Info.Size < 0 || obj.Info.Size > int64(in.MaxBytes) {
		return nil, &model.Fault{Code: "content_too_large", Message: "Content exceeds the inline limit; use open and chunk."}
	}
	b, err := io.ReadAll(io.LimitReader(obj.Body, int64(in.MaxBytes)+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) != obj.Info.Size {
		return nil, errors.New("attachment size changed during inline read")
	}
	if err = s.lifecycle.Authorize(ctx, a, in.ProjectID, in.TaskID); err != nil {
		return nil, err
	}
	data := map[string]any{"attachment": wireAttachment(metadata), "sizeBytes": strconv.Itoa(len(b))}
	return encode(data, in, b, true)
}

// A failed transaction can carry an earlier not-found cause; only a
// confirmed refusal may select the missing-snapshot fallback.
func confirmedMissing(err error) bool {
	fault, known := operation.KnownFault(err)
	return known && fault.Code == "not_found" && errors.Is(err, model.ErrNotFound)
}

// A later successful observation cannot repair unconfirmed transaction cleanup.
func unsafeCompletion(err error) bool {
	facts := operation.CompletionFacts(err)
	return facts.CleanupFailed || (facts.Outcome != "" && facts.Outcome != store.TransactionNotCommitted) ||
		(facts.Phase != "" && (facts.Phase != "operation" || facts.Outcome != store.TransactionNotCommitted))
}

func (s *Service) open(ctx context.Context, a mcptransfer.Actor, in Input, admitContent func(context.Context) error) (result map[string]any, resultErr error) {
	binding := mcptransfer.Binding{ID: in.TransferID, Direction: "download", ProjectID: in.ProjectID, TaskID: in.TaskID, Path: in.Path}
	existing, lookupErr := s.lifecycle.LookupBound(ctx, a, in.TransferID)
	if lookupErr == nil {
		return s.existingOpen(ctx, a, binding, existing)
	}
	if lookupErr != nil {
		if !confirmedMissing(lookupErr) {
			return nil, lookupErr
		}
		if admitContent != nil {
			if err := admitContent(ctx); err != nil {
				return nil, err
			}
		}
		_, source, err := s.source(ctx, a, in)
		if err == nil {
			err = source.Body.Close()
		}
		if err != nil {
			if unsafeCompletion(err) {
				return nil, err
			}
			_, recheckErr := s.lifecycle.LookupBound(ctx, a, in.TransferID)
			if confirmedMissing(recheckErr) {
				return nil, err
			}
			if recheckErr != nil {
				return nil, recheckErr
			}
		}
	}
	record, created, err := s.lifecycle.OpenRecord(ctx, a, binding)
	if err != nil {
		return nil, err
	}
	if !created {
		return s.existingOpen(ctx, a, binding, record)
	}
	publicationStarted := false
	defer func() {
		if resultErr == nil || publicationStarted {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if _, err := s.lifecycle.RequestCleanup(cleanupCtx, a, in.TransferID); err == nil {
			_ = s.lifecycle.Maintain(cleanupCtx)
		}
	}()
	opCtx, cancel := context.WithDeadline(ctx, record.HardExpiresAt)
	renewal := s.startRenewal(opCtx, cancel, a, in.TransferID)
	var permit *mcptransfer.Permit
	defer func() {
		_ = renewal.stop()
		if permit != nil {
			_ = permit.Close()
		}
		cancel()
	}()
	permit, err = s.lifecycle.AcquirePermit(opCtx, a, in.TransferID)
	if err != nil {
		return nil, err
	}
	copyCtx := permit.Context
	metadata, obj, err := s.source(copyCtx, a, in)
	if err != nil {
		return nil, err
	}
	defer obj.Body.Close()
	if obj.Info.Size < 0 {
		return nil, errors.New("invalid attachment size")
	}
	record, err = s.lifecycle.Reserve(copyCtx, a, in.TransferID, obj.Info.Size)
	if err != nil {
		return nil, err
	}
	ns, err := filestorage.NewTransferNamespace(in.TransferID)
	if err != nil {
		return nil, err
	}
	h := sha256.New()
	validator := &utf8Stream{}
	publicationStarted = true
	info, err := s.files.PutTransfer(copyCtx, ns, in.TransferID, io.TeeReader(obj.Body, io.MultiWriter(h, validator)))
	if err != nil {
		return nil, err
	}
	if info.Size != obj.Info.Size {
		return nil, errors.New("attachment size changed during snapshot")
	}
	if err = renewal.stop(); err != nil {
		return nil, err
	}
	if err = copyCtx.Err(); err != nil {
		return nil, err
	}
	meta := snapshot{Attachment: metadata, ObjectID: in.TransferID, TotalBytes: info.Size, SHA256: hex.EncodeToString(h.Sum(nil)), Text: validator.Valid()}
	data, err := json.Marshal(meta)
	if err != nil {
		return nil, err
	}
	record, err = s.lifecycle.PublishDownload(copyCtx, permit, a, in.TransferID, data, info.Size)
	if err != nil {
		return nil, err
	}
	return openResult(record)
}

func (s *Service) existingOpen(ctx context.Context, a mcptransfer.Actor, binding mcptransfer.Binding, record model.PrivateTransfer) (map[string]any, error) {
	if !transfer.SameBinding(record, a, binding, json.RawMessage(`{}`)) {
		return nil, mcptransfer.ErrConflict
	}
	record, err := s.lifecycle.Touch(ctx, a, binding.ID)
	if err != nil {
		return nil, err
	}
	if !transfer.SameBinding(record, a, binding, json.RawMessage(`{}`)) {
		return nil, mcptransfer.ErrConflict
	}
	return openResult(record)
}

// source rechecks the credential and authority even when opening fails, so a
// revoked caller cannot learn whether the attachment exists.
func (s *Service) source(ctx context.Context, a mcptransfer.Actor, in Input) (model.Attachment, filestorage.Object, error) {
	metadata, obj, openErr := s.attachments.Open(ctx, a.Principal, in.ProjectID, in.TaskID, in.Path)
	if unsafeCompletion(openErr) {
		if obj.Body != nil {
			openErr = errors.Join(openErr, obj.Body.Close())
		}
		return model.Attachment{}, filestorage.Object{}, openErr
	}
	if err := s.lifecycle.Authorize(ctx, a, in.ProjectID, in.TaskID); err != nil {
		if obj.Body != nil {
			_ = obj.Body.Close()
		}
		return model.Attachment{}, filestorage.Object{}, err
	}
	return metadata, obj, openErr
}
func openResult(r model.PrivateTransfer) (map[string]any, error) {
	result := map[string]any{"transferId": r.ID, "direction": "download", "state": r.State, "maxChunkBytes": MaxChunkBytes, "expiresAt": r.ExpiresAt.UTC()}
	result["contentRef"] = map[string]any{"projectId": r.ProjectID, "taskId": r.TaskID, "transferId": r.ID}
	if r.State == "readable" {
		var meta snapshot
		if err := json.Unmarshal(r.Data, &meta); err != nil {
			return nil, err
		}
		result["attachment"] = wireAttachment(meta.Attachment)
		result["totalBytes"] = strconv.FormatInt(meta.TotalBytes, 10)
		result["sha256"] = meta.SHA256
		result["nextOffset"] = "0"
	}
	return result, nil
}
func (s *Service) bound(ctx context.Context, a mcptransfer.Actor, in Input) (model.PrivateTransfer, error) {
	r, err := s.lifecycle.LookupBound(ctx, a, in.TransferID)
	if err != nil {
		return r, err
	}
	if r.Direction != "download" || r.ProjectID != in.ProjectID || r.TaskID != in.TaskID {
		return model.PrivateTransfer{}, mcptransfer.ErrConflict
	}
	return r, nil
}
func (s *Service) chunk(ctx context.Context, a mcptransfer.Actor, in Input) (map[string]any, error) {
	offset, err := strconv.ParseInt(in.Offset, 10, 64)
	if err != nil || offset < 0 || strconv.FormatInt(offset, 10) != in.Offset {
		return nil, invalid("Invalid offset.")
	}
	r, err := s.bound(ctx, a, in)
	if err != nil {
		return nil, err
	}
	if r.State != "readable" {
		return nil, stateError()
	}
	permit, err := s.lifecycle.AcquirePermit(ctx, a, in.TransferID)
	if err != nil {
		return nil, err
	}
	defer permit.Close()
	r, err = s.bound(permit.Context, a, in)
	if err != nil {
		return nil, err
	}
	if r.State != "readable" {
		return nil, stateError()
	}
	var meta snapshot
	if err = json.Unmarshal(r.Data, &meta); err != nil {
		return nil, err
	}
	if offset > meta.TotalBytes {
		return nil, invalid("Offset exceeds content size.")
	}
	if in.Format == "auto" && !meta.Text {
		r, err = s.lifecycle.Touch(permit.Context, a, in.TransferID)
		if err != nil {
			return nil, err
		}
		if r.State != "readable" {
			return nil, stateError()
		}
		return map[string]any{"transferId": in.TransferID, "state": "readable", "offset": in.Offset, "totalBytes": strconv.FormatInt(meta.TotalBytes, 10), "expiresAt": r.ExpiresAt.UTC(), "contentRef": reference(in), "contentIncluded": false, "requiresExplicitBinaryRead": true}, nil
	}
	if in.Format == "auto" {
		in.Format = "text"
	}
	ns, err := filestorage.NewTransferNamespace(in.TransferID)
	if err != nil {
		return nil, err
	}
	obj, err := s.files.OpenTransferRange(permit.Context, ns, meta.ObjectID, offset, int64(in.MaxBytes))
	if err != nil {
		return nil, err
	}
	defer obj.Body.Close()
	if obj.Info.Size != meta.TotalBytes {
		return nil, errors.New("snapshot size differs from receipt")
	}
	b, err := io.ReadAll(io.LimitReader(obj.Body, int64(in.MaxBytes)+1))
	if err != nil {
		return nil, err
	}
	if len(b) > in.MaxBytes || int64(len(b)) != min(int64(in.MaxBytes), meta.TotalBytes-offset) {
		return nil, errors.New("snapshot range was incomplete")
	}
	r, err = s.lifecycle.Touch(permit.Context, a, in.TransferID)
	if err != nil {
		return nil, err
	}
	if r.State != "readable" {
		return nil, stateError()
	}
	data := map[string]any{"transferId": in.TransferID, "state": "readable", "offset": in.Offset, "totalBytes": strconv.FormatInt(meta.TotalBytes, 10), "expiresAt": r.ExpiresAt.UTC()}
	return encode(data, in, b, offset+int64(len(b)) == meta.TotalBytes)
}
func encode(data map[string]any, in Input, b []byte, atEnd bool) (map[string]any, error) {
	if in.Format != "base64" {
		n, valid := textPrefix(b, atEnd)
		if !valid {
			if in.Format == "text" {
				return nil, &model.Fault{Code: "invalid_encoding", Message: "Content is not complete UTF-8 at this offset; use base64."}
			}
			data["contentRef"] = reference(in)
			data["contentIncluded"] = false
			data["requiresExplicitBinaryRead"] = true
			return data, nil
		}
		b = b[:n]
		data["encoding"] = "utf8"
		data["text"] = string(b)
	} else {
		data["encoding"] = "base64"
		data["contentBase64"] = base64.StdEncoding.EncodeToString(b)
	}
	digest := sha256.Sum256(b)
	data["sha256"] = hex.EncodeToString(digest[:])
	if in.Action == "chunk" {
		offset, _ := strconv.ParseInt(in.Offset, 10, 64)
		next := offset + int64(len(b))
		total, _ := strconv.ParseInt(data["totalBytes"].(string), 10, 64)
		data["readBytes"] = strconv.Itoa(len(b))
		data["nextOffset"] = strconv.FormatInt(next, 10)
		data["eof"] = next == total
	} else {
		data["eof"] = true
	}
	return data, nil
}

// textPrefix distinguishes an incomplete final character from an invalid byte.
func textPrefix(b []byte, atEnd bool) (int, bool) {
	for i := 0; i < len(b); {
		if !utf8.FullRune(b[i:]) && !atEnd {
			return i, i != 0
		}
		r, size := utf8.DecodeRune(b[i:])
		if r == utf8.RuneError && size == 1 {
			return 0, false
		}
		i += size
	}
	return len(b), true
}
func (s *Service) close(ctx context.Context, a mcptransfer.Actor, in Input) (map[string]any, error) {
	_, err := s.bound(ctx, a, in)
	if err != nil {
		return nil, err
	}
	r, err := s.lifecycle.RequestCleanup(ctx, a, in.TransferID)
	if err != nil {
		return nil, err
	}
	cleanup := "pending"
	if r.State == "closed" {
		cleanup = "complete"
	}
	return map[string]any{"transferId": in.TransferID, "state": r.State, "cleanupState": cleanup}, nil
}
