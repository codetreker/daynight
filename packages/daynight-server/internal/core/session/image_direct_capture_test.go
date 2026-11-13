package session

import (
	"context"
	"encoding/base64"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type directCaptureSaveFailureDAO struct {
	*imageRuleDAO
	err, pinErr, removeErr error
}

type directCaptureObservationDAO struct {
	*imageRuleDAO
	point string
	cause error
}

func (d *directCaptureObservationDAO) SessionResourceUsage(ctx context.Context, id string) (store.SessionResourceUsage, error) {
	if d.point == "usage" {
		return store.SessionResourceUsage{}, d.cause
	}
	return d.imageRuleDAO.SessionResourceUsage(ctx, id)
}

func (d *directCaptureObservationDAO) SessionCapture(ctx context.Context, session, id string) (store.SessionCaptureRecord, error) {
	if d.point == "capture" {
		return store.SessionCaptureRecord{}, d.cause
	}
	return d.imageRuleDAO.SessionCapture(ctx, session, id)
}

func (d *directCaptureObservationDAO) SessionUpload(ctx context.Context, session, id string) (store.SessionUploadRecord, error) {
	if d.point == "upload" {
		return store.SessionUploadRecord{}, d.cause
	}
	return d.imageRuleDAO.SessionUpload(ctx, session, id)
}

func (d *directCaptureObservationDAO) SavedSessionResource(ctx context.Context, session, id string) (store.SessionResourceRecord, error) {
	if d.point == "resource" {
		return store.SessionResourceRecord{}, d.cause
	}
	return d.imageRuleDAO.SavedSessionResource(ctx, session, id)
}

func (d *directCaptureObservationDAO) SessionResourceReferenceExists(ctx context.Context, ref store.SessionResourceReference) (bool, error) {
	if d.point == "reference" {
		return false, d.cause
	}
	return d.imageRuleDAO.SessionResourceReferenceExists(ctx, ref)
}

func (d *directCaptureSaveFailureDAO) SaveSessionCapture(context.Context, store.SessionCaptureRecord) error {
	return d.err
}

func (d *directCaptureSaveFailureDAO) AddSessionResourceReference(ctx context.Context, ref store.SessionResourceReference) error {
	if d.pinErr != nil {
		return d.pinErr
	}
	return d.imageRuleDAO.AddSessionResourceReference(ctx, ref)
}

func (d *directCaptureSaveFailureDAO) RemoveSessionResourceReference(ctx context.Context, ref store.SessionResourceReference) error {
	if d.removeErr != nil {
		return d.removeErr
	}
	return d.imageRuleDAO.RemoveSessionResourceReference(ctx, ref)
}

func directCaptureFixture(t *testing.T, f imageRuleFixture) sp.ImageCaptureRequest {
	t.Helper()
	request := sp.ImageCaptureRequest{CaptureID: uuid.NewString(), AttemptID: uuid.NewString(), Occurrence: sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "content", SourceKey: "original"}, Locator: sp.ImageLocator{Kind: "external", URL: "https://images.example/original.png"}}
	f.d.bundle.Ledger = encode(archiveLedger{HistoryID: f.d.bundle.HistoryID, HistoryEpoch: f.r.Snapshot.HistoryEpoch, SourceThrough: "0", Occurrences: []archiveLedgerOccurrence{{EntryID: request.Occurrence.EntryID, ImageID: request.Occurrence.ImageID, Container: "content"}}})
	return request
}

func directCaptureCall(t *testing.T, f imageRuleFixture, input sp.DirectCaptureSubmission) (sp.ImageCaptureReceipt, error) {
	t.Helper()
	response, err := f.s.captureMessage(t.Context(), &operationTx{dao: f.d, op: &Operation{}}, f.r, sp.ControllerMessage{Action: "submit", MediaBody: encode(input)})
	if err != nil {
		return sp.ImageCaptureReceipt{}, err
	}
	return response["result"].(sp.ImageCaptureReceipt), nil
}

func TestDirectCaptureCopiesAndReplaysOriginalValidatedContent(t *testing.T) {
	raw := []byte("original")
	f := newImageRuleFixture(t, raw)
	request := directCaptureFixture(t, f)
	validated := sp.ValidatedImage{MediaType: "image/png", ByteLength: decimal(int64(len(raw))), SHA256: imageBytesHash(raw), Width: 2, Height: 3, FrameCount: 1}
	input := sp.DirectCaptureSubmission{Request: request, AttemptID: request.AttemptID, Outcome: sp.DirectCaptureOutcome{Kind: "validated", Validated: &validated}}
	first, err := directCaptureCall(t, f, input)
	if err != nil || first.State != "copying" || len(f.d.uploads) != 0 {
		t.Fatal(first, err)
	}
	replay, err := directCaptureCall(t, f, input)
	if err != nil || !reflect.DeepEqual(first, replay) || len(f.d.captures) != 1 {
		t.Fatal("copying replay changed receipt", replay, err)
	}
	changed := validated
	changed.SHA256 = imageBytesHash([]byte("different"))
	wrong := input
	wrong.Outcome.Validated = &changed
	if _, err = directCaptureCall(t, f, wrong); err == nil {
		t.Fatal("changed validated source accepted")
	}
	f.d.respond = func(row store.SessionMediaRequest) store.SessionMediaRequest {
		row.Complete = true
		row.Result = encode(sp.PreparedImageChunk{PreparationID: request.AttemptID, ByteLength: validated.ByteLength, SHA256: validated.SHA256, Offset: "0", Data: base64.StdEncoding.EncodeToString(raw), EOF: true})
		return row
	}
	if err = f.s.copyCapture(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.d.captures[request.CaptureID]); err != nil {
		t.Fatal(err)
	}
	committed, err := directCaptureCall(t, f, input)
	if err != nil || committed.State != "committed" || committed.ResourceID == nil {
		t.Fatal(committed, err)
	}
	chunk, err := f.s.ReadResource(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, sp.ImageReadRequest{ResourceID: *committed.ResourceID, Offset: "0", Limit: len(raw)})
	if err != nil || chunk.Data != base64.StdEncoding.EncodeToString(raw) || !chunk.EOF {
		t.Fatal("published original changed", chunk, err)
	}
	if len(f.d.uploads) != 1 || len(f.d.resources) != 1 {
		t.Fatal("replay duplicated original", len(f.d.uploads), len(f.d.resources))
	}
}

func TestDirectCaptureTerminalFailureAndCurrentAttempt(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	request := directCaptureFixture(t, f)
	failure := sp.ImageError{Code: "source_timeout", Message: "Original timed out."}
	input := sp.DirectCaptureSubmission{Request: request, AttemptID: request.AttemptID, Outcome: sp.DirectCaptureOutcome{Kind: "failed", Error: &failure}}
	first, err := directCaptureCall(t, f, input)
	if err != nil || first.State != "failed" || first.Error == nil || *first.Error != failure {
		t.Fatal(first, err)
	}
	replay, err := directCaptureCall(t, f, input)
	if err != nil || !reflect.DeepEqual(first, replay) {
		t.Fatal("failed replay changed receipt", replay, err)
	}
	changed := failure
	changed.Message = "Different failure."
	input.Outcome.Error = &changed
	if _, err = directCaptureCall(t, f, input); err == nil {
		t.Fatal("different failure accepted")
	}
	current := f.d.captures[request.CaptureID]
	current.Receipt.AttemptID = uuid.NewString()
	current.Receipt.State, current.Receipt.Error = "reserved", nil
	resource := uuid.NewString()
	current.Receipt.ResourceID = &resource
	f.d.captures[request.CaptureID] = current
	input.Outcome.Error = &failure
	if _, err = directCaptureCall(t, f, input); err == nil {
		t.Fatal("late old attempt accepted")
	}
	input.AttemptID = current.Receipt.AttemptID
	if result, err := directCaptureCall(t, f, input); err != nil || result.AttemptID != input.AttemptID || result.State != "failed" {
		t.Fatal("current retry rejected", result, err)
	}
}

func TestDirectCaptureReplaysValidatedSubmissionAfterCopyFailure(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	request := directCaptureFixture(t, f)
	validated := sp.ValidatedImage{MediaType: "image/png", ByteLength: "8", SHA256: imageBytesHash([]byte("original")), Width: 2, Height: 3, FrameCount: 1}
	input := sp.DirectCaptureSubmission{Request: request, AttemptID: request.AttemptID, Outcome: sp.DirectCaptureOutcome{Kind: "validated", Validated: &validated}}
	if _, err := directCaptureCall(t, f, input); err != nil {
		t.Fatal(err)
	}
	current := f.d.captures[request.CaptureID]
	current.Receipt.State, current.Receipt.ResourceID = "failed", nil
	current.Receipt.Error = &sp.ImageError{Code: "storage_unavailable", Message: "Original could not be stored."}
	f.d.captures[request.CaptureID] = current
	replay, err := directCaptureCall(t, f, input)
	if err != nil || replay.State != "failed" || !reflect.DeepEqual(replay.Error, current.Receipt.Error) {
		t.Fatal("original outcome did not retain copy failure", replay, err)
	}
	input.Outcome = sp.DirectCaptureOutcome{Kind: "failed", Error: current.Receipt.Error}
	if _, err = directCaptureCall(t, f, input); err == nil {
		t.Fatal("different submission outcome reused validated identity")
	}
}

func TestDirectCaptureRequiresOriginalOccurrenceAndInitialAttempt(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	request := directCaptureFixture(t, f)
	failure := sp.ImageError{Code: "source_timeout", Message: "Original timed out."}
	input := sp.DirectCaptureSubmission{Request: request, AttemptID: uuid.NewString(), Outcome: sp.DirectCaptureOutcome{Kind: "failed", Error: &failure}}
	if _, err := directCaptureCall(t, f, input); err == nil || len(f.d.captures) != 0 {
		t.Fatal("initial submission accepted a different attempt")
	}
	input.AttemptID = request.AttemptID
	input.Request.Occurrence.EntryID = uuid.NewString()
	if _, err := directCaptureCall(t, f, input); err == nil || len(f.d.captures) != 0 {
		t.Fatal("unacknowledged occurrence was accepted")
	}
	input.Request = request
	f.r.Snapshot.Identity.Provider = "codex"
	input.Request.NativeSource = &sp.NativeImageSource{Provider: "claude", NativeSessionID: "native", NativeMessageID: "message", NativePartID: "part"}
	if _, err := directCaptureCall(t, f, input); len(f.d.captures) != 0 {
		t.Fatal("unmatched native source was registered")
	} else {
		var refusal *CaptureRequestError
		if !errors.As(err, &refusal) || refusal.Code != "session_conflict" {
			t.Fatal("unmatched native source was not refused per request", err)
		}
	}
}

func TestDirectCaptureNativeLocatorAndResourceStateRefusePerRequest(t *testing.T) {
	for _, condition := range []string{"native locator", "frozen", "deleting"} {
		t.Run(condition, func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("original"))
			request := directCaptureFixture(t, f)
			f.r.Snapshot.Identity.Provider = "codex"
			switch condition {
			case "native locator":
				request.Locator = sp.ImageLocator{Kind: "native", Provider: "claude", NativeSessionID: "native", NativeMessageID: "message", NativePartID: "part"}
			case "frozen":
				f.d.usage.Frozen = true
			case "deleting":
				f.d.usage.Deleting = true
			}
			failure := sp.ImageError{Code: "source_timeout", Message: "Original timed out."}
			dao := &mediaHandleDAO{imageRuleDAO: f.d}
			f.s.controllerRun = func(ctx context.Context, fence sp.ControllerFence, work func(*Access) error) error {
				return work(&Access{tx: &operationTx{dao: dao, op: &Operation{}}, record: f.r})
			}
			body := sp.DirectCaptureSubmission{Request: request, AttemptID: request.AttemptID, Outcome: sp.DirectCaptureOutcome{Kind: "failed", Error: &failure}}
			_, err := f.s.Handle(t.Context(), sp.ControllerMessage{Type: "image_capture", ControllerFence: f.r.Snapshot.ControllerFence, Action: "submit", MediaBody: encode(body)})
			var refusal *CaptureRequestError
			if !errors.As(err, &refusal) || refusal.Code != "session_conflict" || len(f.d.captures) != 0 || dao.touches != 1 || dao.sessionWrites != 1 {
				t.Fatal("condition did not refuse this request", err)
			}
		})
	}
}

func TestDirectCaptureResourceAndEligibility(t *testing.T) {
	raw := []byte("original")
	f := newImageRuleFixture(t, raw)
	f.prepare(t)
	if _, err := f.write(t, raw, 0); err != nil {
		t.Fatal(err)
	}
	upload, err := f.complete(t)
	if err != nil || upload.Resource == nil {
		t.Fatal(upload, err)
	}
	request := directCaptureFixture(t, f)
	request.Locator = sp.ImageLocator{Kind: "resource", ResourceID: upload.Resource.ResourceID}
	input := sp.DirectCaptureSubmission{Request: request, AttemptID: request.AttemptID, Outcome: sp.DirectCaptureOutcome{Kind: "resource"}}
	first, err := directCaptureCall(t, f, input)
	if err != nil || first.State != "committed" || first.ResourceID == nil || *first.ResourceID != upload.Resource.ResourceID {
		t.Fatal(first, err)
	}
	replay, err := directCaptureCall(t, f, input)
	if err != nil || !reflect.DeepEqual(first, replay) || len(f.d.resources) != 1 || len(f.d.uploads) != 1 {
		t.Fatal("resource replay duplicated content", replay, err)
	}
	f.d.usage.Frozen = true
	if _, err = directCaptureCall(t, f, input); err == nil {
		t.Fatal("frozen session accepted replay")
	}
}

func TestDirectCaptureDoesNotCommitResourceReferenceOnIdentityRefusal(t *testing.T) {
	raw := []byte("original")
	for _, identityConflict := range []bool{true, false} {
		f := newImageRuleFixture(t, raw)
		f.prepare(t)
		if _, err := f.write(t, raw, 0); err != nil {
			t.Fatal(err)
		}
		upload, err := f.complete(t)
		if err != nil || upload.Resource == nil {
			t.Fatal(upload, err)
		}
		request := directCaptureFixture(t, f)
		request.Locator = sp.ImageLocator{Kind: "resource", ResourceID: upload.Resource.ResourceID}
		input := sp.DirectCaptureSubmission{Request: request, AttemptID: request.AttemptID, Outcome: sp.DirectCaptureOutcome{Kind: "resource"}}
		storageFailure := errors.New("storage unavailable")
		saveFailure := error(storageFailure)
		if identityConflict {
			saveFailure = &model.Fault{Code: "resource_conflict", Message: "Identity already used."}
		}
		dao := &directCaptureSaveFailureDAO{imageRuleDAO: f.d, err: saveFailure}
		_, err = f.s.captureMessage(t.Context(), &operationTx{dao: dao, op: &Operation{}}, f.r, sp.ControllerMessage{Action: "submit", MediaBody: encode(input)})
		var refusal *CaptureRequestError
		if identityConflict && (!errors.As(err, &refusal) || refusal.Code != "resource_conflict") || !identityConflict && !errors.Is(err, storageFailure) {
			t.Fatal("save failure misclassified", err)
		}
		ref := store.SessionResourceReference{SessionID: f.r.Snapshot.SessionID, ResourceID: upload.Resource.ResourceID, Kind: "message", ReferenceID: request.Occurrence.ImageID}
		if identityConflict && f.d.references[ref] {
			t.Fatal("refused capture left a message reference")
		}
	}
}

func TestDirectCaptureResourceReclamationAndPinFailures(t *testing.T) {
	for _, condition := range []string{"reclaiming", "pin conflict", "pin storage failure", "existing pin", "pin cleanup failure"} {
		t.Run(condition, func(t *testing.T) {
			raw := []byte("original")
			f := newImageRuleFixture(t, raw)
			f.prepare(t)
			if _, err := f.write(t, raw, 0); err != nil {
				t.Fatal(err)
			}
			upload, err := f.complete(t)
			if err != nil || upload.Resource == nil {
				t.Fatal(upload, err)
			}
			request := directCaptureFixture(t, f)
			request.Locator = sp.ImageLocator{Kind: "resource", ResourceID: upload.Resource.ResourceID}
			ref := store.SessionResourceReference{SessionID: f.r.Snapshot.SessionID, ResourceID: upload.Resource.ResourceID, Kind: "message", ReferenceID: request.Occurrence.ImageID}
			failure := errors.New("storage failed")
			conflict := &model.Fault{Code: "resource_conflict", Message: "Original is being reclaimed."}
			dao := &directCaptureSaveFailureDAO{imageRuleDAO: f.d, err: conflict}
			switch condition {
			case "reclaiming":
				resource := f.d.resources[upload.Resource.ResourceID]
				resource.GCPending = true
				f.d.resources[upload.Resource.ResourceID] = resource
			case "pin conflict":
				dao.pinErr = conflict
			case "pin storage failure":
				dao.pinErr = failure
			case "existing pin":
				f.d.references[ref] = true
			case "pin cleanup failure":
				dao.removeErr = failure
			}
			input := sp.DirectCaptureSubmission{Request: request, AttemptID: request.AttemptID, Outcome: sp.DirectCaptureOutcome{Kind: "resource"}}
			_, err = f.s.captureMessage(t.Context(), &operationTx{dao: dao, op: &Operation{}}, f.r, sp.ControllerMessage{Action: "submit", MediaBody: encode(input)})
			var refusal *CaptureRequestError
			if condition == "pin storage failure" || condition == "pin cleanup failure" {
				if !errors.Is(err, failure) || errors.As(err, &refusal) {
					t.Fatal("storage failure was hidden", err)
				}
			} else if !errors.As(err, &refusal) || refusal.Code != "resource_conflict" {
				t.Fatal("resource conflict was not isolated", err)
			}
			if len(f.d.captures) != 0 {
				t.Fatal("refusal left a committed capture")
			}
			if condition == "existing pin" && !f.d.references[ref] {
				t.Fatal("prior pin was removed")
			}
		})
	}
}

func TestDirectCaptureObservationsPreserveStorageFailures(t *testing.T) {
	for _, point := range []string{"usage", "capture", "upload", "resource", "reference"} {
		t.Run(point, func(t *testing.T) {
			raw := []byte("original")
			f := newImageRuleFixture(t, raw)
			var resourceID string
			if point == "resource" || point == "reference" {
				f.prepare(t)
				if _, err := f.write(t, raw, 0); err != nil {
					t.Fatal(err)
				}
				upload, err := f.complete(t)
				if err != nil || upload.Resource == nil {
					t.Fatal(upload, err)
				}
				resourceID = upload.Resource.ResourceID
			}
			request := directCaptureFixture(t, f)
			input := sp.DirectCaptureSubmission{Request: request, AttemptID: request.AttemptID, Outcome: sp.DirectCaptureOutcome{Kind: "failed", Error: &sp.ImageError{Code: "source_timeout", Message: "Original timed out."}}}
			if resourceID != "" {
				input.Request.Locator = sp.ImageLocator{Kind: "resource", ResourceID: resourceID}
				input.Outcome = sp.DirectCaptureOutcome{Kind: "resource"}
			}
			cause := errors.New("observation unavailable")
			dao := &directCaptureObservationDAO{imageRuleDAO: f.d, point: point, cause: cause}
			_, err := f.s.captureMessage(t.Context(), &operationTx{dao: dao, op: &Operation{}}, f.r, sp.ControllerMessage{Action: "submit", MediaBody: encode(input)})
			var refusal *CaptureRequestError
			if !errors.Is(err, cause) || errors.As(err, &refusal) || len(f.d.captures) != 0 {
				t.Fatal("observation error was hidden or created a capture", err)
			}
			if resourceID != "" {
				ref := store.SessionResourceReference{SessionID: f.r.Snapshot.SessionID, ResourceID: resourceID, Kind: "message", ReferenceID: request.Occurrence.ImageID}
				if f.d.references[ref] {
					t.Fatal("observation error created a reference")
				}
			}
		})
	}
}

func TestDirectCaptureRejectsMissingResourceAndConflictingUploadIdentity(t *testing.T) {
	for _, condition := range []string{"missing resource", "upload identity", "outcome locator"} {
		t.Run(condition, func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("original"))
			request := directCaptureFixture(t, f)
			input := sp.DirectCaptureSubmission{Request: request, AttemptID: request.AttemptID, Outcome: sp.DirectCaptureOutcome{Kind: "resource"}}
			if condition != "outcome locator" {
				input.Request.Locator = sp.ImageLocator{Kind: "resource", ResourceID: uuid.NewString()}
			}
			if condition == "upload identity" {
				f.d.uploads[request.AttemptID] = store.SessionUploadRecord{SessionID: f.r.Snapshot.SessionID}
			}
			_, err := directCaptureCall(t, f, input)
			var refusal *CaptureRequestError
			if !errors.As(err, &refusal) || refusal.Code != "resource_conflict" || len(f.d.captures) != 0 {
				t.Fatal("ineligible capture was not refused", err)
			}
		})
	}
}

func TestDirectCapturePersistsFailureWhenDecoderUnavailable(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	f.s.SetImageDecoder(nil)
	request := directCaptureFixture(t, f)
	validated := sp.ValidatedImage{MediaType: "image/png", ByteLength: "8", SHA256: imageBytesHash([]byte("original")), Width: 2, Height: 3, FrameCount: 1}
	input := sp.DirectCaptureSubmission{Request: request, AttemptID: request.AttemptID, Outcome: sp.DirectCaptureOutcome{Kind: "validated", Validated: &validated}}
	first, err := directCaptureCall(t, f, input)
	if err != nil || first.State != "failed" || first.Error == nil || first.Error.Code != "component_unsupported" {
		t.Fatal("decoder absence did not persist a failure", first, err)
	}
	replay, err := directCaptureCall(t, f, input)
	if err != nil || !reflect.DeepEqual(first, replay) || len(f.d.resources) != 0 || len(f.d.uploads) != 0 {
		t.Fatal("decoder failure replay changed the original result", replay, err)
	}
}
