package session

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func captureCanRetry(ctx context.Context, d store.SessionResourceDAO, c store.SessionCaptureRecord, writable bool) (bool, error) {
	if !writable || c.Receipt.State != "failed" || c.Receipt.Resource != nil || c.Receipt.ResourceID != nil || c.Receipt.Error == nil || (c.Request.Locator.Kind != "local" && c.Request.Locator.Kind != "external") {
		return false, nil
	}
	switch c.Receipt.Error.Code {
	case "invalid_image", "unsupported_media_type", "decode_failed", "image_decode_failed", "quota_exceeded", "storage_unavailable",
		"source_not_found", "source_timeout", "source_changed", "source_busy", "source_rate_limited", "source_capacity", "source_queue_timeout":
	default:
		return false, nil
	}
	upload, e := d.SessionUpload(ctx, c.SessionID, c.Receipt.AttemptID)
	if errors.Is(e, model.ErrNotFound) {
		return true, nil
	}
	if e != nil {
		return false, e
	}
	return upload.StorageReleased && (upload.Receipt.State == "failed" || upload.Receipt.State == "expired" || upload.Receipt.State == "released"), nil
}
func (s *Execution) GetImageOccurrence(ctx context.Context, p model.Principal, project, taskID, id, imageID string) (sp.ImageOccurrenceStatus, error) {
	out := sp.ImageOccurrenceStatus{ImageID: imageID, Revision: "1", State: "unregistered", Action: "none"}
	e := s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, t task, write bool) error {
		if e := s.admitImageRate(ctx, tx, p.UserID, "observe"); e != nil {
			return e
		}
		d, e := resourceDAO(tx)
		if e != nil {
			return e
		}
		capture, e := d.SessionCaptureByImage(ctx, id, imageID)
		if errors.Is(e, model.ErrNotFound) {
			return nil
		}
		if e != nil {
			return e
		}
		// Reconcile only an already completed original retry request. A status read
		// never creates a source request or changes its locator.
		if capture.Receipt.State == "reserved" && capture.Receipt.AttemptID != capture.Request.AttemptID {
			if media, ok := tx.dao.(store.SessionMediaDAO); ok {
				row, err := media.SessionMediaRequest(ctx, id, mediaIdentity(capture.Receipt.AttemptID, "retry_capture"))
				if err != nil && !errors.Is(err, model.ErrNotFound) {
					return err
				}
				if err == nil && row.Complete && row.Error == nil {
					v, err := sp.DecodeValidatedImage(row.Result)
					if err != nil {
						return fault("resource_conflict", "The original retry result is invalid.")
					}
					capture.Validated = &v
					capture.Receipt.State = "copying"
					if e = saveImageCapture(ctx, d, capture); e != nil {
						return e
					}
					s.scheduleCapture(tx, r, capture)
					capture, e = d.SessionCapture(ctx, id, capture.Request.CaptureID)
					if e != nil {
						return e
					}
				} else if err == nil && row.Complete && row.Error != nil {
					capture.Receipt.State, capture.Receipt.Error, capture.Receipt.ResourceID = "failed", row.Error, nil
					if e = saveImageCapture(ctx, d, capture); e != nil {
						return e
					}
					capture, e = d.SessionCapture(ctx, id, capture.Request.CaptureID)
					if e != nil {
						return e
					}
				}
			}
		}
		out.Revision = capture.Receipt.Revision
		if out.Revision == "" {
			out.Revision = "1"
		}
		out.Error = capture.Receipt.Error
		switch capture.Receipt.State {
		case "committed":
			out.State, out.Action, out.ResourceID = "committed", "read_saved", capture.Receipt.ResourceID
		case "reserved", "copying":
			out.State, out.Action, out.ResourceID = "pending", "observe", capture.Receipt.ResourceID
			if capture.Receipt.State == "copying" && capture.Validated != nil {
				s.scheduleCapture(tx, r, capture)
			}
		case "failed":
			if capture.Receipt.Error == nil || capture.Receipt.ResourceID != nil || capture.Receipt.Resource != nil {
				return fault("resource_conflict", "The original occurrence has an invalid failure receipt.")
			}
			out.State = "failed"
			yes, e := captureCanRetry(ctx, d, capture, write && active(t, r))
			if e != nil {
				return e
			}
			if yes {
				out.Action = "retry_source"
			}
		default:
			out.State = "unknown"
			out.Action = "observe"
		}
		return nil
	})
	return out, e
}
func (s *Execution) RetryImageOccurrence(ctx context.Context, p model.Principal, project, taskID, id, imageID string) (sp.ImageOccurrenceRetryReceipt, error) {
	var out sp.ImageOccurrenceRetryReceipt
	var capture store.SessionCaptureRecord
	e := s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, t task, write bool) error {
		if e := s.admitImageRate(ctx, tx, p.UserID, "prepare"); e != nil {
			return e
		}
		d, e := resourceDAO(tx)
		if e != nil {
			return e
		}
		capture, e = d.SessionCaptureByImage(ctx, id, imageID)
		if e != nil {
			return e
		}
		yes, e := captureCanRetry(ctx, d, capture, write && active(t, r))
		if e != nil {
			return e
		}
		if !yes {
			return fault("resource_conflict", "This original occurrence is not eligible for a source retry.")
		}
		if e = requireImageHistoryLedger(ctx, tx, r, true); e != nil {
			return e
		}
		if e = onlineContent(r, s.now()); e != nil {
			return e
		}
		media, e := mediaDAO(tx)
		if e != nil {
			return e
		}
		usage, e := d.SessionResourceUsage(ctx, id)
		if e != nil {
			return e
		}
		if usage.Deleting || usage.Frozen {
			return conflict()
		}
		resource := uuid.NewString()
		capture.Receipt.AttemptID = uuid.NewString()
		capture.Receipt.State = "reserved"
		capture.Receipt.ResourceID = &resource
		capture.Receipt.Resource = nil
		capture.Receipt.Error = nil
		capture.Validated = nil
		if e = saveImageCapture(ctx, d, capture); e != nil {
			return e
		}
		// The attempt and original request share one transaction. A lost
		// response can then recover through the same durable attempt and offer.
		if e = saveMediaRequest(ctx, media, store.SessionMediaRequest{SessionID: id, RequestID: mediaIdentity(capture.Receipt.AttemptID, "retry_capture"), Action: "retry_capture", Fence: r.Snapshot.ControllerFence, Body: encode(map[string]any{"captureId": capture.Request.CaptureID, "attemptId": capture.Receipt.AttemptID})}); e != nil {
			return e
		}
		capture, e = d.SessionCapture(ctx, id, capture.Request.CaptureID)
		if e != nil {
			return e
		}
		out.Capture = capture.Receipt
		return s.syncImageBudget(ctx, tx, r)
	})
	if e != nil {
		return out, e
	}
	raw, e := s.controllerMedia(ctx, p, project, taskID, id, mediaIdentity(capture.Receipt.AttemptID, "retry_capture"), "retry_capture", map[string]any{"captureId": capture.Request.CaptureID, "attemptId": capture.Receipt.AttemptID})
	if e != nil {
		return out, e
	}
	validated, e := sp.DecodeValidatedImage(raw)
	if e != nil {
		return out, fault("resource_conflict", "The original source retry returned invalid image metadata.")
	}
	e = s.browser(ctx, p, project, taskID, id, func(tx *operationTx, r *record, _ task, _ bool) error {
		d, e := resourceDAO(tx)
		if e != nil {
			return e
		}
		current, e := d.SessionCapture(ctx, id, capture.Request.CaptureID)
		if e != nil {
			return e
		}
		if current.Receipt.AttemptID != capture.Receipt.AttemptID {
			return conflict()
		}
		if current.Receipt.State == "committed" {
			out.Capture = current.Receipt
			return nil
		}
		if current.Receipt.State != "reserved" && current.Receipt.State != "copying" {
			return conflict()
		}
		if current.Validated != nil && !jsonEqual(encode(current.Validated), encode(validated)) {
			return conflict()
		}
		current.Validated = &validated
		current.Receipt.State = "copying"
		if e = saveImageCapture(ctx, d, current); e != nil {
			return e
		}
		s.scheduleCapture(tx, r, current)
		current, e = d.SessionCapture(ctx, id, current.Request.CaptureID)
		out.Capture = current.Receipt
		return e
	})
	return out, e
}
