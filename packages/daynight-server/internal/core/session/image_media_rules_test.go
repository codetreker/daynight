package session

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type mediaFailureDAO struct {
	*imageRuleDAO
	point string
	cause error
	saved func()
}

func (d *mediaFailureDAO) SessionMediaRequest(ctx context.Context, session, id string) (store.SessionMediaRequest, error) {
	if d.point == "read" {
		return store.SessionMediaRequest{}, d.cause
	}
	return d.imageRuleDAO.SessionMediaRequest(ctx, session, id)
}
func (d *mediaFailureDAO) SaveSessionMediaRequest(ctx context.Context, row store.SessionMediaRequest) error {
	if d.point == "save" {
		return d.cause
	}
	if e := d.imageRuleDAO.SaveSessionMediaRequest(ctx, row); e != nil {
		return e
	}
	if d.saved != nil {
		d.saved()
	}
	return nil
}
func (d *mediaFailureDAO) PendingSessionMediaRequests(ctx context.Context, session string) ([]store.SessionMediaRequest, error) {
	if d.point == "pending" {
		return nil, d.cause
	}
	return d.imageRuleDAO.PendingSessionMediaRequests(ctx, session)
}
func (d *mediaFailureDAO) SessionUpload(ctx context.Context, session, id string) (store.SessionUploadRecord, error) {
	if d.point == "upload" {
		return store.SessionUploadRecord{}, d.cause
	}
	return d.imageRuleDAO.SessionUpload(ctx, session, id)
}

func TestImageMediaObservationReconcilesOriginalResultAcrossDisconnect(t *testing.T) {
	for _, kind := range []string{"success", "remote error", "readonly", "legacy", "missing capability", "read failure", "save failure", "identity action", "identity body", "identity fence", "pending offline", "pending rebind", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("original"))
			d := &mediaFailureDAO{imageRuleDAO: f.d, cause: errors.New("media transaction unavailable")}
			id, body := uuid.NewString(), map[string]any{"uploadId": uuid.NewString()}
			row := store.SessionMediaRequest{SessionID: f.r.Snapshot.SessionID, RequestID: id, Action: "status", Fence: f.r.Snapshot.ControllerFence, Body: encode(body), Complete: true, Result: []byte(`{"original":"result"}`)}
			write := true
			var dao store.SessionDAO = d
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			switch kind {
			case "success", "remote error":
				f.r.Snapshot.ConnectionState = "disconnected"
				f.r.Live = nil
				if kind == "remote error" {
					row.Result = nil
					row.Error = &sp.ImageError{Code: "source_unavailable", Message: "Original is unavailable."}
				}
			case "readonly":
				write = false
			case "legacy":
				f.r.Snapshot.ContentRevision = 0
			case "missing capability":
				dao = &mediaRateMissingDAO{}
			case "read failure":
				d.point = "read"
			case "save failure", "cancelled":
				row.RequestID = uuid.NewString()
				if kind == "save failure" {
					d.point = "save"
				} else {
					d.saved = cancel
				}
			case "identity action":
				row.Action = "release"
			case "identity body":
				row.Body = []byte(`{"uploadId":"other"}`)
			case "identity fence":
				row.Fence.ExecutionGeneration = "2"
			case "pending offline":
				row.Complete = false
				f.r.Live = nil
			case "pending rebind":
				row.Complete, row.Result = false, nil
				row.Fence.ConnectionEpoch = "0"
				f.d.respond = func(current store.SessionMediaRequest) store.SessionMediaRequest {
					current.Complete, current.Result = true, []byte(`{"original":"result"}`)
					return current
				}
			}
			f.d.media[row.RequestID] = row
			f.s.browserRun = func(ctx context.Context, _ model.Principal, _, _, _ string, _ BrowserPurpose, fn func(*Access) error) error {
				if e := ctx.Err(); e != nil {
					return e
				}
				return fn(&Access{tx: &operationTx{dao: dao, op: &Operation{}}, record: f.r, write: write})
			}
			out, e := f.s.controllerMedia(ctx, f.p, "", "", f.r.Snapshot.SessionID, id, "status", body)
			if kind == "success" || kind == "pending rebind" {
				if e != nil || string(out) != `{"original":"result"}` {
					t.Fatal("original media result not recovered", string(out), e)
				}
				if kind == "pending rebind" && f.d.media[id].Fence != f.r.Snapshot.ControllerFence {
					t.Fatal("pending original request did not adopt current connection")
				}
				return
			}
			if e == nil {
				t.Fatal("invalid media observation succeeded", string(out))
			}
			if d.point != "" && !errors.Is(e, d.cause) {
				t.Fatal("media storage failure hidden", e)
			}
			if kind == "cancelled" && (!errors.Is(e, context.Canceled) || len(f.d.media) != 2) {
				t.Fatal("cancellation did not retain original pending identity", e, f.d.media)
			}
		})
	}
}

func TestImageMediaOffersOmitReleasedUploadsAndKeepOtherOriginalRequests(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	tx := &operationTx{dao: f.d, op: &Operation{}}
	want := map[string]bool{}
	for _, state := range []string{"released", "expired", "failed", "receiving", "complete"} {
		upload := uuid.NewString()
		f.d.uploads[upload] = store.SessionUploadRecord{SessionID: f.r.Snapshot.SessionID, Receipt: sp.ImageUploadReceipt{State: state}}
		for _, action := range []string{"write", "complete"} {
			id := uuid.NewString()
			f.d.media[id] = store.SessionMediaRequest{SessionID: f.r.Snapshot.SessionID, RequestID: id, Action: action, Fence: f.r.Snapshot.ControllerFence, Body: encode(map[string]any{"uploadId": upload})}
			if state == "receiving" || state == "complete" {
				want[id] = true
			}
		}
	}
	stale := store.SessionMediaRequest{SessionID: f.r.Snapshot.SessionID, RequestID: uuid.NewString(), Action: "status", Fence: f.r.Snapshot.ControllerFence, Body: []byte(`{}`)}
	stale.Fence.ExecutionGeneration = "2"
	f.d.media[stale.RequestID] = stale
	offers, e := f.s.mediaOffers(t.Context(), tx, f.r)
	if e != nil || len(offers) != len(want) {
		t.Fatal("media offer closure changed", offers, e)
	}
	for _, offer := range offers {
		if !want[offer["requestId"].(string)] {
			t.Fatal("released or stale request was reoffered", offer)
		}
	}
	for _, point := range []string{"pending", "upload", "save"} {
		d := &mediaFailureDAO{imageRuleDAO: f.d, point: point, cause: errors.New("media offer transaction unavailable")}
		if point == "save" {
			f.r.Snapshot.ConnectionEpoch = "2"
		}
		if _, e = f.s.mediaOffers(t.Context(), &operationTx{dao: d}, f.r); !errors.Is(e, d.cause) {
			t.Fatal("media offer storage failure hidden", point, e)
		}
	}
	f.r.Snapshot.ContentRevision = 0
	if offers, e = f.s.mediaOffers(t.Context(), tx, f.r); e != nil || len(offers) != 0 {
		t.Fatal("legacy session received image offers", offers, e)
	}
}

func TestImageMediaResponsesRetainUnknownIdentityAndStorageFailures(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	d := &mediaFailureDAO{imageRuleDAO: f.d, cause: errors.New("media response transaction unavailable")}
	tx := &operationTx{dao: d}
	m := sp.ControllerMessage{ControllerFence: f.r.Snapshot.ControllerFence, RequestID: uuid.NewString(), Action: "read", MediaError: &sp.ImageError{Code: "source_unavailable", Message: "Original unavailable."}}
	if _, e := f.s.acceptMediaResponse(t.Context(), tx, f.r, m); e != nil || len(f.d.media) != 0 {
		t.Fatal("unknown response created an identity", e)
	}
	f.d.media[m.RequestID] = store.SessionMediaRequest{SessionID: f.r.Snapshot.SessionID, RequestID: m.RequestID, Action: m.Action, Fence: m.ControllerFence, Body: []byte(`{}`)}
	for _, point := range []string{"read", "save"} {
		d.point = point
		if _, e := f.s.acceptMediaResponse(t.Context(), tx, f.r, m); !errors.Is(e, d.cause) || f.d.media[m.RequestID].Complete {
			t.Fatal("failed response transaction established completion", point, e)
		}
	}
	d.point = ""
	if _, e := f.s.acceptMediaResponse(t.Context(), tx, f.r, m); e != nil || !f.d.media[m.RequestID].Complete || f.d.media[m.RequestID].Error == nil {
		t.Fatal("terminal remote error was not retained", e)
	}
}
