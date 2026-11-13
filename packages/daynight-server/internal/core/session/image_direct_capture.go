package session

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func (s *Execution) submitImageCapture(ctx context.Context, tx *operationTx, r *record, d store.SessionResourceDAO, input sp.DirectCaptureSubmission) (store.SessionCaptureRecord, error) {
	var empty store.SessionCaptureRecord
	request := input.Request
	refuse := func() (store.SessionCaptureRecord, error) {
		return empty, captureRefusal("resource_conflict", "Capture identity already belongs to different content or attempt.")
	}
	if request.Locator.Kind == "native" && (request.Locator.Provider != r.Snapshot.Identity.Provider || r.Snapshot.Identity.NativeSessionID == nil || request.Locator.NativeSessionID != *r.Snapshot.Identity.NativeSessionID) {
		return empty, captureRefusal("session_conflict", "Session identity or state no longer matches.")
	}
	if request.NativeSource != nil && (request.NativeSource.Provider != r.Snapshot.Identity.Provider || r.Snapshot.Identity.NativeSessionID == nil || request.NativeSource.NativeSessionID != *r.Snapshot.Identity.NativeSessionID) {
		return empty, captureRefusal("session_conflict", "Session identity or state no longer matches.")
	}
	usage, err := d.SessionResourceUsage(ctx, r.Snapshot.SessionID)
	if err != nil {
		return empty, err
	}
	if usage.Deleting || usage.Frozen {
		return empty, captureRefusal("session_conflict", "Session identity or state no longer matches.")
	}
	if input.Outcome.Kind == "resource" && request.Locator.Kind != "resource" || input.Outcome.Kind == "validated" && request.Locator.Kind == "resource" {
		return refuse()
	}
	capture, err := d.SessionCapture(ctx, r.Snapshot.SessionID, request.CaptureID)
	if err == nil {
		if !jsonEqual(encode(capture.Request), encode(request)) || capture.Receipt.AttemptID != input.AttemptID {
			return refuse()
		}
	} else {
		if !onlyCaptureMissing(err) {
			return empty, err
		}
		if request.AttemptID != input.AttemptID {
			return refuse()
		}
		if _, err = d.SessionUpload(ctx, r.Snapshot.SessionID, input.AttemptID); err == nil {
			return refuse()
		} else if !onlyCaptureMissing(err) {
			return empty, err
		}
		if err = verifyImageOccurrence(ctx, tx, r, request.Occurrence); err != nil {
			if f, ok := err.(*model.Fault); ok && f.Code == "resource_conflict" {
				return empty, captureRefusal(f.Code, f.Message)
			}
			if onlyCaptureMissing(err) {
				return empty, captureRefusal("capability_changed", "Complete source metadata is unavailable for image capture.")
			}
			return empty, err
		}
		if err = requireImageHistoryLedger(ctx, tx, r, true); err != nil {
			if f, ok := err.(*model.Fault); ok && (f.Code == "capability_changed" || f.Code == "component_unsupported") {
				return empty, captureRefusal(f.Code, f.Message)
			}
			return empty, err
		}
		resourceID := uuid.NewString()
		capture = store.SessionCaptureRecord{SessionID: r.Snapshot.SessionID, Request: request, Receipt: sp.ImageCaptureReceipt{CaptureID: request.CaptureID, AttemptID: input.AttemptID, Revision: "1", Occurrence: request.Occurrence, State: "reserved", ResourceID: &resourceID}}
	}

	var reference *store.SessionResourceReference
	switch input.Outcome.Kind {
	case "validated":
		if capture.Validated != nil && !jsonEqual(encode(capture.Validated), encode(input.Outcome.Validated)) {
			return refuse()
		}
		if capture.Receipt.State != "reserved" {
			if capture.Validated == nil {
				return refuse()
			}
			if capture.Receipt.State == "copying" {
				s.scheduleCapture(tx, r, capture)
			}
			return capture, nil
		}
		capture.Validated = input.Outcome.Validated
		if s.imageDecoder == nil {
			capture.Receipt.State, capture.Receipt.ResourceID = "failed", nil
			capture.Receipt.Error = &sp.ImageError{Code: "component_unsupported", Message: "Full image validation is unavailable."}
		} else {
			capture.Receipt.State = "copying"
		}
	case "resource":
		if capture.Receipt.State == "committed" && capture.Validated == nil && capture.Receipt.ResourceID != nil && *capture.Receipt.ResourceID == request.Locator.ResourceID {
			return capture, nil
		}
		if capture.Receipt.State != "reserved" || capture.Validated != nil {
			return refuse()
		}
		saved, e := d.SavedSessionResource(ctx, r.Snapshot.SessionID, request.Locator.ResourceID)
		if e != nil {
			if onlyCaptureMissing(e) {
				return empty, captureRefusal("resource_conflict", "The original image resource was not found.")
			}
			return empty, e
		}
		if saved.Resource.Status != "available" || saved.GCPending {
			return empty, captureRefusal("resource_conflict", "The original image resource is unavailable.")
		}
		capture.Receipt.State, capture.Receipt.ResourceID, capture.Receipt.Resource = "committed", &saved.Resource.ResourceID, &saved.Resource
		reference = &store.SessionResourceReference{SessionID: r.Snapshot.SessionID, ResourceID: saved.Resource.ResourceID, Kind: "message", ReferenceID: request.Occurrence.ImageID}
	case "failed":
		if capture.Receipt.State == "failed" && capture.Validated == nil && jsonEqual(encode(capture.Receipt.Error), encode(input.Outcome.Error)) {
			return capture, nil
		}
		if capture.Receipt.State != "reserved" || capture.Validated != nil {
			return refuse()
		}
		capture.Receipt.State, capture.Receipt.ResourceID, capture.Receipt.Error = "failed", nil, input.Outcome.Error
	default:
		return empty, fault("invalid_input", "Invalid direct image capture outcome.")
	}
	var referenceExisted bool
	if reference != nil {
		referenceExisted, err = d.SessionResourceReferenceExists(ctx, *reference)
		if err != nil {
			return empty, err
		}
		if err = d.AddSessionResourceReference(ctx, *reference); err != nil {
			if f, ok := err.(*model.Fault); ok && f.Code == "resource_conflict" {
				return empty, captureRefusal(f.Code, f.Message)
			}
			return empty, err
		}
	}
	if err = saveImageCapture(ctx, d, capture); err != nil {
		if f, ok := err.(*model.Fault); ok && f.Code == "resource_conflict" {
			// A refused identity may commit only after removing a pin introduced
			// by this request; an existing pin belongs to its original owner.
			if reference != nil && !referenceExisted {
				if cleanupErr := d.RemoveSessionResourceReference(ctx, *reference); cleanupErr != nil {
					return empty, errors.Join(err, cleanupErr)
				}
			}
			return empty, captureRefusal(f.Code, f.Message)
		}
		return empty, err
	}
	if capture.Receipt.State == "copying" {
		s.scheduleCapture(tx, r, capture)
	}
	return capture, nil
}
