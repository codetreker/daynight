package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

const imageChunkBytes = 512 * 1024

func (s *Execution) imageTarget(p model.Principal, r *record, target sp.ImageTarget) error {
	if r.Snapshot.ContentRevision != sp.ContentRevision {
		return fault("component_unsupported", "Upgrade the original controller to use Session images.")
	}
	if target.ServerOrigin != s.Origin || target.ActorUserID != p.UserID || p.UserID != r.Owner || target.Fence != r.Snapshot.Fence || !sameNative(target.ExpectedNativeSessionID, r.Snapshot.Identity.NativeSessionID) {
		return conflict()
	}
	return nil
}
func sameNative(a, b *string) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }
func (s *Execution) prepareUpload(ctx context.Context, p model.Principal, project, taskID, id string, spec sp.ImageUploadSpec, remote bool, desiredBlob ...string) (sp.ImageUploadReceipt, bool, error) {
	var out sp.ImageUploadReceipt
	created := false
	validate := sp.DecodeImageUploadSpec
	if !remote {
		validate = sp.DecodeImageDisplayUploadSpec
	}
	if _, err := validate(encode(spec)); err != nil {
		return out, false, fault("invalid_input", "Invalid image upload specification.")
	}
	err := s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, _ task, write bool) error {
		if !write {
			return denied()
		}
		if remote {
			if e := s.admitImageRate(ctx, tx, p.UserID, "prepare"); e != nil {
				return e
			}
		}
		if err := s.imageTarget(p, r, spec.Target); err != nil {
			return err
		}
		d, e := resourceDAO(tx)
		if e != nil {
			return e
		}
		old, e := d.SessionUpload(ctx, id, spec.UploadID)
		if e == nil {
			if old.ActorID != p.UserID || !jsonEqual(encode(old.Spec), encode(spec)) {
				return fault("resource_conflict", "Upload identity already has different content.")
			}
			if old, e = s.expireUploadLocked(ctx, tx, r, old); e != nil {
				return e
			}
			out = old.Receipt
			return nil
		}
		if !errors.Is(e, model.ErrNotFound) {
			return e
		}
		if remote {
			exists, err := d.SessionImageUploadExists(ctx, id, spec.ImageID)
			if err != nil {
				return err
			}
			if exists {
				return fault("resource_conflict", "The image identity already has an original upload.")
			}
			if e = requireImageHistoryLedger(ctx, tx, r, false); e != nil {
				return e
			}
		}
		usage, e := d.SessionResourceUsage(ctx, id)
		if e != nil {
			return e
		}
		if usage.Deleting || usage.Frozen {
			return fault("resource_conflict", "Session resource deletion has begun.")
		}
		size := number(spec.ByteLength)
		if !remote && len(desiredBlob) > 0 {
			captureID := spec.UploadID
			if len(desiredBlob) > 1 {
				captureID = desiredBlob[1]
			}
			capture, e := d.SessionCapture(ctx, id, captureID)
			if e != nil {
				return e
			}
			if capture.Validated == nil || capture.Receipt.State != "copying" || capture.Receipt.ResourceID == nil || *capture.Receipt.ResourceID != desiredBlob[0] || capture.Request.Occurrence.ImageID != spec.ImageID {
				return conflict()
			}
			usage.ReservedBytes -= number(capture.Validated.ByteLength)
			usage.ReservedResources--
			usage.GlobalReservedBytes -= 2 * number(capture.Validated.ByteLength)
		}
		if usage.UploadIdentities >= sp.MaxUploadIdentities {
			return fault("quota_exceeded", "Session image upload identity capacity is exhausted.")
		}
		if e = s.admitImageResource(ctx, usage, size); e != nil {
			return e
		}
		expires := s.now().Add(24 * time.Hour).UTC().Truncate(time.Microsecond)
		out = sp.ImageUploadReceipt{UploadID: spec.UploadID, ImageID: spec.ImageID, Target: spec.Target, State: "receiving", AcceptedOffset: "0", Spec: sp.ImageUploadMetadata{Name: spec.Name, MediaType: spec.MediaType, ByteLength: spec.ByteLength, SHA256: spec.SHA256}, ExpiresAt: expires.Format(time.RFC3339Nano)}
		created = true
		blob := uuid.NewString()
		if len(desiredBlob) > 0 {
			blob = desiredBlob[0]
		}
		return s.saveImageUpload(ctx, tx, r, store.SessionUploadRecord{SessionID: id, ActorID: p.UserID, BlobID: blob, Spec: spec, Receipt: out, ExpiresAt: expires})
	})
	return out, created, err
}
func (s *Execution) upload(ctx context.Context, tx *operationTx, r *record, p model.Principal, id string) (store.SessionResourceDAO, store.SessionUploadRecord, error) {
	d, e := resourceDAO(tx)
	if e != nil {
		return nil, store.SessionUploadRecord{}, e
	}
	u, e := d.SessionUpload(ctx, r.Snapshot.SessionID, id)
	if e != nil {
		return d, u, e
	}
	if u.ActorID != p.UserID {
		return d, u, denied()
	}
	return d, u, nil
}
func (s *Execution) GetUpload(ctx context.Context, p model.Principal, project, taskID, id, uploadID string) (out sp.ImageUploadReceipt, result error) {
	access := func(ctx context.Context, work func(*operationTx, *record) error) error {
		return s.archiveAccess(ctx, p, project, taskID, id, false, func(tx *operationTx, r *record, _ task) error {
			if _, _, e := s.upload(ctx, tx, r, p, uploadID); e != nil {
				return e
			}
			return work(tx, r)
		})
	}
	err := access(ctx, func(tx *operationTx, r *record) error {
		if e := s.admitImageRate(ctx, tx, p.UserID, "observe"); e != nil {
			return e
		}
		_, u, e := s.upload(ctx, tx, r, p, uploadID)
		if e != nil {
			return e
		}
		if u, e = s.expireUploadLocked(ctx, tx, r, u); e != nil {
			return e
		}
		out = u.Receipt
		return nil
	})
	if err == nil && (out.State == "expired" || out.State == "released" || out.State == "failed") {
		if s.files == nil {
			return out, fault("component_unsupported", "Resource storage is unavailable.")
		}
		ioContext, finish, e := s.beginImageIO(ctx, id, uuid.NewString())
		if e != nil {
			return out, e
		}
		ctx = ioContext
		defer func() { result = joinImageCleanup(result, finish) }()
		gate, e := s.files.AcquireGate(ctx, filestorage.PrivateGate, "session-image-upload/"+id+"/"+uploadID)
		if e != nil {
			return out, e
		}
		err = s.cleanupUploadStorage(ctx, project, id, uploadID, access, func(ctx context.Context) error {
			return s.releaseControllerPreparationWithAccess(ctx, id, uploadID, access)
		})
		err = errors.Join(err, gate.Close())
	}
	return out, err
}
func (s *Execution) releaseImageLease(ctx context.Context, p model.Principal, project, taskID, id, lease string) error {
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if s.releaseMediaLeaseRun != nil {
		return s.releaseMediaLeaseRun(cleanup, id, lease)
	}
	return s.browser(cleanup, p, project, taskID, id, func(tx *operationTx, _ *record, _ task, _ bool) error {
		d, e := resourceDAO(tx)
		if e != nil {
			return e
		}
		return d.ReleaseSessionResourceLease(cleanup, id, lease)
	})
}
func (s *Execution) writeUploadChunk(ctx context.Context, p model.Principal, project, taskID, id, uploadID string, input sp.ImageChunkWrite, remote bool) (out sp.ImageUploadReceipt, result error) {
	chunk, e := base64.StdEncoding.Strict().DecodeString(input.Data)
	sum := sha256.Sum256(chunk)
	if e != nil || len(chunk) == 0 || len(chunk) > imageChunkBytes || input.UploadID != uploadID || hex.EncodeToString(sum[:]) != input.SHA256 || decimal(number(input.Offset)) != input.Offset {
		return out, fault("invalid_input", "Invalid image upload chunk.")
	}
	if s.files == nil {
		return out, fault("component_unsupported", "Resource storage is unavailable.")
	}
	gate, e := s.files.AcquireGate(ctx, filestorage.PrivateGate, "session-image-upload/"+id+"/"+uploadID)
	if e != nil {
		return out, e
	}
	defer func() { result = errors.Join(result, gate.Close()) }()
	lease := uuid.NewString()
	ioContext, finishIO, ioErr := s.beginImageIO(ctx, id, lease)
	if ioErr != nil {
		return out, ioErr
	}
	ctx = ioContext
	defer func() { result = joinImageCleanup(result, finishIO) }()
	var previousUpload store.SessionUploadRecord
	var path string
	duplicate := false
	e = s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, _ task, write bool) error {
		if !write {
			return denied()
		}
		if remote {
			if e := s.admitImageRate(ctx, tx, p.UserID, "control"); e != nil {
				return e
			}
		}
		d, u, e := s.upload(ctx, tx, r, p, uploadID)
		if e != nil {
			return e
		}
		if e = s.imageTarget(p, r, u.Spec.Target); e != nil {
			return e
		}
		if !s.now().Before(u.ExpiresAt) || u.Receipt.State != "receiving" {
			return fault("resource_conflict", "Upload no longer accepts chunks.")
		}
		offset := number(input.Offset)
		chunks, e := d.SessionUploadChunks(ctx, id, uploadID)
		if e != nil {
			return e
		}
		for _, old := range chunks {
			if old.Offset == offset {
				if old.SHA256 != input.SHA256 || old.ByteLength != int64(len(chunk)) {
					return fault("resource_conflict", "Chunk identity already has different content.")
				}
				out = u.Receipt
				duplicate = true
				return nil
			}
		}
		if offset != number(u.Receipt.AcceptedOffset) || offset+int64(len(chunk)) > number(u.Spec.ByteLength) {
			return fault("resource_conflict", "Upload chunks must be contiguous and within the original length.")
		}
		n, e := sessionresource.NewNamespace(project, r.Owner, id)
		if e != nil {
			return e
		}
		path, e = n.ChunkPath(uploadID, offset)
		if e != nil {
			return e
		}
		usage, e := d.SessionResourceUsage(ctx, id)
		if e != nil {
			return e
		}
		previousUpload = u
		return acquireImageResourceLease(ctx, d, store.SessionResourceLease{SessionID: id, ID: lease, OwnerID: r.Owner, Kind: "write", DeleteEpoch: usage.DeleteEpoch})
	})
	if e != nil {
		return out, e
	}
	if duplicate {
		return out, nil
	}
	defer func() { result = errors.Join(result, s.releaseImageLease(ctx, p, project, taskID, id, lease)) }()
	if e = s.publishImageBytes(ctx, path, bytes.NewReader(chunk), int64(len(chunk)), input.SHA256); e != nil {
		return out, e
	}
	e = s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, _ task, write bool) error {
		if !write {
			return denied()
		}
		d, u, e := s.upload(ctx, tx, r, p, uploadID)
		if e != nil {
			return e
		}
		if e = s.imageTarget(p, r, u.Spec.Target); e != nil {
			return e
		}
		usage, e := d.SessionResourceUsage(ctx, id)
		if e != nil {
			return e
		}
		if usage.Deleting || usage.Frozen || u.Receipt.State != "receiving" || u.Receipt.AcceptedOffset != previousUpload.Receipt.AcceptedOffset {
			return conflict()
		}
		if e = d.InsertSessionUploadChunk(ctx, store.SessionUploadChunk{SessionID: id, UploadID: uploadID, Path: path, Offset: number(input.Offset), ByteLength: int64(len(chunk)), SHA256: input.SHA256}); e != nil {
			return e
		}
		u.Receipt.AcceptedOffset = decimal(number(input.Offset) + int64(len(chunk)))
		out = u.Receipt
		return s.saveImageUpload(ctx, tx, r, u)
	})
	return out, e
}

// publishImageBytes reconciles an earlier uncertain publication at its exact
// immutable path. It never substitutes a fresh blob identity after an error.
func (s *Execution) publishImageBytes(ctx context.Context, path string, input io.Reader, size int64, digest string) error {
	existing, err := s.files.Open(ctx, sessionresource.Bucket, path)
	if err == nil {
		h := sha256.New()
		n, e := io.Copy(h, io.LimitReader(existing.Body, size+1))
		e = errors.Join(e, existing.Body.Close())
		if e != nil {
			return e
		}
		if n != size || hex.EncodeToString(h.Sum(nil)) != digest {
			return fault("resource_conflict", "Existing resource bytes do not match their immutable identity.")
		}
		return nil
	}
	if !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, model.ErrNotFound) {
		return err
	}
	h := sha256.New()
	info, err := s.files.Put(ctx, sessionresource.Bucket, path, io.TeeReader(io.LimitReader(input, size+1), h))
	if err != nil {
		return err
	}
	if info.Size != size || hex.EncodeToString(h.Sum(nil)) != digest {
		return fault("resource_conflict", "Resource bytes do not match the declared content.")
	}
	return nil
}
func (s *Execution) completeUpload(ctx context.Context, p model.Principal, project, taskID, id, uploadID string, input sp.ImageUploadComplete, remote bool) (out sp.ImageUploadReceipt, result error) {
	if _, err := sp.DecodeImageUploadComplete(encode(input)); err != nil {
		return out, fault("invalid_input", "Invalid image upload completion.")
	}
	if s.files == nil || s.imageDecoder == nil {
		return out, fault("component_unsupported", "Full image validation is unavailable.")
	}
	gate, e := s.files.AcquireGate(ctx, filestorage.PrivateGate, "session-image-upload/"+id+"/"+uploadID)
	if e != nil {
		return out, e
	}
	defer func() { result = errors.Join(result, gate.Close()) }()
	var upload store.SessionUploadRecord
	var chunks []store.SessionUploadChunk
	var path string
	lease := uuid.NewString()
	ioContext, finishIO, ioErr := s.beginImageIO(ctx, id, lease)
	if ioErr != nil {
		return out, ioErr
	}
	ctx = ioContext
	defer func() { result = joinImageCleanup(result, finishIO) }()
	completed := false
	e = s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, _ task, write bool) error {
		if !write {
			return denied()
		}
		if remote {
			if e := s.admitImageRate(ctx, tx, p.UserID, "control"); e != nil {
				return e
			}
		}
		d, u, e := s.upload(ctx, tx, r, p, uploadID)
		if e != nil {
			return e
		}
		if input.SHA256 != u.Spec.SHA256 || input.ByteLength != u.Spec.ByteLength {
			return fault("resource_conflict", "Completion must match the original upload specification.")
		}
		if u.Receipt.State == "complete" {
			expired, err := imageUploadExpiryEligible(ctx, d, u, s.now())
			if err != nil {
				return err
			}
			if expired {
				return fault("upload_expired", "The original image upload expired before completion replay.")
			}
			out = u.Receipt
			upload = u
			completed = true
			return nil
		}
		if e = s.imageTarget(p, r, u.Spec.Target); e != nil {
			return e
		}
		if !s.now().Before(u.ExpiresAt) || (u.Receipt.State != "receiving" && u.Receipt.State != "verifying") || u.Receipt.AcceptedOffset != u.Spec.ByteLength {
			return fault("resource_conflict", "Upload is incomplete or no longer accepts completion.")
		}
		chunks, e = d.SessionUploadChunks(ctx, id, uploadID)
		if e != nil {
			return e
		}
		usage, e := d.SessionResourceUsage(ctx, id)
		if e != nil {
			return e
		}
		if e = acquireImageResourceLease(ctx, d, store.SessionResourceLease{SessionID: id, ID: lease, OwnerID: r.Owner, Kind: "write", DeleteEpoch: usage.DeleteEpoch}); e != nil {
			return e
		}
		path, e = BlobAddress(project, r.Owner, id, u.BlobID)
		if e != nil {
			return e
		}
		u.Receipt.State = "verifying"
		upload = u
		return s.saveImageUpload(ctx, tx, r, u)
	})
	if e != nil {
		return out, e
	}
	if completed {
		if !upload.StorageReleased {
			if e = s.cleanupUploadFiles(ctx, p, project, taskID, id, uploadID); e != nil {
				return out, e
			}
		}
		return out, nil
	}
	defer func() { result = errors.Join(result, s.releaseImageLease(ctx, p, project, taskID, id, lease)) }()
	// Only an explicit validation rejection establishes failure. Timeouts,
	// cancellation, storage/DB errors and component loss retain verifying identity.
	defer func() {
		imageError := definiteImageFailure(result)
		if imageError == nil {
			return
		}
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		e := s.browser(cleanup, p, project, taskID, id, func(tx *operationTx, r *record, _ task, _ bool) error {
			_, current, e := s.upload(cleanup, tx, r, p, uploadID)
			if e != nil {
				return e
			}
			if current.Receipt.State != "verifying" {
				return nil
			}
			current.Receipt.State, current.Receipt.Error = "failed", imageError
			out = current.Receipt
			return s.saveImageUpload(cleanup, tx, r, current)
		})
		result = errors.Join(result, e)
	}()
	// Chunk metadata and files form one bounded sequence. Every reader is closed
	// before lease release, including decoder errors and request cancellation.
	open := func() (io.Reader, func() error, error) {
		readers := []io.Reader{}
		closers := []io.Closer{}
		closeAll := func() error {
			var err error
			for _, c := range closers {
				err = errors.Join(err, c.Close())
			}
			return err
		}
		offset := int64(0)
		for _, c := range chunks {
			if c.Offset != offset {
				return nil, closeAll, fault("resource_conflict", "Saved upload chunks are not contiguous.")
			}
			o, e := s.files.Open(ctx, sessionresource.Bucket, c.Path)
			if e != nil {
				return nil, closeAll, errors.Join(e, closeAll())
			}
			closers = append(closers, o.Body)
			if o.Info.Size != c.ByteLength {
				return nil, closeAll, errors.Join(fault("resource_conflict", "Saved upload chunk length changed."), closeAll())
			}
			readers = append(readers, io.LimitReader(o.Body, c.ByteLength))
			offset += c.ByteLength
		}
		if offset != number(upload.Spec.ByteLength) {
			return nil, closeAll, errors.Join(fault("resource_conflict", "Saved upload length changed."), closeAll())
		}
		return io.MultiReader(readers...), closeAll, nil
	}
	var controllerValidated *sp.ValidatedImage
	if remote {
		if _, e = s.controllerMedia(ctx, p, project, taskID, id, mediaIdentity(uploadID, "prepare"), "prepare", upload.Spec); e != nil {
			return out, e
		}
		for _, chunk := range chunks {
			o, err := s.files.Open(ctx, sessionresource.Bucket, chunk.Path)
			if err != nil {
				return out, err
			}
			data, err := io.ReadAll(io.LimitReader(o.Body, imageChunkBytes+1))
			err = errors.Join(err, o.Body.Close())
			if err != nil {
				return out, err
			}
			body := sp.ImageChunkWrite{UploadID: uploadID, Offset: decimal(chunk.Offset), SHA256: chunk.SHA256, Data: base64.StdEncoding.EncodeToString(data)}
			if _, e = s.controllerMedia(ctx, p, project, taskID, id, mediaIdentity(uploadID, "write/"+body.Offset), "write", body); e != nil {
				return out, e
			}
		}
		reply, err := s.controllerMedia(ctx, p, project, taskID, id, mediaIdentity(uploadID, "complete"), "complete", map[string]any{"uploadId": uploadID, "sha256": input.SHA256, "byteLength": input.ByteLength})
		if err != nil {
			return out, err
		}
		var prepared sp.LocalImagePreparation
		if json.Unmarshal(reply, &prepared) == nil && prepared.UploadID == uploadID && prepared.ImageID == upload.Spec.ImageID && jsonEqual(encode(prepared.Target), encode(upload.Spec.Target)) && prepared.Error != nil {
			return out, fault(prepared.Error.Code, prepared.Error.Message)
		}
		if json.Unmarshal(reply, &prepared) != nil || prepared.UploadID != uploadID || prepared.ImageID != upload.Spec.ImageID || prepared.State != "validated" || prepared.AcceptedOffset != upload.Spec.ByteLength || !jsonEqual(encode(prepared.Target), encode(upload.Spec.Target)) || prepared.Validated == nil {
			return out, fault("resource_conflict", "Controller did not validate the complete image original.")
		}
		controllerValidated = prepared.Validated
	}
	reader, closeReaders, e := open()
	if e != nil {
		return out, e
	}
	validated, e := s.imageDecoder(ctx, reader, number(upload.Spec.ByteLength), upload.Spec.SHA256)
	e = errors.Join(e, closeReaders())
	if e != nil {
		return out, e
	}
	if controllerValidated != nil && !jsonEqual(encode(controllerValidated), encode(validated)) {
		return out, fault("resource_conflict", "Controller and service image validation differ.")
	}
	if validated.MediaType != upload.Spec.MediaType || validated.ByteLength != upload.Spec.ByteLength || validated.SHA256 != upload.Spec.SHA256 {
		return out, fault("resource_conflict", "Decoded image does not match the upload specification.")
	}
	if _, e = sp.DecodeValidatedImage(encode(validated)); e != nil {
		return out, fault("resource_conflict", "Decoder returned invalid image metadata.")
	}
	reader, closeReaders, e = open()
	if e != nil {
		return out, e
	}
	e = s.publishImageBytes(ctx, path, reader, number(upload.Spec.ByteLength), upload.Spec.SHA256)
	e = errors.Join(e, closeReaders())
	if e != nil {
		return out, e
	}
	e = s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, _ task, write bool) error {
		if !write {
			return denied()
		}
		d, u, e := s.upload(ctx, tx, r, p, uploadID)
		if e != nil {
			return e
		}
		if e = s.imageTarget(p, r, u.Spec.Target); e != nil {
			return e
		}
		usage, e := d.SessionResourceUsage(ctx, id)
		if e != nil {
			return e
		}
		if usage.Deleting || usage.Frozen || !s.now().Before(u.ExpiresAt) || u.Receipt.State != "verifying" {
			return conflict()
		}
		descriptor := sp.Resource{Revision: "1", ResourceID: u.BlobID, Status: "available", Name: u.Spec.Name, MediaType: &validated.MediaType, ByteLength: &validated.ByteLength, SHA256: &validated.SHA256, Width: &validated.Width, Height: &validated.Height, FrameCount: &validated.FrameCount}
		old, e := d.SavedSessionResource(ctx, id, u.BlobID)
		if e == nil {
			if !jsonEqual(encode(old.Resource), encode(descriptor)) || old.BlobPath != path {
				return conflict()
			}
		} else if errors.Is(e, model.ErrNotFound) {
			if e = d.InsertSessionResource(ctx, store.SessionResourceRecord{SessionID: id, Resource: descriptor, BlobID: u.BlobID, BlobPath: path}); e != nil {
				return e
			}
		} else {
			return e
		}
		if e = d.AddSessionResourceReference(ctx, store.SessionResourceReference{SessionID: id, ResourceID: u.BlobID, Kind: "upload", ReferenceID: uploadID}); e != nil {
			return e
		}
		u.Receipt.State = "complete"
		u.Receipt.Resource = &descriptor
		out = u.Receipt
		return s.saveImageUpload(ctx, tx, r, u)
	})
	if e != nil {
		return out, e
	}
	if e = s.cleanupUploadFiles(ctx, p, project, taskID, id, uploadID); e != nil {
		return out, e
	}
	return out, nil
}
func (s *Execution) ReleaseUpload(ctx context.Context, p model.Principal, project, taskID, id, uploadID string) (out sp.ImageUploadReceipt, result error) {
	if s.files == nil {
		return out, fault("component_unsupported", "Resource storage is unavailable.")
	}
	ioContext, finish, e := s.beginImageIO(ctx, id, uuid.NewString())
	if e != nil {
		return out, e
	}
	ctx = ioContext
	defer func() { result = joinImageCleanup(result, finish) }()
	gate, e := s.files.AcquireGate(ctx, filestorage.PrivateGate, "session-image-upload/"+id+"/"+uploadID)
	if e != nil {
		return out, e
	}
	defer func() { result = errors.Join(result, gate.Close()) }()
	err := s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, _ task, write bool) error {
		if !write {
			return denied()
		}
		if e := s.admitImageRate(ctx, tx, p.UserID, "release"); e != nil {
			return e
		}
		d, u, e := s.upload(ctx, tx, r, p, uploadID)
		if e != nil {
			return e
		}
		if u.Receipt.State == "released" {
			out = u.Receipt
			return nil
		}
		if u.Receipt.Resource != nil {
			count, e := d.SessionResourceReferenceCount(ctx, id, u.Receipt.Resource.ResourceID)
			if e != nil {
				return e
			}
			own, e := d.SessionResourceReferenceExists(ctx, store.SessionResourceReference{SessionID: id, ResourceID: u.Receipt.Resource.ResourceID, Kind: "upload", ReferenceID: uploadID})
			if e != nil {
				return e
			}
			allowed := 0
			if own {
				allowed = 1
			}
			if count > allowed {
				return fault("resource_in_use", "An operation, message, archive, or native resume still references this image.")
			}
			if e = d.RemoveSessionResourceReference(ctx, store.SessionResourceReference{SessionID: id, ResourceID: u.Receipt.Resource.ResourceID, Kind: "upload", ReferenceID: uploadID}); e != nil {
				return e
			}
		}
		u.Receipt.State = "released"
		u.Receipt.Resource, u.Receipt.Error = nil, nil
		out = u.Receipt
		return s.saveImageUpload(ctx, tx, r, u)
	})
	if err == nil {
		err = s.cleanupUploadFiles(ctx, p, project, taskID, id, uploadID)
	}
	return out, err
}

func (s *Execution) PrepareUpload(ctx context.Context, p model.Principal, project, task, id string, spec sp.ImageUploadSpec) (sp.ImageUploadReceipt, bool, error) {
	return s.prepareUpload(ctx, p, project, task, id, spec, true)
}
func (s *Execution) WriteUploadChunk(ctx context.Context, p model.Principal, project, task, id, upload string, input sp.ImageChunkWrite) (sp.ImageUploadReceipt, error) {
	return s.writeUploadChunk(ctx, p, project, task, id, upload, input, true)
}
func (s *Execution) CompleteUpload(ctx context.Context, p model.Principal, project, task, id, upload string, input sp.ImageUploadComplete) (sp.ImageUploadReceipt, error) {
	return s.completeUpload(ctx, p, project, task, id, upload, input, true)
}

// cleanupUploadFiles returns staging quota only after deletion and its storage
// barriers complete. Receipt state alone never proves that disk space was freed.
func (s *Execution) cleanupUploadFiles(ctx context.Context, p model.Principal, project, taskID, id, uploadID string) error {
	access := func(ctx context.Context, work func(*operationTx, *record) error) error {
		return s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, _ task, _ bool) error {
			if _, _, e := s.upload(ctx, tx, r, p, uploadID); e != nil {
				return e
			}
			return work(tx, r)
		})
	}
	return s.cleanupUploadStorage(ctx, project, id, uploadID, access, func(ctx context.Context) error {
		return s.releaseControllerPreparation(ctx, p, project, taskID, id, uploadID)
	})
}

// Completed remote preparations are released under their original identity.
// A missing prepare request proves this service never created remote staging.
func (s *Execution) releaseControllerPreparation(ctx context.Context, p model.Principal, project, taskID, id, uploadID string) error {
	access := func(ctx context.Context, work func(*operationTx, *record) error) error {
		return s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, _ task, write bool) error {
			if !write {
				return denied()
			}
			return work(tx, r)
		})
	}
	return s.releaseControllerPreparationWithAccess(ctx, id, uploadID, access)
}

func (s *Execution) releaseControllerPreparationWithAccess(ctx context.Context, id, uploadID string, access imageStorageAccess) error {
	remote := false
	var spec sp.ImageUploadSpec
	if e := access(ctx, func(tx *operationTx, _ *record) error {
		d, ok := tx.dao.(store.SessionMediaDAO)
		if !ok {
			return nil
		}
		row, e := d.SessionMediaRequest(ctx, id, mediaIdentity(uploadID, "prepare"))
		if errors.Is(e, model.ErrNotFound) {
			return nil
		}
		remote = e == nil
		if e == nil {
			e = json.Unmarshal(row.Body, &spec)
		}
		return e
	}); e != nil {
		return e
	}
	if !remote {
		return nil
	}
	// Reconcile an earlier uncertain prepare before asking the original remote
	// identity to release. This also handles release racing the first RPC offer.
	if _, e := s.controllerMediaWithAccess(ctx, id, mediaIdentity(uploadID, "prepare"), "prepare", spec, access); e != nil {
		return e
	}
	raw, e := s.controllerMediaWithAccess(ctx, id, mediaIdentity(uploadID, "release"), "release", map[string]any{"uploadId": uploadID}, access)
	if e != nil {
		return e
	}
	var receipt sp.LocalImagePreparation
	if json.Unmarshal(raw, &receipt) != nil || receipt.UploadID != uploadID || receipt.ImageID != spec.ImageID || !jsonEqual(encode(receipt.Target), encode(spec.Target)) || receipt.State != "released" || receipt.Validated != nil || receipt.Error != nil {
		return fault("resource_conflict", "Controller release did not confirm the original preparation.")
	}
	return nil
}

func definiteImageFailure(err error) *sp.ImageError {
	var f *model.Fault
	if !errors.As(err, &f) {
		return nil
	}
	switch f.Code {
	case "invalid_image", "image_integrity", "image_decode_failed":
		return &sp.ImageError{Code: f.Code, Message: f.Message}
	}
	return nil
}

func (s *Execution) admitImageResource(ctx context.Context, usage store.SessionResourceUsage, size int64) error {
	if usage.Resources+usage.ReservedResources >= sp.MaxSessionResources || usage.Bytes+usage.ReservedBytes+size > sp.MaxSessionResourceBytes {
		return fault("quota_exceeded", "Session image resource capacity is exhausted.")
	}
	space, ok := s.files.(interface {
		ResourceSpace(context.Context) (int64, int64, error)
	})
	if !ok {
		return fault("component_unsupported", "Resource volume admission is unavailable.")
	}
	free, total, e := space.ResourceSpace(ctx)
	if e != nil {
		return e
	}
	floor := int64(1024 * 1024 * 1024)
	if total/20 > floor {
		floor = total / 20
	}
	if free <= floor+sp.ArchiveResourceReserve+usage.GlobalReservedBytes+2*size {
		return fault("quota_exceeded", "Resource volume free space is reserved for existing content.")
	}
	return nil
}
