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
	"slices"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type mediaDataIdentity struct {
	SHA256     string `json:"sha256"`
	ByteLength int    `json:"byteLength"`
}

func mediaRead(action string) bool {
	return action == "read" || action == "read_capture" || action == "read_prepared"
}

// compactMediaPayload retains all protocol metadata and replaces only the
// bounded original bytes. The reserved key never crosses the wire.
func compactMediaPayload(raw []byte, payload bool) ([]byte, bool, error) {
	if !payload || len(raw) == 0 {
		return raw, false, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, false, fault("invalid_input", "Invalid controller media payload.")
	}
	data, has := fields["data"]
	if !has {
		return raw, false, nil
	}
	if _, reserved := fields["$data"]; reserved {
		return nil, false, fault("resource_conflict", "Controller media payload identity is ambiguous.")
	}
	var encoded string
	if json.Unmarshal(data, &encoded) != nil || len(encoded) > base64.StdEncoding.EncodedLen(imageChunkBytes) {
		return nil, false, fault("quota_exceeded", "Controller media payload exceeds its chunk budget.")
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(decoded) > imageChunkBytes || base64.StdEncoding.EncodeToString(decoded) != encoded {
		return nil, false, fault("invalid_input", "Invalid controller media chunk encoding.")
	}
	digest := sha256.Sum256(decoded)
	fields["$data"] = encode(mediaDataIdentity{SHA256: hex.EncodeToString(digest[:]), ByteLength: len(decoded)})
	delete(fields, "data")
	return encode(fields), true, nil
}

func mediaExpected(row store.SessionMediaRequest) *store.SessionMediaState {
	return &store.SessionMediaState{Fence: row.Fence, Body: slices.Clone(row.Body), Result: slices.Clone(row.Result), Error: row.Error, Complete: row.Complete}
}

func normalizeMediaRequest(ctx context.Context, d store.SessionMediaDAO, row store.SessionMediaRequest) (store.SessionMediaRequest, error) {
	before := mediaExpected(row)
	body, b, err := compactMediaPayload(row.Body, row.Action == "write")
	if err != nil {
		return row, err
	}
	if !b {
		return row, nil
	}
	row.Body, row.Expected = body, before
	if err = saveMediaRequest(ctx, d, row); err != nil {
		return row, err
	}
	row.Expected = nil
	return row, nil
}

// Settlement rewrites legacy payload-bearing rows before returning their disk
// reservation. Unknown operations retain their original ID and digest; any
// authorized relay can reconstruct the bounded body from shared storage.
func settleUploadMedia(ctx context.Context, tx *operationTx, id, uploadID, resourceID string) error {
	d, ok := tx.dao.(store.SessionUploadMediaDAO)
	if !ok {
		return fault("component_unsupported", "Media payload settlement requires a server upgrade.")
	}
	media, err := mediaDAO(tx)
	if err != nil {
		return err
	}
	rows, err := d.SessionUploadMediaRequests(ctx, id, uploadID, resourceID)
	if err != nil {
		return err
	}
	for _, row := range rows {
		row, err = normalizeMediaRequest(ctx, media, row)
		if err != nil {
			return err
		}
		compact, changed, e := compactMediaPayload(row.Result, mediaRead(row.Action))
		if e != nil {
			return e
		}
		if changed {
			row.Expected = mediaExpected(row)
			row.Result = compact
			if err = saveMediaRequest(ctx, media, row); err != nil {
				return err
			}
		}
	}
	return nil
}

type mediaFilePlan struct {
	row                                     store.SessionMediaRequest
	admittedFence                           sp.ControllerFence
	path, uploadID, resourceID, uploadState string
	fileOffset                              int64
	offset                                  int64
	data                                    mediaDataIdentity
	deleteEpoch                             int64
	publish                                 bool
}

func mediaPayloadIdentity(raw []byte) (mediaDataIdentity, bool, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return mediaDataIdentity{}, false, fault("invalid_input", "Invalid media payload metadata.")
	}
	rawData, ok := fields["$data"]
	if !ok {
		return mediaDataIdentity{}, false, nil
	}
	var data mediaDataIdentity
	if json.Unmarshal(rawData, &data) != nil || data.ByteLength < 0 || data.ByteLength > imageChunkBytes || len(data.SHA256) != 64 {
		return data, false, fault("resource_conflict", "Invalid media data identity.")
	}
	decoded, e := hex.DecodeString(data.SHA256)
	if e != nil || len(decoded) != 32 {
		return data, false, fault("resource_conflict", "Invalid media data digest.")
	}
	return data, true, nil
}

func (s *Execution) planMediaFile(ctx context.Context, tx *operationTx, r *record, row store.SessionMediaRequest, payload []byte, publish bool, lease string) (mediaFilePlan, error) {
	plan := mediaFilePlan{row: row, publish: publish, admittedFence: r.Snapshot.ControllerFence}
	d, e := resourceDAO(tx)
	if e != nil {
		return plan, e
	}
	current, e := tx.dao.(store.SessionMediaDAO).SessionMediaRequest(ctx, row.SessionID, row.RequestID)
	if e != nil {
		return plan, e
	}
	current, e = normalizeMediaRequest(ctx, tx.dao.(store.SessionMediaDAO), current)
	if e != nil {
		return plan, e
	}
	if current.Action != row.Action || current.Fence != row.Fence || !jsonEqual(current.Body, row.Body) || current.Complete && current.Error != nil {
		return plan, conflict()
	}
	currentResult, _, e := compactMediaPayload(current.Result, mediaRead(row.Action))
	if e != nil {
		return plan, e
	}
	if current.Complete && mediaRead(row.Action) && !jsonEqual(currentResult, payload) {
		return plan, fault("resource_conflict", "Media response changed its original digest.")
	}
	data, ok, e := mediaPayloadIdentity(payload)
	if e != nil {
		return plan, e
	}
	if !ok {
		return plan, fault("resource_conflict", "Media payload digest is missing.")
	}
	plan.data = data
	var body struct {
		UploadID      string `json:"uploadId"`
		AttemptID     string `json:"attemptId"`
		PreparationID string `json:"preparationId"`
		ResourceID    string `json:"resourceId"`
		Offset        string `json:"offset"`
		Limit         int    `json:"limit"`
		SHA256        string `json:"sha256"`
		ByteLength    string `json:"byteLength"`
	}
	if json.Unmarshal(row.Body, &body) != nil || decimal(number(body.Offset)) != body.Offset {
		return plan, fault("resource_conflict", "Invalid media chunk identity.")
	}
	plan.offset = number(body.Offset)
	n, e := sessionresource.NewNamespace(r.Snapshot.Identity.ProjectID, r.Owner, row.SessionID)
	if e != nil {
		return plan, e
	}
	if row.Action == "read" {
		saved, e := d.SavedSessionResource(ctx, row.SessionID, body.ResourceID)
		if e != nil {
			return plan, e
		}
		path, e := n.BlobPath(saved.BlobID)
		if e != nil {
			return plan, e
		}
		if saved.GCPending || saved.Resource.Status != "available" || saved.BlobPath != path || saved.Resource.ByteLength == nil || saved.Resource.SHA256 == nil {
			return plan, conflict()
		}
		plan.resourceID, plan.path, plan.fileOffset = body.ResourceID, path, plan.offset
		if e = validateReadMediaMetadata(row.Action, body.ResourceID, *saved.Resource.SHA256, *saved.Resource.ByteLength, body.Offset, body.Limit, payload, data.ByteLength); e != nil {
			return plan, e
		}
		plan.publish = false
	} else {
		uploadID := body.UploadID
		if row.Action == "read_capture" {
			uploadID = body.AttemptID
		} else if row.Action == "read_prepared" {
			uploadID = body.PreparationID
		}
		upload, e := d.SessionUpload(ctx, row.SessionID, uploadID)
		if e != nil {
			return plan, e
		}
		if upload.StorageReleased && upload.Receipt.State != "complete" || upload.Receipt.State != "receiving" && upload.Receipt.State != "verifying" && upload.Receipt.State != "complete" {
			return plan, conflict()
		}
		if plan.offset+int64(data.ByteLength) > number(upload.Spec.ByteLength) {
			return plan, conflict()
		}
		plan.uploadID, plan.resourceID, plan.uploadState = uploadID, upload.BlobID, upload.Receipt.State
		plan.path, e = n.ChunkPath(uploadID, plan.offset)
		if e != nil {
			return plan, e
		}
		if row.Action == "write" {
			if data.SHA256 != body.SHA256 || data.ByteLength == 0 || publish {
				return plan, conflict()
			}
			chunks, e := d.SessionUploadChunks(ctx, row.SessionID, uploadID)
			if e != nil {
				return plan, e
			}
			found := false
			for _, chunk := range chunks {
				if chunk.Offset == plan.offset && chunk.Path == plan.path && chunk.ByteLength == int64(data.ByteLength) && chunk.SHA256 == data.SHA256 {
					found = true
				}
			}
			if !found {
				return plan, fault("resource_conflict", "The original durable upload chunk is missing.")
			}
		} else {
			if e = validateReadMediaMetadata(row.Action, uploadID, upload.Spec.SHA256, upload.Spec.ByteLength, body.Offset, body.Limit, payload, data.ByteLength); e != nil {
				return plan, e
			}
			if row.Action == "read_capture" && (body.SHA256 != upload.Spec.SHA256 || body.ByteLength != upload.Spec.ByteLength) {
				return plan, conflict()
			}
			if plan.offset > number(upload.Receipt.AcceptedOffset) {
				return plan, conflict()
			}
		}
		if upload.Receipt.State == "complete" {
			plan.path, e = n.BlobPath(upload.BlobID)
			if e != nil {
				return plan, e
			}
			plan.fileOffset = plan.offset
			plan.publish = false
		}
	}
	usage, e := d.SessionResourceUsage(ctx, row.SessionID)
	if e != nil {
		return plan, e
	}
	if usage.Deleting || usage.Frozen {
		return plan, conflict()
	}
	plan.deleteEpoch = usage.DeleteEpoch
	leaseResource := plan.resourceID
	// Pending upload blobs have no session_resources row yet. Their exact
	// upload identity and delete epoch are rechecked separately; the wildcard
	// lease keeps reclamation waiting without inventing a published resource.
	if plan.uploadID != "" && plan.uploadState != "complete" {
		leaseResource = ""
	}
	e = acquireImageResourceLease(ctx, d, store.SessionResourceLease{SessionID: row.SessionID, ID: lease, OwnerID: r.Owner, Kind: "read", ResourceID: leaseResource, DeleteEpoch: usage.DeleteEpoch})
	return plan, e
}
func validateReadMediaMetadata(action, id, digest, size, offset string, limit int, raw []byte, length int) error {
	var v struct {
		PreparationID string `json:"preparationId"`
		ResourceID    string `json:"resourceId"`
		SHA256        string `json:"sha256"`
		ByteLength    string `json:"byteLength"`
		Offset        string `json:"offset"`
		EOF           bool   `json:"eof"`
	}
	if json.Unmarshal(raw, &v) != nil {
		return conflict()
	}
	actualID := v.PreparationID
	if action == "read" {
		actualID = v.ResourceID
	}
	if actualID != id || v.SHA256 != digest || v.ByteLength != size || v.Offset != offset || limit < 1 || limit > imageChunkBytes || length > limit || number(offset)+int64(length) > number(size) || v.EOF != (number(offset)+int64(length) == number(size)) || length == 0 && !v.EOF {
		return fault("resource_conflict", "Controller media chunk changed its original range.")
	}
	return nil
}
func (s *Execution) recheckMediaFile(ctx context.Context, tx *operationTx, r *record, plan mediaFilePlan) error {
	d, e := resourceDAO(tx)
	if e != nil {
		return e
	}
	usage, e := d.SessionResourceUsage(ctx, plan.row.SessionID)
	if e != nil {
		return e
	}
	if usage.Deleting || usage.Frozen || usage.DeleteEpoch != plan.deleteEpoch || r.Snapshot.ControllerFence != plan.admittedFence {
		return conflict()
	}
	row, e := tx.dao.(store.SessionMediaDAO).SessionMediaRequest(ctx, plan.row.SessionID, plan.row.RequestID)
	if e != nil {
		return e
	}
	row, e = normalizeMediaRequest(ctx, tx.dao.(store.SessionMediaDAO), row)
	if e != nil {
		return e
	}
	if row.Action != plan.row.Action || row.Fence != plan.row.Fence || !jsonEqual(row.Body, plan.row.Body) {
		return conflict()
	}
	if plan.uploadID != "" {
		upload, e := d.SessionUpload(ctx, plan.row.SessionID, plan.uploadID)
		if e != nil {
			return e
		}
		if upload.BlobID != plan.resourceID || upload.Receipt.State != plan.uploadState {
			return conflict()
		}
	}
	return nil
}

// mediaFileIO owns an exact cross-process lease through publication and the
// caller's final transaction. No file operation or gate wait runs inside access.
func (s *Execution) mediaFileIO(ctx context.Context, access imageStorageAccess, row store.SessionMediaRequest, payload, data []byte) (out []byte, check func(*operationTx, *record) error, finish func() error, result error) {
	if s.files == nil {
		return nil, nil, nil, fault("component_unsupported", "Resource storage is unavailable.")
	}
	lease := uuid.NewString()
	ctx, finishIO, e := s.beginImageIO(ctx, row.SessionID, lease)
	if e != nil {
		return nil, nil, nil, e
	}
	var plan mediaFilePlan
	var payloadGate io.Closer
	finish = func() error {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		err := access(cleanup, func(tx *operationTx, _ *record) error {
			d, e := resourceDAO(tx)
			if e != nil {
				return e
			}
			return d.ReleaseSessionResourceLease(cleanup, row.SessionID, lease)
		})
		if payloadGate != nil {
			err = errors.Join(err, payloadGate.Close())
		}
		return errors.Join(err, finishIO())
	}
	defer func() {
		if result != nil {
			result = errors.Join(result, finish())
			finish = nil
		}
	}()
	if e = access(ctx, func(tx *operationTx, r *record) error {
		var err error
		plan, err = s.planMediaFile(ctx, tx, r, row, payload, data != nil, lease)
		return err
	}); e != nil {
		return nil, nil, finish, e
	}
	check = func(tx *operationTx, r *record) error { return s.recheckMediaFile(ctx, tx, r, plan) }
	if plan.publish {
		payloadGate, e = s.files.AcquireGate(ctx, filestorage.MediaLeaseGate, "session-upload-payload/"+row.SessionID+"/"+plan.uploadID)
		if e != nil {
			return nil, nil, finish, e
		}
		if e = access(ctx, check); e != nil {
			return nil, nil, finish, e
		}
		if e = s.publishImageBytes(ctx, plan.path, bytes.NewReader(data), int64(plan.data.ByteLength), plan.data.SHA256); e != nil {
			return nil, nil, finish, e
		}
		return payload, check, finish, nil
	}
	object, e := s.files.Open(ctx, sessionresource.Bucket, plan.path)
	if e != nil {
		return nil, nil, finish, e
	}
	if plan.fileOffset > 0 {
		_, e = io.CopyN(io.Discard, object.Body, plan.fileOffset)
	}
	var raw []byte
	if e == nil {
		raw, e = io.ReadAll(io.LimitReader(object.Body, int64(plan.data.ByteLength)))
	}
	e = errors.Join(e, object.Body.Close())
	if e != nil {
		return nil, nil, finish, e
	}
	digest := sha256.Sum256(raw)
	if len(raw) != plan.data.ByteLength || hex.EncodeToString(digest[:]) != plan.data.SHA256 {
		return nil, nil, finish, fault("resource_conflict", "Original media bytes are missing or corrupt.")
	}
	if data != nil && !bytes.Equal(data, raw) {
		return nil, nil, finish, conflict()
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(payload, &fields)
	delete(fields, "$data")
	fields["data"] = encode(base64.StdEncoding.EncodeToString(raw))
	return encode(fields), check, finish, nil
}

func (s *Execution) prepareReadMediaResponse(ctx context.Context, m sp.ControllerMessage) (sp.ControllerMessage, func(*operationTx, *record) error, func() error, error) {
	if m.Type != "image_response" || !mediaRead(m.Action) || m.MediaError != nil {
		return m, nil, nil, nil
	}
	payload, has, e := compactMediaPayload(m.MediaResult, true)
	if e != nil {
		return m, nil, nil, e
	}
	if !has {
		return m, nil, nil, nil
	}
	access := func(ctx context.Context, work func(*operationTx, *record) error) error {
		return s.controller(ctx, m.ControllerFence, func(tx *operationTx, r *record, _ task) error { return work(tx, r) })
	}
	var row store.SessionMediaRequest
	e = access(ctx, func(tx *operationTx, r *record) error {
		d, e := mediaDAO(tx)
		if e != nil {
			return e
		}
		row, e = d.SessionMediaRequest(ctx, m.SessionID, m.RequestID)
		if e != nil {
			return e
		}
		if row.Action != m.Action || row.Fence != m.ControllerFence {
			return conflict()
		}
		return nil
	})
	if errors.Is(e, model.ErrNotFound) {
		return m, nil, nil, nil
	}
	if e != nil {
		return m, nil, nil, e
	}
	var wire struct {
		Data string `json:"data"`
	}
	_ = json.Unmarshal(m.MediaResult, &wire)
	data, _ := base64.StdEncoding.Strict().DecodeString(wire.Data)
	_, check, finish, e := s.mediaFileIO(ctx, access, row, payload, data)
	if e != nil {
		return m, nil, nil, e
	}
	m.MediaResult = payload
	return m, check, finish, nil
}

func (s *Execution) hydrateMediaOffers(ctx context.Context, f sp.ControllerFence, messages []map[string]any) ([]map[string]any, error) {
	access := func(ctx context.Context, work func(*operationTx, *record) error) error {
		return s.controller(ctx, f, func(tx *operationTx, r *record, _ task) error { return work(tx, r) })
	}
	out := make([]map[string]any, 0, len(messages))
	for _, msg := range messages {
		if msg["type"] != "image_request" || msg["action"] != "write" {
			out = append(out, msg)
			continue
		}
		body, ok := msg["body"].(json.RawMessage)
		if !ok {
			return nil, conflict()
		}
		_, has, e := mediaPayloadIdentity(body)
		if e != nil {
			return nil, e
		}
		if !has {
			out = append(out, msg)
			continue
		}
		row := store.SessionMediaRequest{SessionID: f.SessionID, RequestID: msg["requestId"].(string), Action: "write", Fence: f, Body: body}
		wire, check, finish, e := s.mediaFileIO(ctx, access, row, body, nil)
		if e != nil {
			// Pending requests retain their durable identity for a later Poll.
			// Capacity pressure must not terminate unrelated text traffic.
			if onlyMediaCapacityError(e) {
				continue
			}
			return nil, e
		}
		e = access(ctx, check)
		e = errors.Join(e, finish())
		if e != nil {
			return nil, e
		}
		msg["body"] = json.RawMessage(wire)
		out = append(out, msg)
	}
	return out, nil
}

func onlyMediaCapacityError(err error) bool {
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		causes := joined.Unwrap()
		if len(causes) == 0 {
			return false
		}
		for _, cause := range causes {
			if !onlyMediaCapacityError(cause) {
				return false
			}
		}
		return true
	}
	if f, ok := err.(*model.Fault); ok {
		return f.Code == "rate_limited" && f.Cause == nil
	}
	if cause := errors.Unwrap(err); cause != nil {
		return onlyMediaCapacityError(cause)
	}
	return false
}
