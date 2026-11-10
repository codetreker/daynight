package session

import (
	"context"
	"errors"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type captureFailureDAO struct {
	*imageRuleDAO
	point string
	cause error
}

func (d *captureFailureDAO) SessionCapture(ctx context.Context, s, id string) (store.SessionCaptureRecord, error) {
	if d.point == "capture" {
		return store.SessionCaptureRecord{}, d.cause
	}
	return d.imageRuleDAO.SessionCapture(ctx, s, id)
}
func (d *captureFailureDAO) SessionResourceUsage(ctx context.Context, s string) (store.SessionResourceUsage, error) {
	if d.point == "usage" {
		return store.SessionResourceUsage{}, d.cause
	}
	return d.imageRuleDAO.SessionResourceUsage(ctx, s)
}
func (d *captureFailureDAO) SaveSessionCapture(ctx context.Context, r store.SessionCaptureRecord) error {
	if d.point == "save" {
		return d.cause
	}
	return d.imageRuleDAO.SaveSessionCapture(ctx, r)
}
func (d *captureFailureDAO) SavedSessionResource(ctx context.Context, s, id string) (store.SessionResourceRecord, error) {
	if d.point == "resource" {
		return store.SessionResourceRecord{}, d.cause
	}
	return d.imageRuleDAO.SavedSessionResource(ctx, s, id)
}
func TestImageCaptureAdmissionRefusesChangedNativeScopeAndResourceCapacity(t *testing.T) {
	for _, kind := range []string{"old content", "rate", "invalid", "native locator", "native source", "frozen", "deleting", "identity capacity", "decoder missing", "volume capacity", "capture failure", "usage failure", "save failure", "alias missing", "alias unavailable", "resource failure"} {
		t.Run(kind, func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("original"))
			old := registerOccurrenceFixture(t, f)
			request := old.Request
			request.CaptureID, request.AttemptID, request.Occurrence.ImageID, request.Occurrence.SourceKey = uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			f.d.bundle.Ledger = encode(archiveLedger{HistoryID: f.d.bundle.HistoryID, HistoryEpoch: f.r.Snapshot.HistoryEpoch, SourceThrough: "0", Occurrences: []archiveLedgerOccurrence{{EntryID: request.Occurrence.EntryID, ImageID: request.Occurrence.ImageID, Container: "content"}}})
			cause := errors.New("capture storage unavailable")
			d := &captureFailureDAO{imageRuleDAO: f.d, cause: cause}
			body := encode(request)
			switch kind {
			case "old content":
				f.r.Snapshot.ContentRevision = 0
			case "rate":
				f.d.rateDeny = "prepare"
			case "invalid":
				body = []byte(`{}`)
			case "native locator":
				request.Locator = sp.ImageLocator{Kind: "native", Provider: "codex", NativeSessionID: "replacement", NativeMessageID: "message", NativePartID: "part"}
			case "native source":
				request.NativeSource = &sp.NativeImageSource{Provider: "codex", NativeSessionID: "replacement", NativeMessageID: "message", NativePartID: "part"}
			case "frozen":
				f.d.usage.Frozen = true
			case "deleting":
				f.d.usage.Deleting = true
			case "identity capacity":
				f.d.usage.UploadIdentities = sp.MaxUploadIdentities
			case "decoder missing":
				f.s.SetImageDecoder(nil)
			case "volume capacity":
				f.files.free = 0
			case "capture failure":
				d.point = "capture"
			case "usage failure":
				d.point = "usage"
			case "save failure":
				d.point = "save"
			case "alias missing":
				request.Locator = sp.ImageLocator{Kind: "resource", ResourceID: uuid.NewString()}
			case "alias unavailable":
				id := uuid.NewString()
				request.Locator = sp.ImageLocator{Kind: "resource", ResourceID: id}
				size := "8"
				f.d.resources[id] = store.SessionResourceRecord{Resource: sp.Resource{ResourceID: id, Status: "pending", ByteLength: &size}}
			case "resource failure":
				request.Locator = sp.ImageLocator{Kind: "resource", ResourceID: uuid.NewString()}
				d.point = "resource"
			}
			if kind != "invalid" {
				body = encode(request)
			}
			_, e := f.s.captureMessage(t.Context(), &operationTx{dao: d, op: &Operation{}}, f.r, sp.ControllerMessage{Action: "register", MediaBody: body})
			if e == nil {
				t.Fatal("invalid capture admitted", kind)
			}
			if d.point != "" && !errors.Is(e, cause) {
				t.Fatal("capture storage error hidden", e)
			}
			if len(f.d.captures) != 1 {
				t.Fatal("refused capture allocated a replacement occurrence")
			}
		})
	}
}
func TestImageCaptureFailuresAndQueriesKeepCurrentRevisionAndTerminalIdentity(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	c := registerOccurrenceFixture(t, f)
	tx := &operationTx{dao: f.d, op: &Operation{}}
	call := func(action string, body any) (sp.ImageCaptureReceipt, error) {
		out, e := f.s.captureMessage(t.Context(), tx, f.r, sp.ControllerMessage{Action: action, MediaBody: encode(body)})
		if e != nil {
			return sp.ImageCaptureReceipt{}, e
		}
		return out["result"].(sp.ImageCaptureReceipt), nil
	}
	failure := map[string]any{"captureId": c.Request.CaptureID, "attemptId": c.Receipt.AttemptID, "error": sp.ImageError{Code: "invalid_image", Message: "Rejected original."}}
	failed, e := call("failed", failure)
	if e != nil || failed.State != "failed" || failed.ResourceID != nil || failed.Revision != "2" {
		t.Fatal(failed, e)
	}
	replay, e := call("failed", failure)
	if e != nil || replay.Revision != failed.Revision {
		t.Fatal("identical failure changed revision", replay, e)
	}
	query, e := call("query", map[string]any{"captureId": c.Request.CaptureID})
	if e != nil || query.Revision != failed.Revision || query.State != "failed" {
		t.Fatal(query, e)
	}
	metadata := sp.ValidatedImage{MediaType: "image/png", ByteLength: "8", SHA256: imageBytesHash([]byte("original")), Width: 2, Height: 3, FrameCount: 1}
	if _, e = call("commit", sp.ImageCaptureCommit{CaptureID: c.Request.CaptureID, AttemptID: c.Receipt.AttemptID, Validated: metadata}); e == nil {
		t.Fatal("failed attempt revived")
	}
	for _, action := range []string{"query", "failed", "commit", "other"} {
		if _, e = f.s.captureMessage(t.Context(), tx, f.r, sp.ControllerMessage{Action: action, MediaBody: []byte(`{bad`)}); e == nil {
			t.Fatal("invalid capture action accepted", action)
		}
	}
	c.Validated = &metadata
	c.Receipt.State = "copying"
	c.Receipt.Error = nil
	f.d.captures[c.Request.CaptureID] = c
	if _, e = call("query", map[string]any{"captureId": c.Request.CaptureID}); e != nil {
		t.Fatal(e)
	}
	if len(tx.op.committed) != 1 {
		t.Fatal("query did not schedule original copying attempt")
	}
	if _, e = call("failed", failure); e == nil {
		t.Fatal("late failure rewound copying attempt")
	}
	changed := metadata
	changed.Width = 3
	if _, e = call("commit", sp.ImageCaptureCommit{CaptureID: c.Request.CaptureID, AttemptID: c.Receipt.AttemptID, Validated: changed}); e == nil {
		t.Fatal("changed validation metadata accepted")
	}
	c.Receipt.State = "committed"
	resource := uuid.NewString()
	media, size, digest := metadata.MediaType, metadata.ByteLength, metadata.SHA256
	width, height, frames := metadata.Width, metadata.Height, metadata.FrameCount
	c.Receipt.ResourceID = &resource
	c.Receipt.Resource = &sp.Resource{Revision: "1", ResourceID: resource, Status: "available", Name: "original.png", MediaType: &media, ByteLength: &size, SHA256: &digest, Width: &width, Height: &height, FrameCount: &frames}
	f.d.captures[c.Request.CaptureID] = c
	if _, e = call("commit", sp.ImageCaptureCommit{CaptureID: c.Request.CaptureID, AttemptID: c.Receipt.AttemptID, Validated: metadata}); e != nil {
		t.Fatal("same committed attempt could not reconcile", e)
	}
}
func TestImageCaptureCheckpointBindsCallAndMarkdownSourceRevision(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	c := registerOccurrenceFixture(t, f)
	call, part, revision, digest := "original-call", uuid.NewString(), "2", imageBytesHash([]byte("original markdown"))
	occurrence := c.Request.Occurrence
	occurrence.Container = "tool_output"
	occurrence.CallID = &call
	occurrence.PartID = &part
	occurrence.SourceRevision = &revision
	occurrence.SourceTextSHA256 = &digest
	f.d.bundle.Ledger = encode(archiveLedger{Occurrences: []archiveLedgerOccurrence{{EntryID: occurrence.EntryID, ImageID: occurrence.ImageID, Container: occurrence.Container, CallIDSHA256: archiveCallIDSHA256(&call), PartID: &part, SourceRevision: &revision, SourceTextSHA256: &digest}}})
	tx := &operationTx{dao: f.d, op: &Operation{}}
	if e := verifyImageOccurrence(t.Context(), tx, f.r, occurrence); e != nil {
		t.Fatal(e)
	}
	changed := occurrence
	other := "other-call"
	changed.CallID = &other
	if e := verifyImageOccurrence(t.Context(), tx, f.r, changed); e == nil {
		t.Fatal("different tool source reused original image")
	}
	changed = occurrence
	other = "3"
	changed.SourceRevision = &other
	if e := verifyImageOccurrence(t.Context(), tx, f.r, changed); e == nil {
		t.Fatal("different markdown revision reused original image")
	}
	f.d.bundle.Ledger = []byte(`{bad`)
	if e := verifyImageOccurrence(t.Context(), tx, f.r, occurrence); e == nil {
		t.Fatal("corrupt ledger established original occurrence")
	}
	if _, e := f.s.captureMessage(t.Context(), &operationTx{dao: &mediaRateMissingDAO{}, op: &Operation{}}, f.r, sp.ControllerMessage{}); e == nil {
		t.Fatal("old store accepted image captures")
	}
}

var _ store.SessionResourceDAO = (*captureFailureDAO)(nil)
