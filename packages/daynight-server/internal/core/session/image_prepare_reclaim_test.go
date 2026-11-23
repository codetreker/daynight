package session

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func failedPrepareFixture(t *testing.T) (imageRuleFixture, string) {
	t.Helper()
	f := newImageRuleFixture(t, []byte("original"))
	f.prepare(t)
	// Retain a publication with unknown metadata completion as well as a
	// confirmed prefix. Reclamation must sweep both before returning quota.
	if _, err := f.write(t, []byte("orig"), 0); err != nil {
		t.Fatal(err)
	}
	f.d.failChunk = true
	if _, err := f.write(t, []byte("inal"), 4); err == nil {
		t.Fatal("fixture did not leave an uncommitted suffix")
	}
	f.d.failChunk = false
	n, _ := sessionresource.NewNamespace("", f.p.UserID, f.r.Snapshot.SessionID)
	other, _ := n.ChunkPath("12345678-1234-1234-1234-123456789abc", 0)
	if _, err := f.files.Put(t.Context(), sessionresource.Bucket, other, strings.NewReader("keep")); err != nil {
		t.Fatal(err)
	}
	row := store.SessionMediaRequest{SessionID: f.r.Snapshot.SessionID, RequestID: mediaIdentity(f.spec.UploadID, "prepare"), Action: "prepare", Fence: f.r.Snapshot.ControllerFence, Body: encode(f.spec), Complete: true, Error: &sp.ImageError{Code: "budget_exceeded", Message: "The Controller could not complete this image request."}}
	f.d.media[row.RequestID] = row
	return f, other
}

func confirmFailedPreparationRelease(t *testing.T, f imageRuleFixture) *int {
	t.Helper()
	calls := new(int)
	f.d.respond = func(row store.SessionMediaRequest) store.SessionMediaRequest {
		*calls++
		var body struct {
			UploadID string             `json:"uploadId"`
			Spec     sp.ImageUploadSpec `json:"spec"`
		}
		if row.RequestID != mediaIdentity(f.spec.UploadID, "release") || row.Action != "release" || row.Fence != f.r.Snapshot.ControllerFence || json.Unmarshal(row.Body, &body) != nil || body.UploadID != f.spec.UploadID || !jsonEqual(encode(body.Spec), encode(f.spec)) {
			t.Errorf("release did not retain the exact original preparation: %+v", row)
		}
		row.Complete = true
		row.Result = encode(sp.LocalImagePreparation{UploadID: f.spec.UploadID, ImageID: f.spec.ImageID, Target: f.spec.Target, State: "released", AcceptedOffset: "0"})
		return row
	}
	return calls
}

func TestFailedControllerPrepareCanReleaseOriginalStorage(t *testing.T) {
	for _, expiry := range []bool{false, true} {
		t.Run(map[bool]string{false: "release", true: "expiry"}[expiry], func(t *testing.T) {
			f, other := failedPrepareFixture(t)
			calls := confirmFailedPreparationRelease(t, f)
			if expiry {
				u := f.d.uploads[f.spec.UploadID]
				u.ExpiresAt = time.Now()
				f.d.uploads[f.spec.UploadID] = u
				f.s.now = func() time.Time { return u.ExpiresAt }
				if _, err := f.s.GetUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID); err != nil {
					t.Fatal("definitive failed prepare blocked expiry", err)
				}
			} else if _, err := f.s.ReleaseUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID); err != nil {
				t.Fatal("definitive failed prepare blocked release", err)
			}
			if *calls != 1 || !f.d.uploads[f.spec.UploadID].StorageReleased || len(f.d.media) != 2 {
				t.Fatal("release did not settle once under the original identities", *calls, f.d.uploads[f.spec.UploadID], f.d.media)
			}
			usage, err := f.d.SessionResourceUsage(t.Context(), f.r.Snapshot.SessionID)
			if err != nil || usage.Bytes != 0 || usage.Resources != 0 {
				t.Fatal("confirmed release retained quota", usage, err)
			}
			n, _ := sessionresource.NewNamespace("", f.p.UserID, f.r.Snapshot.SessionID)
			for _, offset := range []int64{0, 4} {
				filename, _ := n.ChunkPath(f.spec.UploadID, offset)
				object, err := f.files.Open(t.Context(), sessionresource.Bucket, filename)
				if err == nil {
					_ = object.Body.Close()
				}
				if !errors.Is(err, fs.ErrNotExist) {
					t.Fatal("quota returned before exact upload sweep", filename, err)
				}
			}
			object, err := f.files.Open(t.Context(), sessionresource.Bucket, other)
			if err != nil {
				t.Fatal("release swept another upload", err)
			}
			_ = object.Body.Close()
			original := f.d.media[mediaIdentity(f.spec.UploadID, "prepare")]
			if !original.Complete || original.Error == nil || original.Error.Code != "budget_exceeded" {
				t.Fatal("cleanup rewrote the definitive prepare outcome", original)
			}
		})
	}
}

type observedPrepareDAO struct {
	*imageRuleDAO
	request  string
	reads    int
	observed chan struct{}
}

func (d *observedPrepareDAO) SessionMediaRequest(ctx context.Context, session, request string) (store.SessionMediaRequest, error) {
	row, err := d.imageRuleDAO.SessionMediaRequest(ctx, session, request)
	if request == d.request && err == nil && !row.Complete {
		d.reads++
		// The first read finds the original spec for cleanup. The second is
		// controllerMedia observing the original unresolved prepare itself.
		if d.reads == 2 {
			close(d.observed)
		}
	}
	return row, err
}

func TestUnknownControllerPrepareRetainsOriginalStorage(t *testing.T) {
	f, _ := failedPrepareFixture(t)
	request := mediaIdentity(f.spec.UploadID, "prepare")
	row := f.d.media[request]
	row.Complete, row.Error = false, nil
	f.d.media[request] = row
	f.d.respond = func(row store.SessionMediaRequest) store.SessionMediaRequest {
		t.Errorf("unknown prepare created another request: %+v", row)
		return row
	}
	dao := &observedPrepareDAO{imageRuleDAO: f.d, request: request, observed: make(chan struct{})}
	bindImageBoundary(f, dao, true)
	ctx, cancel := context.WithCancel(t.Context())
	finished := make(chan error, 1)
	go func() {
		_, err := f.s.ReleaseUpload(ctx, f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID)
		finished <- err
	}()
	drained := false
	t.Cleanup(func() {
		cancel()
		if !drained {
			select {
			case <-finished:
			case <-time.After(5 * time.Second):
				t.Error("canceled release did not exit before fixture cleanup")
			}
		}
	})
	select {
	case <-dao.observed:
	case err := <-finished:
		drained = true
		t.Fatal("release exited before observing the unknown prepare", err)
	case <-time.After(5 * time.Second):
		t.Fatal("release never observed the original unknown prepare")
	}
	cancel()
	select {
	case err := <-finished:
		drained = true
		if !errors.Is(err, context.Canceled) {
			t.Fatal("unknown prepare did not retain cancellation", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("release did not drain after cancellation")
	}
	if f.d.uploads[f.spec.UploadID].StorageReleased || len(f.d.media) != 1 {
		t.Fatal("unknown prepare released quota or changed identity", f.d.uploads, f.d.media)
	}
	object, err := f.files.Open(t.Context(), sessionresource.Bucket, f.d.chunks[f.spec.UploadID][0].Path)
	if err != nil {
		t.Fatal("unknown prepare lost its original staging", err)
	}
	_ = object.Body.Close()
}

func TestFailedPrepareReleaseReceiptAllowsStoppedArchiveSettlement(t *testing.T) {
	f, op, filename := expiredReclaimFixture(t)
	row := store.SessionMediaRequest{SessionID: op.id, RequestID: mediaIdentity(f.spec.UploadID, "prepare"), Action: "prepare", Fence: f.r.Snapshot.ControllerFence, Body: encode(f.spec), Complete: true, Error: &sp.ImageError{Code: "budget_exceeded", Message: "Rejected before preparation."}}
	f.d.media[row.RequestID] = row
	access := func(ctx context.Context, work func(*operationTx, *record) error) error {
		return work(&operationTx{dao: f.d}, f.r)
	}
	if err := op.archivedControllerRelease(t.Context(), f.d.uploads[f.spec.UploadID], access); err == nil {
		t.Fatal("failed prepare alone was mistaken for a release receipt")
	}
	confirmFailedPreparationRelease(t, f)
	f.r.Snapshot.Lifecycle = "active"
	if err := f.s.releaseControllerPreparationWithAccess(t.Context(), op.id, f.spec.UploadID, access); err != nil {
		t.Fatal("original cleanup did not confirm release", err)
	}
	f.r.Snapshot.Lifecycle = "archived"
	f.d.respond = func(row store.SessionMediaRequest) store.SessionMediaRequest {
		t.Errorf("stopped archive issued an RPC: %+v", row)
		return row
	}
	if err := op.SettleExpiredUploads(t.Context()); err != nil {
		t.Fatal("confirmed failed-prepare release blocked archive settlement", err)
	}
	if !f.d.uploads[f.spec.UploadID].StorageReleased {
		t.Fatal("stopped archive retained confirmed quota")
	}
	object, err := f.files.Open(t.Context(), sessionresource.Bucket, filename)
	if err == nil {
		_ = object.Body.Close()
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("stopped archive retained original staging", err)
	}
}

type failedPrepareFinalDAO struct {
	*imageRuleDAO
	cause error
}

func (d failedPrepareFinalDAO) SaveSessionUpload(ctx context.Context, row store.SessionUploadRecord) error {
	if row.StorageReleased {
		return d.cause
	}
	return d.imageRuleDAO.SaveSessionUpload(ctx, row)
}

func TestFailedPrepareCleanupRetainsQuotaUntilEveryOwnerAndBarrierConfirms(t *testing.T) {
	for _, point := range []string{"controller", "file owner", "sweep", "final metadata"} {
		t.Run(point, func(t *testing.T) {
			f, _ := failedPrepareFixture(t)
			calls := confirmFailedPreparationRelease(t, f)
			cause := errors.New("cleanup completion unknown")
			var closeOwner func() error
			switch point {
			case "controller":
				f.d.respond = func(row store.SessionMediaRequest) store.SessionMediaRequest {
					row.Complete = true
					row.Error = &sp.ImageError{Code: "upload_in_use", Message: "Original reader is still running."}
					return row
				}
			case "file owner":
				lease := store.SessionResourceLease{SessionID: f.r.Snapshot.SessionID, ID: uuid.NewString(), ResourceID: f.d.uploads[f.spec.UploadID].BlobID, Kind: "read"}
				f.d.leases[lease.ID] = lease
				gate, err := f.files.AcquireGate(t.Context(), filestorage.MediaLeaseGate, "session-resource-lease/"+lease.ID)
				if err != nil {
					t.Fatal(err)
				}
				closeOwner = gate.Close
				t.Cleanup(func() { _ = gate.Close() })
			case "sweep":
				f.s.files = imageBoundaryStorage{Storage: f.files, point: "delete", cause: cause}
			case "final metadata":
				bindImageBoundary(f, failedPrepareFinalDAO{imageRuleDAO: f.d, cause: cause}, true)
			}
			_, err := f.s.ReleaseUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID)
			if err == nil || (point == "sweep" || point == "final metadata") && !errors.Is(err, cause) {
				t.Fatal("cleanup hid the failed completion", err)
			}
			usage, usageErr := f.d.SessionResourceUsage(t.Context(), f.r.Snapshot.SessionID)
			if usageErr != nil || usage.Bytes != 0 || usage.Resources != 0 || f.d.uploads[f.spec.UploadID].StorageReleased {
				t.Fatal("unconfirmed cleanup lost identity", usage, usageErr)
			}
			if point == "controller" {
				return
			}
			if closeOwner != nil {
				if err := closeOwner(); err != nil {
					t.Fatal(err)
				}
			}
			f.s.files = f.files
			bindImageBoundary(f, f.d, true)
			if _, err := f.s.ReleaseUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID); err != nil {
				t.Fatal("observed failure could not resume original cleanup", err)
			}
			if !f.d.uploads[f.spec.UploadID].StorageReleased || *calls != 1 {
				t.Fatal("cleanup created a replacement release or retained confirmed quota", *calls)
			}
		})
	}
}
