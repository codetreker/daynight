package session

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

// CaptureRequestError is a refusal of one authenticated capture request.
// Handle exposes it only after the enclosing transaction has committed.
type CaptureRequestError struct {
	Code    string
	Message string
}

func (e *CaptureRequestError) Error() string { return e.Message }

func captureRefusal(code, message string) error {
	return &CaptureRequestError{Code: code, Message: message}
}

func captureMissing(err error) error {
	if onlyCaptureMissing(err) {
		return captureRefusal("capture_not_found", "Image capture was not found.")
	}
	return err
}

func onlyCaptureMissing(err error) bool {
	if err == model.ErrNotFound {
		return true
	}
	if missing, ok := err.(*store.Error); ok {
		return missing.MissingRow && !missing.DatabaseFailure
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		children := joined.Unwrap()
		return len(children) == 1 && onlyCaptureMissing(children[0])
	}
	return err != nil && onlyCaptureMissing(errors.Unwrap(err))
}

func (s *Execution) captureMessage(ctx context.Context, tx *operationTx, r *record, m sp.ControllerMessage) (map[string]any, error) {
	if r.Snapshot.ContentRevision != 2 {
		return nil, fault("component_unsupported", "Upgrade the original controller for image capture.")
	}
	d, e := resourceDAO(tx)
	if e != nil {
		return nil, e
	}
	response := envelope(r, "image_capture_result")
	response["requestId"], response["action"] = m.RequestID, m.Action
	response["error"] = nil
	var capture store.SessionCaptureRecord
	category := "control"
	if m.Action == "register" {
		category = "prepare"
	} else if m.Action == "query" {
		category = "observe"
	}
	if e = s.admitImageRate(ctx, tx, r.Owner, category); e != nil {
		if f, ok := e.(*model.Fault); ok && f.Code == "rate_limited" {
			return nil, captureRefusal(f.Code, f.Message)
		}
		return nil, e
	}
	switch m.Action {
	case "submit":
		input, err := sp.DecodeDirectCaptureSubmission(m.MediaBody)
		if err != nil {
			return nil, fault("invalid_input", "Invalid direct image capture submission.")
		}
		capture, e = s.submitImageCapture(ctx, tx, r, d, input)
		if e != nil {
			return nil, e
		}
	case "register":
		request, e := sp.DecodeImageCaptureRequest(m.MediaBody)
		if e != nil {
			return nil, fault("invalid_input", "Invalid image occurrence registration.")
		}
		if request.Locator.Kind == "native" && (request.Locator.Provider != r.Snapshot.Identity.Provider || r.Snapshot.Identity.NativeSessionID == nil || request.Locator.NativeSessionID != *r.Snapshot.Identity.NativeSessionID) {
			return nil, conflict()
		}
		if request.NativeSource != nil && (request.NativeSource.Provider != r.Snapshot.Identity.Provider || r.Snapshot.Identity.NativeSessionID == nil || request.NativeSource.NativeSessionID != *r.Snapshot.Identity.NativeSessionID) {
			return nil, conflict()
		}
		old, e := d.SessionCapture(ctx, r.Snapshot.SessionID, request.CaptureID)
		if e == nil {
			if !jsonEqual(encode(old.Request), encode(request)) {
				return nil, captureRefusal("resource_conflict", "Capture identity already belongs to a different occurrence.")
			}
			capture = old
			break
		}
		if !onlyCaptureMissing(e) {
			return nil, e
		}
		if _, e = d.SessionUpload(ctx, r.Snapshot.SessionID, request.AttemptID); e == nil {
			return nil, captureRefusal("resource_conflict", "Capture attempt already belongs to an upload identity.")
		} else if !onlyCaptureMissing(e) {
			return nil, e
		}
		if e = verifyImageOccurrence(ctx, tx, r, request.Occurrence); e != nil {
			if f, ok := e.(*model.Fault); ok && f.Code == "resource_conflict" {
				return nil, captureRefusal(f.Code, f.Message)
			}
			if onlyCaptureMissing(e) {
				return nil, captureRefusal("capability_changed", "Complete source metadata is unavailable for image capture.")
			}
			return nil, e
		}
		var ledgerRefusal *model.Fault
		if e = requireImageHistoryLedger(ctx, tx, r, true); e != nil {
			if f, ok := e.(*model.Fault); ok && (f.Code == "capability_changed" || f.Code == "component_unsupported") {
				ledgerRefusal = f
			} else {
				return nil, e
			}
		}
		usage, e := d.SessionResourceUsage(ctx, r.Snapshot.SessionID)
		if e != nil {
			return nil, e
		}
		if usage.Deleting || usage.Frozen {
			return nil, conflict()
		}
		failRegistration := func(code, message string) (map[string]any, error) {
			failed := store.SessionCaptureRecord{SessionID: r.Snapshot.SessionID, Request: request, Receipt: sp.ImageCaptureReceipt{CaptureID: request.CaptureID, AttemptID: request.AttemptID, Revision: "1", Occurrence: request.Occurrence, State: "failed", Error: &sp.ImageError{Code: code, Message: message}}}
			if err := saveImageCapture(ctx, d, failed); err != nil {
				return nil, err
			}
			if err := s.syncImageBudget(ctx, tx, r); err != nil {
				return nil, err
			}
			return nil, captureRefusal(code, message)
		}
		if ledgerRefusal != nil {
			return failRegistration(ledgerRefusal.Code, ledgerRefusal.Message)
		}
		if request.Locator.Kind != "resource" && s.imageDecoder == nil {
			return failRegistration("component_unsupported", "Full image validation is unavailable.")
		}
		resourceID := uuid.NewString()
		capture = store.SessionCaptureRecord{SessionID: r.Snapshot.SessionID, Request: request, Receipt: sp.ImageCaptureReceipt{CaptureID: request.CaptureID, AttemptID: request.AttemptID, Revision: "1", Occurrence: request.Occurrence, State: "reserved", ResourceID: &resourceID}}
		if request.Locator.Kind == "resource" {
			saved, e := d.SavedSessionResource(ctx, r.Snapshot.SessionID, request.Locator.ResourceID)
			if e != nil {
				if onlyCaptureMissing(e) {
					return failRegistration("resource_conflict", "The original image resource was not found.")
				}
				return nil, e
			}
			if saved.Resource.Status != "available" {
				return failRegistration("resource_conflict", "The original image resource is unavailable.")
			}
			capture.Receipt.State = "committed"
			capture.Receipt.ResourceID = &saved.Resource.ResourceID
			capture.Receipt.Resource = &saved.Resource
			if e = d.AddSessionResourceReference(ctx, store.SessionResourceReference{SessionID: r.Snapshot.SessionID, ResourceID: saved.Resource.ResourceID, Kind: "message", ReferenceID: request.Occurrence.ImageID}); e != nil {
				return nil, e
			}
		}
		if e = saveImageCapture(ctx, d, capture); e != nil {
			return nil, e
		}
	case "query":
		var body struct {
			CaptureID string `json:"captureId"`
		}
		if json.Unmarshal(m.MediaBody, &body) != nil {
			return nil, fault("invalid_input", "Invalid capture query.")
		}
		capture, e = d.SessionCapture(ctx, r.Snapshot.SessionID, body.CaptureID)
		if e != nil {
			return nil, captureMissing(e)
		}
		if capture.Receipt.State == "copying" && capture.Validated != nil {
			s.scheduleCapture(tx, r, capture)
		}
	case "commit":
		input, e := sp.DecodeImageCaptureCommit(m.MediaBody)
		if e != nil {
			return nil, fault("invalid_input", "Invalid image capture completion.")
		}
		capture, e = d.SessionCapture(ctx, r.Snapshot.SessionID, input.CaptureID)
		if e != nil {
			return nil, captureMissing(e)
		}
		if capture.Receipt.AttemptID != input.AttemptID {
			return nil, captureRefusal("resource_conflict", "Capture attempt identity changed.")
		}
		if capture.Validated != nil && !jsonEqual(encode(capture.Validated), encode(input.Validated)) {
			return nil, captureRefusal("resource_conflict", "Capture validation identity changed.")
		}
		if capture.Receipt.State == "committed" {
			break
		}
		if capture.Receipt.State == "failed" {
			return nil, captureRefusal("resource_conflict", "Capture attempt has failed.")
		}
		usage, e := d.SessionResourceUsage(ctx, r.Snapshot.SessionID)
		if e != nil {
			return nil, e
		}
		if usage.Deleting || usage.Frozen {
			return nil, conflict()
		}
		capture.Validated = &input.Validated
		capture.Receipt.State = "copying"
		if e = saveImageCapture(ctx, d, capture); e != nil {
			return nil, e
		}
		s.scheduleCapture(tx, r, capture)
	case "failed":
		var body struct {
			CaptureID string        `json:"captureId"`
			AttemptID string        `json:"attemptId"`
			Error     sp.ImageError `json:"error"`
		}
		if json.Unmarshal(m.MediaBody, &body) != nil {
			return nil, fault("invalid_input", "Invalid capture failure.")
		}
		capture, e = d.SessionCapture(ctx, r.Snapshot.SessionID, body.CaptureID)
		if e != nil {
			return nil, captureMissing(e)
		}
		if capture.Receipt.AttemptID != body.AttemptID {
			return nil, captureRefusal("resource_conflict", "Capture attempt identity changed.")
		}
		if capture.Receipt.State == "committed" || capture.Receipt.State == "copying" {
			return nil, captureRefusal("resource_conflict", "Capture attempt is already copying or committed.")
		}
		capture.Receipt.State = "failed"
		capture.Receipt.ResourceID = nil
		capture.Receipt.Error = &body.Error
		if e = saveImageCapture(ctx, d, capture); e != nil {
			return nil, e
		}
	default:
		return nil, fault("invalid_input", "Unsupported capture action.")
	}
	if e = s.syncImageBudget(ctx, tx, r); e != nil {
		return nil, e
	}
	capture, e = d.SessionCapture(ctx, r.Snapshot.SessionID, capture.Request.CaptureID)
	if e != nil {
		return nil, e
	}
	response["result"] = capture.Receipt
	return response, nil
}
func (s *Execution) scheduleCapture(tx *operationTx, r *record, capture store.SessionCaptureRecord) {
	fence, owner := r.Snapshot.ControllerFence, r.Owner
	project, taskID := r.Snapshot.Identity.ProjectID, r.Snapshot.Identity.TaskID
	afterCommit(tx, func() {
		key := fence.SessionID + "/" + capture.Request.CaptureID + "/" + capture.Receipt.AttemptID
		s.captureMutex.Lock()
		if s.captureJobs == nil {
			s.captureJobs = map[string]bool{}
		}
		if s.captureJobs[key] {
			s.captureMutex.Unlock()
			return
		}
		s.captureJobs[key] = true
		s.captureMutex.Unlock()
		go func() {
			defer func() { s.captureMutex.Lock(); delete(s.captureJobs, key); s.captureMutex.Unlock() }()
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
			defer cancel()
			worker := *s
			worker.browserRun = func(ctx context.Context, _ model.Principal, _, _, _ string, _ BrowserPurpose, fn func(*Access) error) error {
				return s.controllerRun(ctx, fence, func(a *Access) error { a.write = true; return fn(a) })
			}
			ioContext, finish, err := worker.beginImageIO(ctx, fence.SessionID, uuid.NewString())
			if err != nil {
				slog.ErrorContext(ctx, "Session image capture failed", "component", "session", "phase", "capture_copy", "session_id", fence.SessionID, "capture_id", capture.Request.CaptureID, "attempt_id", capture.Receipt.AttemptID, "causes", captureErrorFacts(err))
				return
			}
			err = worker.copyCapture(ioContext, model.Principal{UserID: owner}, project, taskID, fence.SessionID, capture)
			if failure := imageFailureEvidence(err); failure != nil {
				cleanup, stop := context.WithTimeout(context.WithoutCancel(ioContext), 5*time.Second)
				settleErr := worker.settleCaptureFailure(cleanup, model.Principal{UserID: owner}, project, taskID, fence.SessionID, capture, failure)
				err = errors.Join(err, settleErr)
				stop()
			}
			err = errors.Join(err, finish())
			if err != nil {
				slog.ErrorContext(ctx, "Session image capture failed", "component", "session", "phase", "capture_copy", "session_id", fence.SessionID, "capture_id", capture.Request.CaptureID, "attempt_id", capture.Receipt.AttemptID, "causes", captureErrorFacts(err))
			}
		}()
	})
}

func (s *Execution) settleCaptureFailure(ctx context.Context, p model.Principal, project, taskID, id string, capture store.SessionCaptureRecord, failure *definiteImageError) (result error) {
	if s.files == nil {
		return fault("component_unsupported", "Resource storage is unavailable.")
	}
	gate, err := s.files.AcquireGate(ctx, filestorage.PrivateGate, "session-image-upload/"+id+"/"+capture.Receipt.AttemptID)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, gate.Close()) }()
	hasUpload := false
	err = s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, _ task, _ bool) error {
		d, e := resourceDAO(tx)
		if e != nil {
			return e
		}
		current, e := d.SessionCapture(ctx, id, capture.Request.CaptureID)
		if e != nil {
			return e
		}
		if current.Receipt.State != "copying" || current.Receipt.AttemptID != capture.Receipt.AttemptID {
			return nil
		}
		upload, e := d.SessionUpload(ctx, id, capture.Receipt.AttemptID)
		if e == nil {
			if current.Receipt.ResourceID == nil || upload.BlobID != *current.Receipt.ResourceID || upload.ActorID != p.UserID || upload.Spec.ImageID != current.Request.Occurrence.ImageID || upload.Spec.UploadID != capture.Receipt.AttemptID {
				return conflict()
			}
			// Another worker can advance or publish after this failure. Only the
			// exact observed receiving or confirmed failed upload may be released.
			if failure.expectedUpload == nil || !jsonEqual(encode(upload), encode(*failure.expectedUpload)) || (upload.Receipt.State != "receiving" && upload.Receipt.State != "failed") || upload.Receipt.Resource != nil {
				return nil
			}
			hasUpload = true
			upload.Receipt.State, upload.Receipt.Error = "released", nil
			if e = s.saveImageUpload(ctx, tx, r, upload); e != nil {
				return e
			}
		} else {
			if !onlyCaptureMissing(e) {
				return e
			}
			if !failure.expectAbsent {
				return nil
			}
		}
		current.Receipt.State, current.Receipt.Error, current.Receipt.ResourceID = "failed", &failure.image, nil
		if e = saveImageCapture(ctx, d, current); e != nil {
			return e
		}
		return s.syncImageBudget(ctx, tx, r)
	})
	if err != nil || !hasUpload {
		return err
	}
	return s.cleanupUploadFiles(ctx, p, project, taskID, id, capture.Receipt.AttemptID)
}

// Diagnostic types and outcomes retain the error chain without logging paths,
// tokens, or content from underlying filesystem and database errors.
func captureErrorFacts(err error) []string {
	if err == nil {
		return nil
	}
	fact := fmt.Sprintf("%T", err)
	if f, ok := err.(*model.Fault); ok {
		fact += ":" + f.Code
	}
	if tx, ok := err.(*store.TransactionError); ok {
		fact += fmt.Sprintf(":%s:%s:cleanup_failed=%t", tx.Phase, tx.Outcome, tx.CleanupFailed)
	}
	if publication, ok := err.(*filestorage.PublicationError); ok {
		fact += ":" + string(publication.Outcome)
	}
	facts := []string{fact}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for _, child := range joined.Unwrap() {
			facts = append(facts, captureErrorFacts(child)...)
		}
	} else if next := errors.Unwrap(err); next != nil {
		facts = append(facts, captureErrorFacts(next)...)
	}
	return facts
}
func (s *Execution) copyCapture(ctx context.Context, p model.Principal, project, taskID, id string, capture store.SessionCaptureRecord) error {
	if capture.Validated == nil {
		return conflict()
	}
	v := capture.Validated
	spec := sp.ImageUploadSpec{UploadID: capture.Receipt.AttemptID, ImageID: capture.Request.Occurrence.ImageID, Target: sp.ImageTarget{ServerOrigin: s.Origin, ActorUserID: p.UserID, Fence: sp.Fence{}}, Name: "image", MediaType: v.MediaType, ByteLength: v.ByteLength, SHA256: v.SHA256}
	err := s.browser(ctx, p, project, taskID, id, func(_ *operationTx, r *record, _ task, _ bool) error {
		spec.Target.Fence = r.Snapshot.Fence
		spec.Target.ExpectedNativeSessionID = r.Snapshot.Identity.NativeSessionID
		return nil
	})
	if err != nil {
		return err
	}
	receipt, _, err := s.prepareUploadIdentity(ctx, p, project, taskID, id, spec, false, *capture.Receipt.ResourceID, capture.Request.CaptureID)
	if err != nil {
		return err
	}
	for number(receipt.AcceptedOffset) < number(v.ByteLength) {
		offset := receipt.AcceptedOffset
		body := map[string]any{"captureId": capture.Request.CaptureID, "attemptId": capture.Receipt.AttemptID, "sha256": v.SHA256, "byteLength": v.ByteLength, "offset": offset, "limit": imageChunkBytes}
		raw, e := s.controllerMedia(ctx, p, project, taskID, id, mediaIdentity(capture.Receipt.AttemptID, "read_capture/"+offset), "read_capture", body)
		if e != nil {
			return e
		}
		var chunk sp.PreparedImageChunk
		if json.Unmarshal(raw, &chunk) != nil || chunk.PreparationID != capture.Receipt.AttemptID || chunk.Offset != offset || chunk.SHA256 != v.SHA256 || chunk.ByteLength != v.ByteLength {
			return fault("resource_conflict", "Capture reader changed original identity.")
		}
		data, e := base64.StdEncoding.Strict().DecodeString(chunk.Data)
		if e != nil || len(data) == 0 || len(data) > imageChunkBytes || number(offset)+int64(len(data)) > number(v.ByteLength) || chunk.EOF != (number(offset)+int64(len(data)) == number(v.ByteLength)) {
			return fault("resource_conflict", "Capture reader returned an invalid original chunk.")
		}
		digest := imageBytesHash(data)
		receipt, e = s.writeUploadChunk(ctx, p, project, taskID, id, spec.UploadID, sp.ImageChunkWrite{UploadID: spec.UploadID, Offset: offset, SHA256: digest, Data: chunk.Data}, false)
		if e != nil {
			return e
		}
	}
	receipt, err = s.completeUpload(ctx, p, project, taskID, id, spec.UploadID, sp.ImageUploadComplete{SHA256: v.SHA256, ByteLength: v.ByteLength}, false)
	if err != nil {
		return err
	}
	return s.browser(ctx, p, project, taskID, id, func(tx *operationTx, _ *record, _ task, _ bool) error {
		d, e := resourceDAO(tx)
		if e != nil {
			return e
		}
		current, e := d.SessionCapture(ctx, id, capture.Request.CaptureID)
		if e != nil {
			return e
		}
		if current.Receipt.State == "committed" {
			return nil
		}
		if current.Receipt.State != "copying" || current.Receipt.AttemptID != capture.Receipt.AttemptID || receipt.Resource == nil {
			return conflict()
		}
		current.Receipt.State = "committed"
		current.Receipt.Resource = receipt.Resource
		current.Receipt.ResourceID = &receipt.Resource.ResourceID
		if e = d.AddSessionResourceReference(ctx, store.SessionResourceReference{SessionID: id, ResourceID: receipt.Resource.ResourceID, Kind: "message", ReferenceID: capture.Request.Occurrence.ImageID}); e != nil {
			return e
		}
		if e = d.RemoveSessionResourceReference(ctx, store.SessionResourceReference{SessionID: id, ResourceID: receipt.Resource.ResourceID, Kind: "upload", ReferenceID: capture.Receipt.AttemptID}); e != nil {
			return e
		}
		return saveImageCapture(ctx, d, current)
	})
}

func imageBytesHash(data []byte) string { h := sha256.Sum256(data); return hex.EncodeToString(h[:]) }

func saveImageCapture(ctx context.Context, d store.SessionResourceDAO, row store.SessionCaptureRecord) error {
	refuse := func() error {
		return fault("resource_conflict", "Image capture identity already has different content.")
	}
	old, e := d.SessionCapture(ctx, row.SessionID, row.Request.CaptureID)
	if e == nil {
		if !jsonEqual(encode(old.Request), encode(row.Request)) {
			return refuse()
		}
		if jsonEqual(encode(old.Receipt), encode(row.Receipt)) && jsonEqual(encode(old.Validated), encode(row.Validated)) {
			return nil
		}
		if old.Receipt.AttemptID == row.Receipt.AttemptID {
			if old.Validated != nil && !jsonEqual(encode(old.Validated), encode(row.Validated)) {
				return refuse()
			}
			if old.Receipt.State != "reserved" && (old.Receipt.State != "copying" || row.Receipt.State != "copying" && row.Receipt.State != "failed" && row.Receipt.State != "committed") {
				return refuse()
			}
		} else {
			if old.Receipt.State != "failed" || row.Receipt.State != "reserved" || row.Validated != nil {
				return refuse()
			}
			// The authorized Session lock also protects upload staging and identity
			// observations until the capture's expected-state update completes.
			upload, err := d.SessionUpload(ctx, row.SessionID, old.Receipt.AttemptID)
			if err != nil && !onlyCaptureMissing(err) {
				return err
			}
			if err == nil && !upload.StorageReleased {
				return refuse()
			}
			if _, err = d.SessionUpload(ctx, row.SessionID, row.Receipt.AttemptID); err == nil {
				return refuse()
			} else if !onlyCaptureMissing(err) {
				return err
			}
		}
		row.Expected = &store.SessionCaptureState{Receipt: old.Receipt, Validated: old.Validated}
		row.Receipt.Revision = next(old.Receipt.Revision)
	} else if !onlyCaptureMissing(e) {
		return e
	} else {
		row.Expected = nil
		if row.Receipt.Revision == "" {
			row.Receipt.Revision = "1"
		}
	}
	return d.SaveSessionCapture(ctx, row)
}

func verifyImageOccurrence(ctx context.Context, tx *operationTx, r *record, occurrence sp.ImageOccurrence) error {
	dao, e := archiveDAO(tx)
	if e != nil {
		return e
	}
	bundle, e := dao.SessionArchiveBundle(ctx, r.Snapshot.SessionID)
	if e != nil {
		return e
	}
	var ledger archiveLedger
	if json.Unmarshal(bundle.Ledger, &ledger) != nil {
		return conflict()
	}
	for _, position := range ledger.Occurrences {
		if position.ImageID == occurrence.ImageID && position.EntryID == occurrence.EntryID && position.Container == occurrence.Container && model.EqualOptional(position.PartID, occurrence.PartID) && model.EqualOptional(position.SourceRevision, occurrence.SourceRevision) && model.EqualOptional(position.SourceTextSHA256, occurrence.SourceTextSHA256) && model.EqualOptional(position.CallIDSHA256, archiveCallIDSHA256(occurrence.CallID)) {
			return nil
		}
	}
	return fault("resource_conflict", "The image occurrence is not part of the acknowledged complete source checkpoint.")
}
