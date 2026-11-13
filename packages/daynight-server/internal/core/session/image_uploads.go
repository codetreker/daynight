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
func (s *Execution) prepareUploadIdentity(ctx context.Context, p model.Principal, project, taskID, id string, spec sp.ImageUploadSpec, remote bool, desiredBlob ...string) (sp.ImageUploadReceipt, bool, error) {
	return s.prepareUploadIdentityWithFirst(ctx, p, project, taskID, id, spec, remote, nil, desiredBlob...)
}

func (s *Execution) prepareUploadIdentityWithFirst(ctx context.Context, p model.Principal, project, taskID, id string, spec sp.ImageUploadSpec, remote bool, first *sp.DirectImageContent, desiredBlob ...string) (sp.ImageUploadReceipt, bool, error) {
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
		bindFirst := func(u store.SessionUploadRecord) error {
			if first == nil {
				return nil
			}
			usage, err := d.SessionResourceUsage(ctx, id)
			if err != nil {
				return err
			}
			if usage.Deleting || usage.Frozen {
				return conflict()
			}
			chunks, err := d.SessionUploadChunks(ctx, id, spec.UploadID)
			if err != nil {
				return err
			}
			data, _ := base64.StdEncoding.Strict().DecodeString(first.Data)
			for _, chunk := range chunks {
				if chunk.Offset == 0 {
					if chunk.SHA256 != first.SHA256 || chunk.ByteLength != int64(len(data)) {
						return fault("resource_conflict", "First chunk identity already has different content.")
					}
					return nil
				}
			}
			if u.Receipt.State != "receiving" || u.Receipt.AcceptedOffset != "0" {
				return conflict()
			}
			n, err := sessionresource.NewNamespace(project, r.Owner, id)
			if err != nil {
				return err
			}
			path, err := n.ChunkPath(spec.UploadID, 0)
			if err != nil {
				return err
			}
			return d.InsertSessionUploadChunk(ctx, store.SessionUploadChunk{SessionID: id, UploadID: spec.UploadID, Path: path, Offset: 0, ByteLength: int64(len(data)), SHA256: first.SHA256})
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
			return bindFirst(old)
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
		}
		usage, e := d.SessionResourceUsage(ctx, id)
		if e != nil {
			return e
		}
		if usage.Deleting || usage.Frozen {
			return fault("resource_conflict", "Session resource deletion has begun.")
		}
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
		}
		expires := s.now().Add(24 * time.Hour).UTC().Truncate(time.Microsecond)
		out = sp.ImageUploadReceipt{UploadID: spec.UploadID, ImageID: spec.ImageID, Target: spec.Target, State: "receiving", AcceptedOffset: "0", Spec: sp.ImageUploadMetadata{Name: spec.Name, MediaType: spec.MediaType, ByteLength: spec.ByteLength, SHA256: spec.SHA256}, ExpiresAt: expires.Format(time.RFC3339Nano)}
		created = true
		blob := uuid.NewString()
		if len(desiredBlob) > 0 {
			blob = desiredBlob[0]
		}
		row := store.SessionUploadRecord{SessionID: id, ActorID: p.UserID, BlobID: blob, Spec: spec, Receipt: out, ExpiresAt: expires}
		if err := s.saveImageUpload(ctx, tx, r, row); err != nil {
			return err
		}
		return bindFirst(row)
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
func (s *Execution) writeUploadChunk(ctx context.Context, p model.Principal, project, taskID, id, uploadID string, input sp.ImageChunkWrite, remote bool, directFirst ...bool) (out sp.ImageUploadReceipt, result error) {
	chunk, e := base64.StdEncoding.Strict().DecodeString(input.Data)
	sum := sha256.Sum256(chunk)
	if e != nil || len(chunk) == 0 || len(chunk) > imageChunkBytes || input.UploadID != uploadID || hex.EncodeToString(sum[:]) != input.SHA256 || decimal(number(input.Offset)) != input.Offset {
		return out, fault("invalid_input", "Invalid image upload chunk.")
	}
	if s.files == nil {
		return out, fault("component_unsupported", "Resource storage is unavailable.")
	}
	gateHeld := len(directFirst) > 1 && directFirst[1]
	if !gateHeld {
		gate, err := s.files.AcquireGate(ctx, filestorage.PrivateGate, "session-image-upload/"+id+"/"+uploadID)
		if err != nil {
			return out, err
		}
		defer func() { result = errors.Join(result, gate.Close()) }()
	}
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
	pendingIntent := false
	directReplay := len(directFirst) != 0 && directFirst[0]
	var replayPath string
	var replayDeleteEpoch int64
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
		if !s.now().Before(u.ExpiresAt) || (u.Receipt.State != "receiving" && !(directReplay && (u.Receipt.State == "complete" || u.Receipt.State == "failed" || u.Receipt.State == "verifying"))) {
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
				if offset == 0 && u.Receipt.AcceptedOffset == "0" {
					if u.Receipt.State != "receiving" {
						return fault("resource_conflict", "Upload no longer accepts its first chunk.")
					}
					usage, err := d.SessionResourceUsage(ctx, id)
					if err != nil {
						return err
					}
					if usage.Deleting || usage.Frozen {
						return conflict()
					}
					path, previousUpload, pendingIntent = old.Path, u, true
					return acquireImageResourceLease(ctx, d, store.SessionResourceLease{SessionID: id, ID: lease, OwnerID: r.Owner, Kind: "write", DeleteEpoch: usage.DeleteEpoch})
				}
				out = u.Receipt
				duplicate = true
				if !directReplay {
					return nil
				}
				usage, e := d.SessionResourceUsage(ctx, id)
				if e != nil {
					return e
				}
				if usage.Deleting || usage.Frozen {
					return conflict()
				}
				previousUpload = u
				replayDeleteEpoch = usage.DeleteEpoch
				replayPath = old.Path
				resource := ""
				if u.Receipt.State == "complete" {
					n, err := sessionresource.NewNamespace(project, r.Owner, id)
					if err != nil {
						return err
					}
					replayPath, err = n.BlobPath(u.BlobID)
					if err != nil {
						return err
					}
					resource = u.BlobID
				}
				return acquireImageResourceLease(ctx, d, store.SessionResourceLease{SessionID: id, ID: lease, OwnerID: r.Owner, Kind: "read", ResourceID: resource, DeleteEpoch: usage.DeleteEpoch})
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
	if duplicate && !directReplay {
		return out, nil
	}
	defer func() { result = errors.Join(result, s.releaseImageLease(ctx, p, project, taskID, id, lease)) }()
	if duplicate {
		object, err := s.files.Open(ctx, sessionresource.Bucket, replayPath)
		if err != nil {
			return out, err
		}
		original, err := io.ReadAll(io.LimitReader(object.Body, int64(len(chunk))+1))
		if out.State == "complete" && len(original) > len(chunk) {
			original = original[:len(chunk)]
		}
		err = errors.Join(err, object.Body.Close())
		if err != nil {
			return out, err
		}
		if !bytes.Equal(original, chunk) {
			return out, fault("resource_conflict", "Original upload bytes differ from the first chunk.")
		}
		err = s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, _ task, write bool) error {
			if !write {
				return denied()
			}
			d, current, e := s.upload(ctx, tx, r, p, uploadID)
			if e != nil {
				return e
			}
			if e = s.imageTarget(p, r, current.Spec.Target); e != nil {
				return e
			}
			usage, e := d.SessionResourceUsage(ctx, id)
			if e != nil {
				return e
			}
			if usage.Deleting || usage.Frozen || usage.DeleteEpoch != replayDeleteEpoch || !jsonEqual(encode(current), encode(previousUpload)) {
				return conflict()
			}
			return nil
		})
		return out, err
	}
	if pendingIntent {
		object, openErr := s.files.Open(ctx, sessionresource.Bucket, path)
		if openErr == nil {
			original, readErr := io.ReadAll(io.LimitReader(object.Body, int64(len(chunk))+1))
			readErr = errors.Join(readErr, object.Body.Close())
			if readErr != nil {
				return out, readErr
			}
			if !bytes.Equal(original, chunk) {
				return out, fault("resource_conflict", "Original upload bytes differ from the first chunk.")
			}
		} else if !errors.Is(openErr, fs.ErrNotExist) && !errors.Is(openErr, model.ErrNotFound) {
			return out, openErr
		}
	}
	if e = s.publishImageBytes(ctx, path, bytes.NewReader(chunk), int64(len(chunk)), input.SHA256); e != nil {
		if failure := definiteImageFailure(e); failure != nil {
			e = &definiteImageError{image: *failure, cause: e, expectedUpload: &previousUpload}
		}
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
		if !pendingIntent {
			if e = d.InsertSessionUploadChunk(ctx, store.SessionUploadChunk{SessionID: id, UploadID: uploadID, Path: path, Offset: number(input.Offset), ByteLength: int64(len(chunk)), SHA256: input.SHA256}); e != nil {
				return e
			}
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
	reader := &imageSourceReader{reader: input}
	info, err := s.files.Put(ctx, sessionresource.Bucket, path, io.TeeReader(io.LimitReader(reader, size+1), h))
	if err != nil {
		if reader.err == nil && filestorage.PublicationOutcome(err) == filestorage.NotPublished && singleImageCause(err) && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			return &definiteImageError{image: sp.ImageError{Code: "storage_unavailable", Message: "Image storage could not publish the original."}, cause: err}
		}
		return err
	}
	if info.Size != size || hex.EncodeToString(h.Sum(nil)) != digest {
		return fault("resource_conflict", "Resource bytes do not match the declared content.")
	}
	return nil
}

type imageSourceReader struct {
	reader io.Reader
	err    error
}

func (r *imageSourceReader) Read(data []byte) (int, error) {
	n, err := r.reader.Read(data)
	if err != nil && err != io.EOF {
		r.err = err
	}
	return n, err
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
	settlementReady := false
	// Settle only after transfer cleanup while the original upload gate still
	// excludes a concurrent writer. A later gate-close failure is reconciled
	// from the persisted failed upload under the same gate on retry.
	defer func() {
		if !settlementReady {
			return
		}
		imageError := definiteImageFailure(result)
		if imageError == nil {
			return
		}
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		var settled *store.SessionUploadRecord
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
			if e = s.saveImageUpload(cleanup, tx, r, current); e != nil {
				return e
			}
			settled = &current
			return nil
		})
		result = errors.Join(result, e)
		if e == nil && settled != nil {
			result = &definiteImageError{image: *imageError, cause: result, expectedUpload: settled}
		}
	}()
	var upload store.SessionUploadRecord
	var chunks []store.SessionUploadChunk
	var path string
	var deleteEpoch int64
	lease := uuid.NewString()
	ioContext, finishIO, ioErr := s.beginImageIO(ctx, id, lease)
	if ioErr != nil {
		return out, ioErr
	}
	ctx = ioContext
	defer func() { result = joinImageCleanup(result, finishIO) }()
	completed := false
	failed := false
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
		if !remote && u.Receipt.State == "failed" && u.Receipt.Error != nil {
			out = u.Receipt
			upload = u
			failed = true
			return nil
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
		deleteEpoch = usage.DeleteEpoch
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
	if failed {
		return out, &definiteImageError{image: *out.Error, cause: fault(out.Error.Code, out.Error.Message), expectedUpload: &upload}
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
	settlementReady = true
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
		// Remote waits perform no local file I/O. Retain the upload and lifetime
		// gates, but free this transfer slot for the relay's independently leased
		// chunk reconstruction. A failed release cannot establish free capacity.
		if e = s.releaseImageLease(ctx, p, project, taskID, id, lease); e != nil {
			return out, e
		}
		if _, e = s.controllerMedia(ctx, p, project, taskID, id, mediaIdentity(uploadID, "prepare"), "prepare", upload.Spec); e != nil {
			return out, e
		}
		for _, chunk := range chunks {
			offset := decimal(chunk.Offset)
			body := map[string]any{"uploadId": uploadID, "offset": offset, "sha256": chunk.SHA256, "$data": mediaDataIdentity{SHA256: chunk.SHA256, ByteLength: int(chunk.ByteLength)}}
			if _, e = s.controllerMedia(ctx, p, project, taskID, id, mediaIdentity(uploadID, "write/"+offset), "write", body); e != nil {
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
		// No original may be opened until fresh admission confirms the same
		// actor, upload, receipt, fence and deletion generation observed above.
		e = s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, _ task, write bool) error {
			if !write {
				return denied()
			}
			d, current, err := s.upload(ctx, tx, r, p, uploadID)
			if err != nil {
				return err
			}
			if err = s.imageTarget(p, r, current.Spec.Target); err != nil {
				return err
			}
			if current.SessionID != upload.SessionID || current.BlobID != upload.BlobID || current.StorageReleased != upload.StorageReleased || !current.ExpiresAt.Equal(upload.ExpiresAt) || !s.now().Before(current.ExpiresAt) || !jsonEqual(encode(current.Spec), encode(upload.Spec)) || !jsonEqual(encode(current.Receipt), encode(upload.Receipt)) {
				return conflict()
			}
			usage, err := d.SessionResourceUsage(ctx, id)
			if err != nil {
				return err
			}
			if usage.Deleting || usage.Frozen || usage.DeleteEpoch != deleteEpoch {
				return conflict()
			}
			return acquireImageResourceLease(ctx, d, store.SessionResourceLease{SessionID: id, ID: lease, OwnerID: r.Owner, Kind: "write", DeleteEpoch: deleteEpoch})
		})
		if e != nil {
			return out, e
		}
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
	if remote {
		e = s.browser(ctx, p, project, taskID, id, func(_ *operationTx, r *record, _ task, write bool) error {
			if !write {
				return denied()
			}
			return validateInputImage(r.Snapshot.Capabilities.Images, validated)
		})
		if e != nil {
			return out, e
		}
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
		if remote {
			if e = validateInputImage(r.Snapshot.Capabilities.Images, validated); e != nil {
				return e
			}
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
			if e = checkContentPublication(ctx, tx, id, resourceContentChange{descriptor}); e != nil {
				var capacity *contentCapacityError
				var f *model.Fault
				if errors.As(e, &capacity) && errors.As(e, &f) && f.Code == "quota_exceeded" {
					return &definiteImageError{image: sp.ImageError{Code: f.Code, Message: f.Message}, cause: e}
				}
				return e
			}
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

// DirectUpload registers the original identity only after validating a real first
// chunk, then confirms only the durable prefix under the existing transfer gate.
func (s *Execution) DirectUpload(ctx context.Context, p model.Principal, project, task, id string, input sp.DirectImageContent) (sp.ImageUploadReceipt, bool, error) {
	if len(encode(input)) > 1<<20 {
		return sp.ImageUploadReceipt{}, false, fault("invalid_input", "Image upload content exceeds the JSON body limit.")
	}
	if _, err := sp.DecodeDirectImageContent(encode(input)); err != nil {
		return sp.ImageUploadReceipt{}, false, fault("invalid_input", "Invalid image upload content.")
	}
	if s.files == nil {
		return sp.ImageUploadReceipt{}, false, fault("component_unsupported", "Resource storage is unavailable.")
	}
	gate, err := s.files.AcquireGate(ctx, filestorage.PrivateGate, "session-image-upload/"+id+"/"+input.Spec.UploadID)
	if err != nil {
		return sp.ImageUploadReceipt{}, false, err
	}
	_, created, err := s.prepareUploadIdentityWithFirst(ctx, p, project, task, id, input.Spec, true, &input)
	var out sp.ImageUploadReceipt
	if err == nil {
		out, err = s.writeUploadChunk(ctx, p, project, task, id, input.Spec.UploadID, sp.ImageChunkWrite{UploadID: input.Spec.UploadID, Offset: input.Offset, SHA256: input.SHA256, Data: input.Data}, true, true, true)
	}
	return out, created, errors.Join(err, gate.Close())
}

func (s *Execution) PrepareUpload(ctx context.Context, p model.Principal, project, task, id string, spec sp.ImageUploadSpec) (sp.ImageUploadReceipt, bool, error) {
	return s.prepareUploadIdentity(ctx, p, project, task, id, spec, true)
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
	// An unknown prepare must finish under its original identity. A durable
	// failure proves that attempt has exited, but not that it left no files.
	// Release still needs a Controller receipt for the exact original spec.
	failed := false
	if _, prepareErr := s.controllerMediaWithAccess(ctx, id, mediaIdentity(uploadID, "prepare"), "prepare", spec, access); prepareErr != nil {
		observeErr := access(ctx, func(tx *operationTx, r *record) error {
			d, e := mediaDAO(tx)
			if e != nil {
				return e
			}
			row, e := d.SessionMediaRequest(ctx, id, mediaIdentity(uploadID, "prepare"))
			if e != nil {
				return e
			}
			failed = r.Snapshot.ContentRevision == 2 && row.SessionID == id && row.RequestID == mediaIdentity(uploadID, "prepare") && row.Action == "prepare" && row.Fence.Fence == r.Snapshot.Fence && jsonEqual(row.Body, encode(spec)) && row.Complete && row.Error != nil && row.Result == nil
			return nil
		})
		if observeErr != nil || !failed {
			return errors.Join(prepareErr, observeErr)
		}
	}
	body := map[string]any{"uploadId": uploadID}
	if failed {
		body["spec"] = spec
	}
	raw, e := s.controllerMediaWithAccess(ctx, id, mediaIdentity(uploadID, "release"), "release", body, access)
	if e != nil {
		return e
	}
	var receipt sp.LocalImagePreparation
	if json.Unmarshal(raw, &receipt) != nil || receipt.UploadID != uploadID || receipt.ImageID != spec.ImageID || !jsonEqual(encode(receipt.Target), encode(spec.Target)) || receipt.State != "released" || receipt.Validated != nil || receipt.Error != nil {
		return fault("resource_conflict", "Controller release did not confirm the original preparation.")
	}
	return nil
}

type definiteImageError struct {
	image          sp.ImageError
	cause          error
	expectedUpload *store.SessionUploadRecord
	expectAbsent   bool
}

func (e *definiteImageError) Error() string { return e.cause.Error() }
func (e *definiteImageError) Unwrap() error { return e.cause }
func (e *definiteImageError) PreserveSessionRefusal() bool {
	return e != nil && e.cause != nil && e.image.Code != ""
}

func imageFailureEvidence(err error) *definiteImageError {
	if definiteImageFailure(err) == nil {
		return nil
	}
	for err != nil {
		if failure, ok := err.(*definiteImageError); ok && (failure.expectAbsent || failure.expectedUpload != nil) {
			return failure
		}
		if joined, ok := err.(interface{ Unwrap() []error }); ok {
			children := joined.Unwrap()
			if len(children) != 1 {
				return nil
			}
			err = children[0]
		} else {
			err = errors.Unwrap(err)
		}
	}
	return nil
}

func singleImageCause(err error) bool {
	if err == nil {
		return false
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		children := joined.Unwrap()
		return len(children) == 1 && singleImageCause(children[0])
	}
	if next := errors.Unwrap(err); next != nil {
		return singleImageCause(next)
	}
	return true
}

// A joined cleanup or transaction failure must not be hidden by an earlier
// refusal: its outcome may retain the original file or database responsibility.
func definiteImageFailure(err error) *sp.ImageError {
	if err == nil {
		return nil
	}
	if tx, ok := err.(*store.TransactionError); ok {
		if tx.Outcome != store.TransactionNotCommitted || tx.CommitAttempted || tx.CleanupFailed {
			return nil
		}
		return definiteImageFailure(tx.Cause)
	}
	if f, ok := err.(*definiteImageError); ok {
		return &f.image
	}
	if f, ok := err.(*model.Fault); ok {
		switch f.Code {
		case "invalid_image", "image_integrity", "image_decode_failed":
			return &sp.ImageError{Code: f.Code, Message: f.Message}
		}
		return nil
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		children := joined.Unwrap()
		if len(children) != 1 {
			return nil
		}
		return definiteImageFailure(children[0])
	}
	return definiteImageFailure(errors.Unwrap(err))
}
