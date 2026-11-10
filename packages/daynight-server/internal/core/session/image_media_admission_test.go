package session

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type boundedMediaDAO struct {
	*imageRuleDAO
	events                     chan store.SessionMediaRequest
	peak                       int
	acquireError, releaseError error
}

func (d *boundedMediaDAO) AcquireSessionResourceLease(ctx context.Context, lease store.SessionResourceLease) error {
	if d.acquireError != nil {
		return d.acquireError
	}
	if len(d.leases) >= lease.Admission.Session {
		return fault("rate_limited", "Media transfer capacity is unavailable.")
	}
	if err := d.imageRuleDAO.AcquireSessionResourceLease(ctx, lease); err != nil {
		return err
	}
	d.peak = max(d.peak, len(d.leases))
	return nil
}
func (d *boundedMediaDAO) ReleaseSessionResourceLease(ctx context.Context, session, lease string) error {
	if d.releaseError != nil {
		err := d.releaseError
		d.releaseError = nil
		return err
	}
	return d.imageRuleDAO.ReleaseSessionResourceLease(ctx, session, lease)
}
func (d *boundedMediaDAO) SaveSessionMediaRequest(ctx context.Context, row store.SessionMediaRequest) error {
	_, exists := d.media[row.RequestID]
	if err := d.imageRuleDAO.SaveSessionMediaRequest(ctx, row); err != nil {
		return err
	}
	if !exists && !row.Complete && d.events != nil {
		d.events <- row
	}
	return nil
}
func (d *boundedMediaDAO) AcceptedSessionOperations(context.Context, string) ([]string, error) {
	return nil, nil
}
func (d *boundedMediaDAO) TouchSession(context.Context, string, time.Time) error { return nil }

type leaseCheckedMediaStorage struct {
	*imageRuleStorage
	check func() error
}

func (s leaseCheckedMediaStorage) Open(ctx context.Context, bucket, path string) (filestorage.Object, error) {
	if err := s.check(); err != nil {
		return filestorage.Object{}, err
	}
	return s.imageRuleStorage.Open(ctx, bucket, path)
}
func (s leaseCheckedMediaStorage) Put(ctx context.Context, bucket, path string, body io.Reader) (filestorage.FileInfo, error) {
	if err := s.check(); err != nil {
		return filestorage.FileInfo{}, err
	}
	return s.imageRuleStorage.Put(ctx, bucket, path, body)
}

func boundedMediaRelay(t *testing.T, f imageRuleFixture) (*Execution, *boundedMediaDAO, *sync.Mutex) {
	t.Helper()
	mu := &sync.Mutex{}
	d := &boundedMediaDAO{imageRuleDAO: f.d, events: make(chan store.SessionMediaRequest, 16)}
	files := leaseCheckedMediaStorage{imageRuleStorage: f.files, check: func() error {
		mu.Lock()
		defer mu.Unlock()
		if len(d.leases) == 0 || len(d.leases) > 2 {
			return errors.New("file I/O without bounded durable lease protection")
		}
		return nil
	}}
	f.s.files = files
	relay := &Execution{Engine: NewEngine(files)}
	run := func(ctx context.Context, work func(*Access) error) error {
		mu.Lock()
		defer mu.Unlock()
		if err := ctx.Err(); err != nil {
			return err
		}
		op := &Operation{}
		defer op.Close()
		err := work(&Access{tx: &operationTx{dao: d, op: op}, record: f.r, write: true})
		if err == nil {
			op.Finish(store.TransactionCommitted)
		}
		return err
	}
	f.s.browserRun = func(ctx context.Context, actor model.Principal, _, _, id string, _ BrowserPurpose, work func(*Access) error) error {
		if actor != f.p || id != f.r.Snapshot.SessionID {
			return denied()
		}
		return run(ctx, work)
	}
	controller := func(ctx context.Context, fence sp.ControllerFence, work func(*Access) error) error {
		if fence != f.r.Snapshot.ControllerFence {
			return conflict()
		}
		return run(ctx, work)
	}
	f.s.controllerRun, relay.controllerRun = controller, controller
	for _, engine := range []*Engine{f.s.Engine, relay.Engine} {
		engine.SetMediaLeaseCleanup(func(ctx context.Context, id, lease string) error {
			mu.Lock()
			defer mu.Unlock()
			return d.ReleaseSessionResourceLease(ctx, id, lease)
		})
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := engine.Stop(ctx); err != nil {
				t.Error(err)
			}
		})
	}
	return relay, d, mu
}

func TestConcurrentUploadCompletionsLeaveRelayTransferCapacity(t *testing.T) {
	raw := []byte("two independently completed originals")
	f := newImageRuleFixture(t, raw)
	// The barriers require independent upload gates. Random identities can share
	// a storage stripe, legitimately serializing completion before remote prepare.
	f.r.Snapshot.SessionID = "10000000-0000-4000-8000-000000000001"
	f.spec.Target.Fence = f.r.Snapshot.Fence
	f.d.bundle.SessionID = f.r.Snapshot.SessionID
	f.spec.UploadID = "20000000-0000-4000-8000-000000000001"
	f.prepare(t)
	if _, err := f.write(t, raw, 0); err != nil {
		t.Fatal(err)
	}
	other := f
	other.spec.UploadID, other.spec.ImageID = "20000000-0000-4000-8000-000000000002", uuid.NewString()
	other.prepare(t)
	if _, err := other.write(t, raw, 0); err != nil {
		t.Fatal(err)
	}
	relay, d, mu := boundedMediaRelay(t, f)
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	func() {
		for _, upload := range []string{f.spec.UploadID, other.spec.UploadID} {
			gate, err := f.files.AcquireGate(ctx, filestorage.PrivateGate, "session-image-upload/"+f.r.Snapshot.SessionID+"/"+upload)
			if err != nil {
				t.Fatalf("concurrency fixture requires independent upload gates: %v", err)
			}
			defer func() {
				if err := gate.Close(); err != nil {
					t.Error(err)
				}
			}()
		}
	}()
	done := make(chan error, 2)
	for _, spec := range []sp.ImageUploadSpec{f.spec, other.spec} {
		go func() {
			receipt, err := f.s.CompleteUpload(ctx, f.p, "", "", f.r.Snapshot.SessionID, spec.UploadID, sp.ImageUploadComplete{SHA256: spec.SHA256, ByteLength: spec.ByteLength})
			if err == nil && (receipt.State != "complete" || receipt.Resource == nil) {
				err = errors.New("completion did not publish its original")
			}
			done <- err
		}()
	}
	// Each barrier observes both durable requests before either remote response.
	// The old completion held both transfer slots at the write barrier.
	for _, action := range []string{"prepare", "write", "complete"} {
		for range 2 {
			select {
			case row := <-d.events:
				if row.Action != action {
					t.Fatalf("expected %s barrier, got %s", action, row.Action)
				}
			case err := <-done:
				t.Fatalf("completion ended before %s barrier: %v", action, err)
			case <-ctx.Done():
				t.Fatalf("both completions did not reach %s: %v", action, ctx.Err())
			}
		}
		offers, err := relay.Poll(ctx, f.r.Snapshot.ControllerFence)
		if err != nil || len(offers) != 2 {
			t.Fatalf("two admitted completions could not advance %s through relay: offers=%d err=%v", action, len(offers), err)
		}
		for _, offer := range offers {
			var body struct {
				UploadID string `json:"uploadId"`
				Data     string `json:"data"`
			}
			if err := json.Unmarshal(offer["body"].(json.RawMessage), &body); err != nil {
				t.Fatal(err)
			}
			spec := f.spec
			if body.UploadID == other.spec.UploadID {
				spec = other.spec
			}
			if body.UploadID != spec.UploadID {
				t.Fatal("offer changed upload identity")
			}
			if action == "write" && body.Data != base64.StdEncoding.EncodeToString(raw) {
				t.Fatal("relay changed original chunk bytes")
			}
			response := sp.LocalImagePreparation{UploadID: spec.UploadID, ImageID: spec.ImageID, Target: spec.Target, State: "receiving", AcceptedOffset: "0"}
			switch action {
			case "write":
				response.AcceptedOffset = spec.ByteLength
			case "complete":
				response.State, response.AcceptedOffset = "validated", spec.ByteLength
				response.Validated = &sp.ValidatedImage{MediaType: "image/png", ByteLength: spec.ByteLength, SHA256: spec.SHA256, Width: 2, Height: 3, FrameCount: 1}
			}
			if _, err := relay.Handle(ctx, sp.ControllerMessage{Type: "image_response", ControllerFence: f.r.Snapshot.ControllerFence, RequestID: offer["requestId"].(string), Action: action, MediaResult: encode(response)}); err != nil {
				t.Fatal(err)
			}
		}
	}
	for range 2 {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal("completions did not exit", ctx.Err())
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if d.peak > 2 || len(d.leases) != 0 || len(d.resources) != 2 {
		t.Fatal("completion exceeded capacity, leaked leases or lost originals", d.peak, len(d.leases), len(d.resources))
	}
	for _, row := range d.media {
		if !row.Complete || bytes.Contains(row.Body, []byte(`"data"`)) {
			t.Fatal("completion lost a request or persisted original bytes")
		}
	}
}

func TestMediaOfferDeferralPreservesIndependentFailures(t *testing.T) {
	for _, kind := range []string{"wrapped capacity", "storage failure", "quota refusal", "capacity and cleanup failure"} {
		t.Run(kind, func(t *testing.T) {
			raw := []byte("pending immutable original")
			f := newImageRuleFixture(t, raw)
			f.prepare(t)
			if _, err := f.write(t, raw, 0); err != nil {
				t.Fatal(err)
			}
			wire := encode(sp.ImageChunkWrite{UploadID: f.spec.UploadID, Offset: "0", SHA256: imageBytesHash(raw), Data: base64.StdEncoding.EncodeToString(raw)})
			body, _, err := compactMediaPayload(wire, true)
			if err != nil {
				t.Fatal(err)
			}
			row := store.SessionMediaRequest{SessionID: f.r.Snapshot.SessionID, RequestID: mediaIdentity(f.spec.UploadID, "write/0"), Action: "write", Fence: f.r.Snapshot.ControllerFence, Body: body}
			f.d.media[row.RequestID] = row
			relay, d, _ := boundedMediaRelay(t, f)
			cause := errors.New("independent persistence failure")
			switch kind {
			case "wrapped capacity":
				d.acquireError = fmt.Errorf("admission: %w", fault("rate_limited", "Transfer capacity is unavailable."))
			case "storage failure":
				d.acquireError = cause
			case "quota refusal":
				cause = fault("quota_exceeded", "Original exceeds its reservation.")
				d.acquireError = cause
			case "capacity and cleanup failure":
				d.acquireError = fault("rate_limited", "Transfer capacity is unavailable.")
				d.releaseError = cause
			}
			offers, err := relay.Poll(t.Context(), row.Fence)
			if kind == "wrapped capacity" {
				if err != nil || len(offers) != 0 {
					t.Fatal("ordinary wrapped capacity was not deferred", offers, err)
				}
			} else if !errors.Is(err, cause) {
				t.Fatal("offer deferral suppressed an independent failure", err)
			}
			if saved := d.media[row.RequestID]; saved.Complete || !bytes.Equal(saved.Body, row.Body) {
				t.Fatal("failed offer changed original outcome")
			}
		})
	}
}

func TestRemoteCompletionReacquiresOnlyUnchangedOriginal(t *testing.T) {
	for _, kind := range []string{"actor", "blob", "spec", "receipt", "expiry", "storage released", "fence", "delete epoch", "deleting", "frozen", "admission failure"} {
		t.Run(kind, func(t *testing.T) {
			raw := []byte("original before remote validation")
			f := newImageRuleFixture(t, raw)
			f.prepare(t)
			if _, err := f.write(t, raw, 0); err != nil {
				t.Fatal(err)
			}
			_, d, mu := boundedMediaRelay(t, f)
			changed := false
			d.respond = func(row store.SessionMediaRequest) store.SessionMediaRequest {
				row.Complete = true
				response := sp.LocalImagePreparation{UploadID: f.spec.UploadID, ImageID: f.spec.ImageID, Target: f.spec.Target, State: "receiving", AcceptedOffset: "0"}
				if row.Action == "complete" {
					response.State, response.AcceptedOffset = "validated", f.spec.ByteLength
					response.Validated = &sp.ValidatedImage{MediaType: "image/png", ByteLength: f.spec.ByteLength, SHA256: f.spec.SHA256, Width: 2, Height: 3, FrameCount: 1}
					current := d.uploads[f.spec.UploadID]
					switch kind {
					case "actor":
						current.ActorID = uuid.NewString()
					case "blob":
						current.BlobID = uuid.NewString()
					case "spec":
						current.Spec.Name = "changed original.png"
					case "receipt":
						current.Receipt.State = "released"
					case "expiry":
						current.ExpiresAt = current.ExpiresAt.Add(time.Minute)
					case "storage released":
						current.StorageReleased = true
					case "fence":
						f.r.Snapshot.ExecutionGeneration = "2"
					case "delete epoch":
						d.usage.DeleteEpoch++
					case "deleting":
						d.usage.Deleting = true
					case "frozen":
						d.usage.Frozen = true
					case "admission failure":
						d.acquireError = errors.New("lease commit outcome unknown")
					}
					d.uploads[f.spec.UploadID] = current
					changed = true
				}
				row.Result = encode(response)
				return row
			}
			ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
			defer cancel()
			_, err := f.s.CompleteUpload(ctx, f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID, sp.ImageUploadComplete{SHA256: f.spec.SHA256, ByteLength: f.spec.ByteLength})
			mu.Lock()
			defer mu.Unlock()
			if !changed || err == nil || len(d.resources) != 0 || len(d.leases) != 0 {
				t.Fatal("changed or unconfirmed original reached local publication", changed, err, len(d.resources), len(d.leases))
			}
		})
	}
}

func TestRemoteCompletionDoesNotProceedAfterUnconfirmedLeaseRelease(t *testing.T) {
	raw := []byte("original before uncertain release")
	f := newImageRuleFixture(t, raw)
	f.prepare(t)
	if _, err := f.write(t, raw, 0); err != nil {
		t.Fatal(err)
	}
	_, d, mu := boundedMediaRelay(t, f)
	cause := &store.TransactionError{Outcome: store.TransactionUnknown, Phase: "commit", Cause: errors.New("release acknowledgment lost")}
	d.releaseError = cause
	_, err := f.s.CompleteUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID, sp.ImageUploadComplete{SHA256: f.spec.SHA256, ByteLength: f.spec.ByteLength})
	mu.Lock()
	defer mu.Unlock()
	if !errors.Is(err, cause) || len(d.media) != 0 || len(d.resources) != 0 || d.uploads[f.spec.UploadID].Receipt.State != "verifying" {
		t.Fatal("unconfirmed release started remote work or settled original", err)
	}
}

func TestMediaSaturationDefersOnlyWriteOfferAndPreservesTextPoll(t *testing.T) {
	raw := []byte("pending immutable original")
	f := newImageRuleFixture(t, raw)
	f.prepare(t)
	if _, err := f.write(t, raw, 0); err != nil {
		t.Fatal(err)
	}
	wire := encode(sp.ImageChunkWrite{UploadID: f.spec.UploadID, Offset: "0", SHA256: imageBytesHash(raw), Data: base64.StdEncoding.EncodeToString(raw)})
	body, _, err := compactMediaPayload(wire, true)
	if err != nil {
		t.Fatal(err)
	}
	row := store.SessionMediaRequest{SessionID: f.r.Snapshot.SessionID, RequestID: mediaIdentity(f.spec.UploadID, "write/0"), Action: "write", Fence: f.r.Snapshot.ControllerFence, Body: body}
	f.d.media[row.RequestID] = row
	relay, d, mu := boundedMediaRelay(t, f)
	mu.Lock()
	for range 2 {
		if err := acquireImageResourceLease(t.Context(), d, store.SessionResourceLease{SessionID: row.SessionID, ID: uuid.NewString(), OwnerID: f.p.UserID, Kind: "write"}); err != nil {
			t.Fatal(err)
		}
	}
	mu.Unlock()
	text := map[string]any{"type": "content_request", "kind": "timeline", "requestId": "text-content"}
	relay.content.pending = map[string]*pendingContent{"text-content": {fence: row.Fence, epoch: f.r.Snapshot.HistoryEpoch, request: text}}
	offers, err := relay.Poll(t.Context(), row.Fence)
	if err != nil || len(offers) != 1 || offers[0]["requestId"] != "text-content" {
		t.Fatalf("temporary media saturation interrupted text polling: %v %v", offers, err)
	}
	mu.Lock()
	if saved := d.media[row.RequestID]; saved.Complete || !bytes.Equal(saved.Body, row.Body) {
		t.Fatal("deferral changed original request")
	}
	for id := range d.leases {
		delete(d.leases, id)
	}
	mu.Unlock()
	offers, err = relay.Poll(t.Context(), row.Fence)
	if err != nil || len(offers) != 1 || offers[0]["requestId"] != row.RequestID || !jsonEqual(offers[0]["body"].(json.RawMessage), wire) {
		t.Fatal("original write was not reoffered when capacity returned", offers, err)
	}
}
