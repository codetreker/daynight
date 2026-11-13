package session

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func registerOccurrenceFixture(t *testing.T, f imageRuleFixture) store.SessionCaptureRecord {
	t.Helper()
	request := sp.ImageCaptureRequest{CaptureID: uuid.NewString(), AttemptID: uuid.NewString(), Occurrence: sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "content", SourceKey: uuid.NewString()}, Locator: sp.ImageLocator{Kind: "external", URL: "https://images.example/original.png"}}
	f.d.bundle.Ledger = encode(archiveLedger{HistoryID: f.d.bundle.HistoryID, HistoryEpoch: f.r.Snapshot.HistoryEpoch, SourceThrough: "0", Occurrences: []archiveLedgerOccurrence{{EntryID: request.Occurrence.EntryID, ImageID: request.Occurrence.ImageID, Container: "content"}}})
	_, e := f.s.captureMessage(t.Context(), &operationTx{dao: f.d, op: &Operation{}}, f.r, sp.ControllerMessage{Action: "register", MediaBody: encode(request)})
	if e != nil {
		t.Fatal(e)
	}
	return f.d.captures[request.CaptureID]
}
func failOccurrenceFixture(f imageRuleFixture, c store.SessionCaptureRecord, code string) store.SessionCaptureRecord {
	c.Receipt.State, c.Receipt.ResourceID, c.Receipt.Error = "failed", nil, &sp.ImageError{Code: code, Message: "Original source failed."}
	f.d.captures[c.Request.CaptureID] = c
	return c
}
func TestImageOccurrenceRetryEligibilityRetainsUncertainAndSavedResults(t *testing.T) {
	for _, tc := range []struct {
		name, kind, code, state, lifecycle string
		staging                            bool
		want                               string
	}{
		{name: "trusted external", kind: "external", code: "invalid_image", state: "failed", want: "retry_source"},
		{name: "trusted local", kind: "local", code: "image_decode_failed", state: "failed", want: "retry_source"},
		{name: "decode", kind: "external", code: "decode_failed", state: "failed", want: "retry_source"},
		{name: "quota", kind: "external", code: "quota_exceeded", state: "failed", want: "retry_source"},
		{name: "storage", kind: "external", code: "storage_unavailable", state: "failed", want: "retry_source"},
		{name: "media type", kind: "external", code: "unsupported_media_type", state: "failed", want: "retry_source"},
		{name: "source_not_found", kind: "external", code: "source_not_found", state: "failed", want: "retry_source"},
		{name: "source_timeout", kind: "external", code: "source_timeout", state: "failed", want: "retry_source"},
		{name: "source_changed", kind: "external", code: "source_changed", state: "failed", want: "retry_source"},
		{name: "source_busy", kind: "external", code: "source_busy", state: "failed", want: "retry_source"},
		{name: "source_rate_limited", kind: "external", code: "source_rate_limited", state: "failed", want: "retry_source"},
		{name: "source_capacity", kind: "external", code: "source_capacity", state: "failed", want: "retry_source"},
		{name: "source_queue_timeout", kind: "external", code: "source_queue_timeout", state: "failed", want: "retry_source"},
		{name: "source_unavailable", kind: "local", code: "source_unavailable", state: "failed", want: "none"},
		{name: "source_forbidden", kind: "local", code: "source_forbidden", state: "failed", want: "none"},
		{name: "permission_denied", kind: "local", code: "permission_denied", state: "failed", want: "none"},
		{name: "policy_restricted", kind: "local", code: "policy_restricted", state: "failed", want: "none"},
		{name: "unknown", kind: "external", code: "media_outcome_unknown", state: "failed", want: "none"},
		{name: "native", kind: "native", code: "invalid_image", state: "failed", want: "none"},
		{name: "data", kind: "data", code: "invalid_image", state: "failed", want: "none"},
		{name: "stopped", kind: "external", code: "invalid_image", state: "failed", lifecycle: "archived", want: "none"},
		{name: "staging retained", kind: "external", code: "invalid_image", state: "failed", staging: true, want: "none"},
		{name: "pending", kind: "external", state: "reserved", want: "observe"},
		{name: "saved", kind: "external", state: "committed", lifecycle: "archived", want: "read_saved"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("original"))
			c := registerOccurrenceFixture(t, f)
			c.Request.Locator.Kind = tc.kind
			if tc.state == "failed" {
				c = failOccurrenceFixture(f, c, tc.code)
			} else {
				c.Receipt.State = tc.state
			}
			if tc.state == "committed" {
				c.Receipt.Resource = &sp.Resource{ResourceID: *c.Receipt.ResourceID, Status: "available"}
			}
			if tc.staging {
				f.d.uploads[c.Receipt.AttemptID] = store.SessionUploadRecord{SessionID: f.r.Snapshot.SessionID, Receipt: sp.ImageUploadReceipt{State: "failed"}}
			}
			if tc.lifecycle != "" {
				f.r.Snapshot.Lifecycle = tc.lifecycle
			}
			f.d.captures[c.Request.CaptureID] = c
			f.d.rateCalls = nil
			got, e := f.s.GetImageOccurrence(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, c.Request.Occurrence.ImageID)
			if e != nil || got.Action != tc.want || got.Revision != "1" {
				t.Fatal(got, e)
			}
			if len(f.d.media) != 0 || !reflect.DeepEqual(f.d.rateCalls, []string{"observe"}) {
				t.Fatal("status created source work or charged twice", f.d.media, f.d.rateCalls)
			}
			if tc.want != "retry_source" {
				if _, e = f.s.RetryImageOccurrence(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, c.Request.Occurrence.ImageID); e == nil {
					t.Fatal("ineligible retry accepted")
				}
			}
		})
	}
	f := newImageRuleFixture(t, []byte("original"))
	got, e := f.s.GetImageOccurrence(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, uuid.NewString())
	if e != nil || got.State != "unregistered" || got.Action != "none" {
		t.Fatal(got, e)
	}
}
func TestImageOccurrenceRetryUsesNewAttemptAndRejectsLateOriginalResults(t *testing.T) {
	raw := []byte("original")
	f := newImageRuleFixture(t, raw)
	c := failOccurrenceFixture(f, registerOccurrenceFixture(t, f), "invalid_image")
	original := c.Request
	previous := c.Receipt.AttemptID
	f.d.uploads[previous] = store.SessionUploadRecord{SessionID: f.r.Snapshot.SessionID, Spec: sp.ImageUploadSpec{UploadID: previous, ImageID: c.Request.Occurrence.ImageID}, StorageReleased: true, Receipt: sp.ImageUploadReceipt{State: "failed"}}
	validated := sp.ValidatedImage{MediaType: "image/png", ByteLength: decimal(int64(len(raw))), SHA256: imageBytesHash(raw), Width: 2, Height: 3, FrameCount: 1}
	f.d.respond = func(row store.SessionMediaRequest) store.SessionMediaRequest {
		row.Complete = true
		if row.Action == "retry_capture" {
			row.Result = encode(validated)
			return row
		}
		if row.Action != "read_capture" {
			t.Fatal("unexpected source RPC", row.Action)
		}
		var body struct{ CaptureID, AttemptID string }
		if json.Unmarshal(row.Body, &body) != nil || body.CaptureID != original.CaptureID || body.AttemptID == previous {
			t.Fatal("source identity changed", string(row.Body))
		}
		row.Result = encode(sp.PreparedImageChunk{PreparationID: body.AttemptID, ByteLength: validated.ByteLength, SHA256: validated.SHA256, Offset: "0", Data: base64.StdEncoding.EncodeToString(raw), EOF: true})
		return row
	}
	f.d.rateCalls = nil
	out, e := f.s.RetryImageOccurrence(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, original.Occurrence.ImageID)
	if e != nil || out.Capture.State != "copying" || out.Capture.AttemptID == previous || out.Capture.Revision != "3" {
		t.Fatal(out, e)
	}
	if !reflect.DeepEqual(f.d.rateCalls, []string{"control", "prepare"}) {
		t.Fatal("retry charged per poll", f.d.rateCalls)
	}
	current := f.d.captures[original.CaptureID]
	if !reflect.DeepEqual(current.Request, original) {
		t.Fatal("retry replaced original locator", current.Request)
	}
	for _, msg := range []sp.ControllerMessage{
		{Action: "commit", MediaBody: encode(sp.ImageCaptureCommit{CaptureID: original.CaptureID, AttemptID: previous, Validated: validated})},
		{Action: "failed", MediaBody: encode(map[string]any{"captureId": original.CaptureID, "attemptId": previous, "error": sp.ImageError{Code: "invalid_image", Message: "Late original failure."}})},
	} {
		if _, e = f.s.captureMessage(t.Context(), &operationTx{dao: f.d, op: &Operation{}}, f.r, msg); e == nil {
			t.Fatal("old attempt changed current receipt")
		}
	}
	replay, e := f.s.captureMessage(t.Context(), &operationTx{dao: f.d, op: &Operation{}}, f.r, sp.ControllerMessage{Action: "register", MediaBody: encode(original)})
	if e != nil || replay["result"].(sp.ImageCaptureReceipt).AttemptID != current.Receipt.AttemptID {
		t.Fatal("original register did not reconcile current attempt", replay, e)
	}
	if e = f.s.copyCapture(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, current); e != nil {
		t.Fatal(e)
	}
	if f.d.captures[original.CaptureID].Receipt.State != "committed" || len(f.d.uploads) != 2 || !f.d.uploads[previous].StorageReleased {
		t.Fatal("retry reused staging or lost prior attempt")
	}
	got, e := f.s.GetImageOccurrence(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, original.Occurrence.ImageID)
	if e != nil || got.Action != "read_saved" || got.ResourceID == nil {
		t.Fatal(got, e)
	}
}
func TestImageOccurrenceStatusReconcilesOnlyDurableOriginalRetry(t *testing.T) {
	for _, result := range []string{"pending", "success", "failure", "malformed"} {
		t.Run(result, func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("image"))
			c := registerOccurrenceFixture(t, f)
			c.Receipt.AttemptID = uuid.NewString()
			f.d.captures[c.Request.CaptureID] = c
			row := store.SessionMediaRequest{SessionID: c.SessionID, RequestID: mediaIdentity(c.Receipt.AttemptID, "retry_capture"), Action: "retry_capture", Complete: result != "pending"}
			row.Result = encode(sp.ValidatedImage{MediaType: "image/png", ByteLength: "5", SHA256: imageBytesHash([]byte("image")), Width: 2, Height: 3, FrameCount: 1})
			if result == "failure" {
				row.Error = &sp.ImageError{Code: "component_unsupported", Message: "No original source resolver."}
				row.Result = nil
			}
			if result == "malformed" {
				row.Result = []byte(`{}`)
			}
			f.d.media[row.RequestID] = row
			got, e := f.s.GetImageOccurrence(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, c.Request.Occurrence.ImageID)
			if result == "malformed" {
				if e == nil {
					t.Fatal("malformed original result accepted")
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			if result == "failure" {
				if got.State != "failed" || got.Error == nil || got.Action != "none" {
					t.Fatal(got)
				}
			} else if got.State != "pending" || got.Action != "observe" {
				t.Fatal(got)
			}
			if result == "success" && f.d.captures[c.Request.CaptureID].Receipt.State != "copying" {
				t.Fatal("completed retry not resumed")
			}
			if len(f.d.media) != 1 {
				t.Fatal("status created a replacement request")
			}
		})
	}
}
func TestImageCaptureRejectsUncheckpointedPositionAndOccupiedAttempt(t *testing.T) {
	f := newImageRuleFixture(t, []byte("image"))
	c := registerOccurrenceFixture(t, f)
	changed := c.Request
	changed.CaptureID = uuid.NewString()
	changed.AttemptID = uuid.NewString()
	changed.Occurrence.ImageID = uuid.NewString()
	for _, occupied := range []bool{false, true} {
		if occupied {
			f.d.uploads[changed.AttemptID] = store.SessionUploadRecord{SessionID: c.SessionID}
		}
		_, e := f.s.captureMessage(t.Context(), &operationTx{dao: f.d, op: &Operation{}}, f.r, sp.ControllerMessage{Action: "register", MediaBody: encode(changed)})
		var refusal *CaptureRequestError
		if !errors.As(e, &refusal) || refusal.Code != "resource_conflict" {
			t.Fatal("untrusted registration accepted", e)
		}
	}
}

func TestImageOccurrenceRetryCancellationRetainsAtomicOriginalOffer(t *testing.T) {
	raw := []byte("original")
	f := newImageRuleFixture(t, raw)
	c := failOccurrenceFixture(f, registerOccurrenceFixture(t, f), "invalid_image")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	originalBrowser := f.s.browserRun
	calls := 0
	f.s.browserRun = func(ctx context.Context, p model.Principal, project, task, id string, purpose BrowserPurpose, work func(*Access) error) error {
		calls++
		e := originalBrowser(ctx, p, project, task, id, purpose, work)
		if calls == 1 && e == nil {
			current := f.d.captures[c.Request.CaptureID]
			row, ok := f.d.media[mediaIdentity(current.Receipt.AttemptID, "retry_capture")]
			if !ok || row.Complete || row.Fence != f.r.Snapshot.ControllerFence {
				t.Fatal("reservation committed without original durable media request", row)
			}
			cancel()
		}
		return e
	}
	out, e := f.s.RetryImageOccurrence(ctx, f.p, "", "", f.r.Snapshot.SessionID, c.Request.Occurrence.ImageID)
	if !errors.Is(e, context.Canceled) || out.Capture.State != "reserved" || out.Capture.AttemptID == c.Receipt.AttemptID {
		t.Fatal(out, e)
	}
	current := f.d.captures[c.Request.CaptureID]
	f.s.browserRun = originalBrowser
	status, e := f.s.GetImageOccurrence(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, c.Request.Occurrence.ImageID)
	if e != nil || status.State != "pending" || status.Action != "observe" || len(f.d.media) != 1 {
		t.Fatal(status, e)
	}
	offers, e := f.s.mediaOffers(t.Context(), &operationTx{dao: f.d, op: &Operation{}}, f.r)
	if e != nil || len(offers) != 1 || offers[0]["requestId"] != mediaIdentity(current.Receipt.AttemptID, "retry_capture") {
		t.Fatal("cancelled caller lost original retry offer", offers, e)
	}
	requestID := mediaIdentity(current.Receipt.AttemptID, "retry_capture")
	row := f.d.media[requestID]
	row.Complete = true
	row.Result = encode(sp.ValidatedImage{MediaType: "image/png", ByteLength: decimal(int64(len(raw))), SHA256: imageBytesHash(raw), Width: 2, Height: 3, FrameCount: 1})
	f.d.media[requestID] = row
	if _, e = f.s.GetImageOccurrence(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, c.Request.Occurrence.ImageID); e != nil {
		t.Fatal(e)
	}
	resumed := f.d.captures[c.Request.CaptureID]
	if resumed.Receipt.State != "copying" || resumed.Receipt.AttemptID != current.Receipt.AttemptID || len(f.d.media) != 1 {
		t.Fatal("original outcome created another attempt", resumed)
	}
}

func TestImageMediaCapacityRefusalReoffersOriginalWithoutTerminalizing(t *testing.T) {
	f := newImageRuleFixture(t, []byte("image"))
	tx := &operationTx{dao: f.d, op: &Operation{}}
	for _, action := range []string{"prepare", "complete", "release", "retry_capture"} {
		id := uuid.NewString()
		original := store.SessionMediaRequest{SessionID: f.r.Snapshot.SessionID, RequestID: id, Action: action, Fence: f.r.Snapshot.ControllerFence, Body: []byte(`{}`)}
		f.d.media = map[string]store.SessionMediaRequest{id: original}
		response := sp.ControllerMessage{ControllerFence: original.Fence, RequestID: id, Action: action, MediaError: &sp.ImageError{Code: "rate_limited", Message: "Controller capacity is unavailable."}}
		if _, e := f.s.acceptMediaResponse(t.Context(), tx, f.r, response); e != nil {
			t.Fatal(e)
		}
		current := f.d.media[id]
		if current.Complete || current.Error != nil || !reflect.DeepEqual(current, original) {
			t.Fatal("temporary capacity refusal terminalized original request", current)
		}
		offers, e := f.s.mediaOffers(t.Context(), tx, f.r)
		if e != nil || len(offers) != 1 || offers[0]["requestId"] != id || offers[0]["action"] != action {
			t.Fatal("original request not reoffered", offers, e)
		}
		response.MediaError = nil
		response.MediaResult = []byte(`{"original":"result"}`)
		if _, e = f.s.acceptMediaResponse(t.Context(), tx, f.r, response); e != nil {
			t.Fatal(e)
		}
		response.MediaError = &sp.ImageError{Code: "rate_limited", Message: "Late admission refusal."}
		response.MediaResult = nil
		if _, e = f.s.acceptMediaResponse(t.Context(), tx, f.r, response); e != nil {
			t.Fatal(e)
		}
		current = f.d.media[id]
		if !current.Complete || current.Error != nil || string(current.Result) != `{"original":"result"}` {
			t.Fatal("late capacity refusal replaced completion", current)
		}
	}
}

func TestImageCapabilityObservationHasIndependentRateAndStableRevisions(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	tx := &operationTx{dao: f.d, op: &Operation{}}
	reason := "profile_disabled"
	provider := &sp.ProviderImageCapabilities{Revision: "2", ReasonCode: &reason}
	if e := f.s.refreshImageState(t.Context(), tx, f.r, provider); e != nil {
		t.Fatal(e)
	}
	revision := f.r.Snapshot.Capabilities.Images.Revision
	f.d.rateCalls = nil
	f.d.rateDeny = "prepare"
	result, e := f.s.ImageCapabilities(t.Context(), f.p, "", "", f.r.Snapshot.SessionID)
	if e != nil || result["contentRevision"] != 2 || f.r.Snapshot.Capabilities.Images.Revision != revision || !reflect.DeepEqual(f.d.rateCalls, []string{"observe"}) {
		t.Fatal("capability query changed identity or used input bucket", result, f.d.rateCalls, e)
	}
	if e = f.s.refreshImageState(t.Context(), tx, f.r, provider); e != nil || f.r.Snapshot.Capabilities.Images.Revision != revision {
		t.Fatal("same provider state changed capability revision", e)
	}
	modelID := "different"
	provider.ModelID = &modelID
	if e = f.s.refreshImageState(t.Context(), tx, f.r, provider); e != nil || f.r.Snapshot.Capabilities.Images.Revision == revision {
		t.Fatal("provider identity change retained stale capability revision", e)
	}
	f.d.rateDeny = "observe"
	if _, e = f.s.ImageCapabilities(t.Context(), f.p, "", "", f.r.Snapshot.SessionID); e == nil {
		t.Fatal("exhausted observation bucket ignored")
	}
	f.d.rateDeny = ""
	f.r.Snapshot.ContentRevision = 0
	if _, e = f.s.ImageCapabilities(t.Context(), f.p, "", "", f.r.Snapshot.SessionID); e == nil {
		t.Fatal("old controller advertised images")
	}
}
