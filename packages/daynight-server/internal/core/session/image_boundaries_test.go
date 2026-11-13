package session

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type imageBoundaryDAO struct {
	*imageRuleDAO
	point                   string
	cause                   error
	usageCalls, usageFailAt int
	visibilityCalls         int
}

func (d *imageBoundaryDAO) SessionResourceReadableBy(ctx context.Context, s, id, actor string) (bool, error) {
	d.visibilityCalls++
	if d.point == "visibility" || d.point == "final visibility" && d.visibilityCalls == 2 {
		return false, d.cause
	}
	if d.point == "revoked visibility" && d.visibilityCalls == 2 {
		return false, nil
	}
	return d.imageRuleDAO.SessionResourceReadableBy(ctx, s, id, actor)
}

func (d *imageBoundaryDAO) SavedSessionResource(ctx context.Context, s, id string) (store.SessionResourceRecord, error) {
	if d.point == "resource" {
		return store.SessionResourceRecord{}, d.cause
	}
	return d.imageRuleDAO.SavedSessionResource(ctx, s, id)
}
func (d *imageBoundaryDAO) SessionResourceUsage(ctx context.Context, s string) (store.SessionResourceUsage, error) {
	d.usageCalls++
	if d.point == "usage" && (d.usageFailAt == 0 || d.usageCalls == d.usageFailAt) {
		return store.SessionResourceUsage{}, d.cause
	}
	return d.imageRuleDAO.SessionResourceUsage(ctx, s)
}
func (d *imageBoundaryDAO) AcquireSessionResourceLease(ctx context.Context, r store.SessionResourceLease) error {
	if d.point == "lease" {
		return d.cause
	}
	return d.imageRuleDAO.AcquireSessionResourceLease(ctx, r)
}
func (d *imageBoundaryDAO) SessionUpload(ctx context.Context, s, id string) (store.SessionUploadRecord, error) {
	if d.point == "upload" {
		return store.SessionUploadRecord{}, d.cause
	}
	return d.imageRuleDAO.SessionUpload(ctx, s, id)
}
func (d *imageBoundaryDAO) SessionUploadChunks(ctx context.Context, s, id string) ([]store.SessionUploadChunk, error) {
	if d.point == "chunks" {
		return nil, d.cause
	}
	return d.imageRuleDAO.SessionUploadChunks(ctx, s, id)
}
func (d *imageBoundaryDAO) SaveSessionUpload(ctx context.Context, r store.SessionUploadRecord) error {
	if d.point == "save" {
		return d.cause
	}
	return d.imageRuleDAO.SaveSessionUpload(ctx, r)
}
func (d *imageBoundaryDAO) SaveSession(ctx context.Context, r store.SessionRecord) error {
	if d.point == "session save" {
		return d.cause
	}
	return d.imageRuleDAO.SaveSession(ctx, r)
}
func (d *imageBoundaryDAO) SessionResourceReferenceCount(ctx context.Context, s, id string) (int, error) {
	if d.point == "references" {
		return 0, d.cause
	}
	return d.imageRuleDAO.SessionResourceReferenceCount(ctx, s, id)
}
func (d *imageBoundaryDAO) SessionResourceReferenceExists(ctx context.Context, r store.SessionResourceReference) (bool, error) {
	if d.point == "reference exists" {
		return false, d.cause
	}
	return d.imageRuleDAO.SessionResourceReferenceExists(ctx, r)
}
func (d *imageBoundaryDAO) RemoveSessionResourceReference(ctx context.Context, r store.SessionResourceReference) error {
	if d.point == "remove reference" {
		return d.cause
	}
	return d.imageRuleDAO.RemoveSessionResourceReference(ctx, r)
}
func bindImageBoundary(f imageRuleFixture, d store.SessionDAO, write bool) {
	f.s.browserRun = func(ctx context.Context, _ model.Principal, _, _, _ string, _ BrowserPurpose, fn func(*Access) error) error {
		if e := ctx.Err(); e != nil {
			return e
		}
		return fn(&Access{tx: &operationTx{dao: d, op: &Operation{}}, record: f.r, write: write})
	}
}

type imageBoundaryStorage struct {
	filestorage.Storage
	point string
	cause error
}

func (s imageBoundaryStorage) Open(ctx context.Context, b, p string) (filestorage.Object, error) {
	if s.point == "open" {
		return filestorage.Object{}, s.cause
	}
	return s.Storage.Open(ctx, b, p)
}
func (s imageBoundaryStorage) Delete(ctx context.Context, b, p string) error {
	if s.point == "delete" {
		return s.cause
	}
	return s.Storage.Delete(ctx, b, p)
}
func (s imageBoundaryStorage) DeleteSessionUpload(ctx context.Context, n sessionresource.Namespace, uploadID string) error {
	if s.point == "delete" {
		return s.cause
	}
	return s.Storage.(filestorage.UploadStorage).DeleteSessionUpload(ctx, n, uploadID)
}
func (s imageBoundaryStorage) AcquireGate(ctx context.Context, d filestorage.GateDomain, k string) (io.Closer, error) {
	if s.point == "gate" {
		return nil, s.cause
	}
	return s.Storage.AcquireGate(ctx, d, k)
}

func TestImageSavedReadsPreserveAuthorizationAndStorageFailures(t *testing.T) {
	for _, kind := range []string{"missing storage", "missing capability", "visibility", "final visibility", "revoked visibility", "resource", "rate", "empty blob", "wrong path", "unavailable", "usage", "lease", "open", "corrupt bytes", "final usage", "deleting", "invalid range", "past EOF"} {
		t.Run(kind, func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("original"))
			f.prepare(t)
			if _, e := f.write(t, []byte("original"), 0); e != nil {
				t.Fatal(e)
			}
			u, e := f.complete(t)
			if e != nil {
				t.Fatal(e)
			}
			id := u.Resource.ResourceID
			d := &imageBoundaryDAO{imageRuleDAO: f.d, cause: errors.New("saved image transaction unavailable")}
			bindImageBoundary(f, d, true)
			input := sp.ImageReadRequest{ResourceID: id, Offset: "0", Limit: 3}
			saved := f.d.resources[id]
			switch kind {
			case "missing storage":
				f.s.files = nil
			case "missing capability":
				bindImageBoundary(f, &mediaRateMissingDAO{}, true)
			case "resource", "usage", "lease", "visibility", "final visibility", "revoked visibility":
				d.point = kind
			case "rate":
				f.d.rateDeny = "observe"
			case "empty blob":
				saved.BlobPath = ""
			case "wrong path":
				saved.BlobPath = "other/original"
			case "unavailable":
				saved.Resource.Status = "unavailable"
			case "open":
				f.s.files = imageBoundaryStorage{Storage: f.files, point: "open", cause: d.cause}
			case "corrupt bytes":
				digest := imageBytesHash([]byte("other"))
				saved.Resource.SHA256 = &digest
			case "final usage":
				d.point = "usage"
				d.usageFailAt = 2
			case "deleting":
				f.d.usage.Deleting = true
			case "invalid range":
				input.Limit = 0
			case "past EOF":
				input.Offset = "9"
			}
			f.d.resources[id] = saved
			if _, e = f.s.ReadResource(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, input); e == nil {
				t.Fatal("invalid saved original read succeeded", kind)
			}
			if d.point != "" && d.point != "revoked visibility" && !errors.Is(e, d.cause) {
				t.Fatal("saved read hid storage cause", e)
			}
			if len(f.d.leases) != 0 {
				t.Fatal("failed saved read leaked lease")
			}
		})
	}
}

func TestImageAccessUsesAuthorizedSessionAndRejectsLegacyStorage(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	resource := uuid.NewString()
	size := "8"
	f.d.resources[resource] = store.SessionResourceRecord{SessionID: f.r.Snapshot.SessionID, Resource: sp.Resource{ResourceID: resource, ByteLength: &size}}
	a := &Access{tx: &operationTx{dao: f.d}, record: f.r}
	if r, e := a.SavedResource(t.Context(), resource); e != nil || r.SessionID != f.r.Snapshot.SessionID {
		t.Fatal(r, e)
	}
	if r, e := a.ListSavedResources(t.Context()); e != nil || len(r) != 1 {
		t.Fatal(r, e)
	}
	if e := a.AddResourceReference(t.Context(), resource, "message", "original"); e != nil {
		t.Fatal(e)
	}
	if !f.d.references[store.SessionResourceReference{SessionID: f.r.Snapshot.SessionID, ResourceID: resource, Kind: "message", ReferenceID: "original"}] {
		t.Fatal("pin lost authorized Session scope")
	}
	a.tx.dao = &mediaRateMissingDAO{}
	if _, e := a.SavedResource(t.Context(), resource); e == nil {
		t.Fatal("legacy storage supplied resource")
	}
	if _, e := a.ListSavedResources(t.Context()); e == nil {
		t.Fatal("legacy storage listed resource")
	}
	if e := a.AddResourceReference(t.Context(), resource, "message", "original"); e == nil {
		t.Fatal("legacy storage accepted pin")
	}
	if _, e := BlobAddress("invalid", f.r.Owner, f.r.Snapshot.SessionID, resource); e == nil {
		t.Fatal("invalid namespace accepted")
	}
	if _, _, e := f.s.Resource(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, "invalid"); e == nil {
		t.Fatal("invalid fallback resource identity accepted")
	}
}

func TestImageUploadObservationAndCleanupRetainUnconfirmedQuota(t *testing.T) {
	for _, kind := range []string{"missing capability", "upload", "actor", "rate", "expired save", "expired storage", "gate", "cleanup chunks", "cleanup delete", "cleanup receiving", "release readonly", "release rate", "references", "reference exists", "remove reference"} {
		t.Run(kind, func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("original"))
			f.prepare(t)
			d := &imageBoundaryDAO{imageRuleDAO: f.d, cause: errors.New("image cleanup unavailable")}
			bindImageBoundary(f, d, true)
			u := f.d.uploads[f.spec.UploadID]
			if kind == "references" || kind == "reference exists" || kind == "remove reference" {
				id := uuid.NewString()
				u.Receipt.Resource = &sp.Resource{ResourceID: id}
				d.point = kind
			}
			switch kind {
			case "missing capability":
				bindImageBoundary(f, &mediaRateMissingDAO{}, true)
			case "upload":
				d.point = "upload"
			case "actor":
				u.ActorID = uuid.NewString()
			case "rate":
				f.d.rateDeny = "observe"
			case "expired save":
				u.ExpiresAt = time.Now().Add(-time.Hour)
				d.point = "save"
			case "expired storage":
				u.Receipt.State = "expired"
				f.s.files = nil
			case "gate":
				u.Receipt.State = "expired"
				f.s.files = imageBoundaryStorage{Storage: f.files, point: "gate", cause: d.cause}
			case "cleanup chunks":
				u.Receipt.State = "complete"
				d.point = "chunks"
			case "cleanup delete":
				u.Receipt.State = "complete"
				f.d.chunks[f.spec.UploadID] = []store.SessionUploadChunk{{Path: "original/chunk"}}
				f.s.files = imageBoundaryStorage{Storage: f.files, point: "delete", cause: d.cause}
			case "release readonly":
				bindImageBoundary(f, d, false)
			case "release rate":
				f.d.rateDeny = "release"
			}
			f.d.uploads[f.spec.UploadID] = u
			var e error
			switch kind {
			case "cleanup chunks", "cleanup delete", "cleanup receiving":
				e = f.s.cleanupUploadFiles(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID)
			case "release readonly", "release rate", "references", "reference exists", "remove reference":
				_, e = f.s.ReleaseUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID)
			default:
				_, e = f.s.GetUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID)
			}
			if e == nil {
				t.Fatal("failed original cleanup succeeded", kind)
			}
			if d.point != "" && !errors.Is(e, d.cause) {
				t.Fatal("cleanup cause hidden", e)
			}
			if f.d.uploads[f.spec.UploadID].StorageReleased {
				t.Fatal("unconfirmed cleanup returned staging quota")
			}
		})
	}
}

func TestImageLeaseCleanupUsesUncancelledAuthorizedFallback(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	f.s.SetMediaLeaseCleanup(nil)
	f.d.leases["lease"] = store.SessionResourceLease{ID: "lease"}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if e := f.s.releaseImageLease(ctx, f.p, "", "", f.r.Snapshot.SessionID, "lease"); e != nil || len(f.d.leases) != 0 {
		t.Fatal("cancelled operation leaked durable lease", e)
	}
	bindImageBoundary(f, &mediaRateMissingDAO{}, true)
	if e := f.s.releaseImageLease(ctx, f.p, "", "", f.r.Snapshot.SessionID, "lease"); e == nil {
		t.Fatal("unsupported lease cleanup succeeded")
	}
	cause := errors.New("original operation failure")
	if !errors.Is(joinImageCleanup(cause, nil), cause) {
		t.Fatal("missing cleanup hid original failure")
	}
	f.s.files = imageBoundaryStorage{Storage: f.files, point: "gate", cause: cause}
	if _, _, e := f.s.beginImageIO(t.Context(), f.r.Snapshot.SessionID, "lease"); !errors.Is(e, cause) {
		t.Fatal("filesystem gate failure hidden", e)
	}
}

func TestImagePublicWriteAndCompletionRejectUnboundOriginals(t *testing.T) {
	for _, kind := range []string{"valid write", "write readonly", "write rate", "write upload", "write chunks", "write usage", "write lease", "complete invalid", "complete readonly", "complete rate", "complete mismatch", "complete chunks", "complete usage", "complete lease", "complete save"} {
		t.Run(kind, func(t *testing.T) {
			raw := []byte("original")
			f := newImageRuleFixture(t, raw)
			f.prepare(t)
			if len(kind) >= 8 && kind[:8] == "complete" {
				if _, e := f.write(t, raw, 0); e != nil {
					t.Fatal(e)
				}
			}
			d := &imageBoundaryDAO{imageRuleDAO: f.d, cause: errors.New("upload transaction unavailable")}
			bindImageBoundary(f, d, true)
			input := sp.ImageChunkWrite{UploadID: f.spec.UploadID, Offset: "0", SHA256: f.spec.SHA256, Data: base64.StdEncoding.EncodeToString(raw)}
			complete := sp.ImageUploadComplete{SHA256: f.spec.SHA256, ByteLength: f.spec.ByteLength}
			switch kind {
			case "write readonly", "complete readonly":
				bindImageBoundary(f, d, false)
			case "write rate", "complete rate":
				f.d.rateDeny = "control"
			case "write upload":
				d.point = "upload"
			case "write chunks", "complete chunks":
				d.point = "chunks"
			case "write usage", "complete usage":
				d.point = "usage"
			case "write lease", "complete lease":
				d.point = "lease"
			case "complete save":
				d.point = "save"
			case "complete invalid":
				complete.SHA256 = "invalid"
			case "complete mismatch":
				complete.ByteLength = "7"
			}
			var e error
			if len(kind) >= 8 && kind[:8] == "complete" {
				_, e = f.s.CompleteUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID, complete)
			} else {
				_, e = f.s.WriteUploadChunk(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID, input)
			}
			if kind == "valid write" {
				if e != nil || len(f.d.chunks[f.spec.UploadID]) != 1 {
					t.Fatal("public original write failed", e)
				}
				return
			}
			if e == nil {
				t.Fatal("invalid original mutation succeeded", kind)
			}
			if d.point != "" && !errors.Is(e, d.cause) {
				t.Fatal("upload cause hidden", e)
			}
		})
	}
}

func TestImageImmutablePublicationChecksExistingBytesAndPropagatesOpenFailure(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	n, e := sessionresource.NewNamespace("", f.r.Owner, f.r.Snapshot.SessionID)
	if e != nil {
		t.Fatal(e)
	}
	path, e := n.BlobPath(uuid.NewString())
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.files.Put(t.Context(), sessionresource.Bucket, path, bytes.NewReader([]byte("original"))); e != nil {
		t.Fatal(e)
	}
	if e = f.s.publishImageBytes(t.Context(), path, bytes.NewReader([]byte("replacement")), 8, imageBytesHash([]byte("original"))); e != nil {
		t.Fatal("immutable original failed reconciliation", e)
	}
	if e = f.s.publishImageBytes(t.Context(), path, bytes.NewReader(nil), 8, imageBytesHash([]byte("different"))); e == nil {
		t.Fatal("different immutable bytes accepted")
	}
	cause := errors.New("original storage is unavailable")
	f.s.files = imageBoundaryStorage{Storage: f.files, point: "open", cause: cause}
	if e = f.s.publishImageBytes(t.Context(), path, bytes.NewReader(nil), 8, imageBytesHash([]byte("original"))); !errors.Is(e, cause) {
		t.Fatal("open failure was treated as absence", e)
	}
}

func TestImageBudgetPersistenceRequiresCurrentCapabilityAndConfirmedReceipt(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	d := &imageBoundaryDAO{imageRuleDAO: f.d, cause: errors.New("budget transaction unavailable")}
	tx := &operationTx{dao: d, op: &Operation{}}
	f.r.Snapshot.ContentRevision = 0
	if e := f.s.syncImageBudget(t.Context(), tx, f.r); e != nil {
		t.Fatal(e)
	}
	f.r.Snapshot.ContentRevision = 2
	if e := f.s.syncImageBudget(t.Context(), &operationTx{dao: &mediaRateMissingDAO{}}, f.r); e == nil {
		t.Fatal("legacy storage published budget")
	}
	d.point = "usage"
	if e := f.s.syncImageBudget(t.Context(), tx, f.r); !errors.Is(e, d.cause) {
		t.Fatal(e)
	}
	d.point = "session save"
	f.r.Snapshot.ImageBudget = nil
	if e := f.s.syncImageBudget(t.Context(), tx, f.r); !errors.Is(e, d.cause) {
		t.Fatal(e)
	}
	if e := f.s.saveImageUpload(t.Context(), &operationTx{dao: &mediaRateMissingDAO{}}, f.r, store.SessionUploadRecord{}); e == nil {
		t.Fatal("legacy storage accepted receipt")
	}
	d.point = "save"
	if e := f.s.saveImageUpload(t.Context(), tx, f.r, store.SessionUploadRecord{}); !errors.Is(e, d.cause) {
		t.Fatal(e)
	}
}

func TestImageCompletionRejectsMissingChunksAndDisagreeingValidation(t *testing.T) {
	for _, kind := range []string{"missing chunks", "missing chunk bytes", "decoder media", "decoder geometry", "remote rejection", "remote receipt"} {
		t.Run(kind, func(t *testing.T) {
			raw := []byte("original")
			f := newImageRuleFixture(t, raw)
			f.prepare(t)
			if _, e := f.write(t, raw, 0); e != nil {
				t.Fatal(e)
			}
			switch kind {
			case "missing chunks":
				f.d.chunks[f.spec.UploadID] = nil
			case "missing chunk bytes":
				if e := f.files.Delete(t.Context(), sessionresource.Bucket, f.d.chunks[f.spec.UploadID][0].Path); e != nil {
					t.Fatal(e)
				}
			case "decoder media", "decoder geometry":
				f.s.SetImageDecoder(func(context.Context, io.Reader, int64, string) (sp.ValidatedImage, error) {
					v := sp.ValidatedImage{MediaType: "image/png", ByteLength: f.spec.ByteLength, SHA256: f.spec.SHA256, Width: 2, Height: 3, FrameCount: 1}
					if kind == "decoder media" {
						v.MediaType = "image/jpeg"
					} else {
						v.Width = 16385
					}
					return v, nil
				})
			case "remote rejection", "remote receipt":
				f.d.respond = func(row store.SessionMediaRequest) store.SessionMediaRequest {
					row.Complete = true
					if row.Action != "complete" {
						row.Result = []byte(`{}`)
						return row
					}
					r := sp.LocalImagePreparation{UploadID: f.spec.UploadID, ImageID: f.spec.ImageID, Target: f.spec.Target, State: "failed", AcceptedOffset: f.spec.ByteLength, Error: &sp.ImageError{Code: "invalid_image", Message: "Rejected original."}}
					if kind == "remote receipt" {
						r.UploadID = uuid.NewString()
					}
					row.Result = encode(r)
					return row
				}
			}
			_, e := f.s.completeUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID, sp.ImageUploadComplete{SHA256: f.spec.SHA256, ByteLength: f.spec.ByteLength}, kind == "remote rejection" || kind == "remote receipt")
			if e == nil || len(f.d.resources) != 0 {
				t.Fatal("unverified original became a saved resource", kind, e)
			}
			if len(f.d.leases) != 0 {
				t.Fatal("completion failure leaked lease")
			}
		})
	}
}

func TestImageCaptureCopyRejectsMissingAuthorizationAndChangedSourceChunks(t *testing.T) {
	for _, kind := range []string{"missing validation", "authorization", "source failure", "source identity", "source data"} {
		t.Run(kind, func(t *testing.T) {
			raw := []byte("original")
			f := newImageRuleFixture(t, raw)
			c := registerOccurrenceFixture(t, f)
			v := sp.ValidatedImage{MediaType: "image/png", ByteLength: f.spec.ByteLength, SHA256: f.spec.SHA256, Width: 2, Height: 3, FrameCount: 1}
			c.Validated = &v
			c.Receipt.State = "copying"
			f.d.captures[c.Request.CaptureID] = c
			switch kind {
			case "missing validation":
				c.Validated = nil
			case "authorization":
				f.s.browserRun = func(context.Context, model.Principal, string, string, string, BrowserPurpose, func(*Access) error) error {
					return denied()
				}
			default:
				f.d.respond = func(row store.SessionMediaRequest) store.SessionMediaRequest {
					row.Complete = true
					if kind == "source failure" {
						row.Error = &sp.ImageError{Code: "source_unavailable", Message: "Original source unavailable."}
						return row
					}
					chunk := sp.PreparedImageChunk{PreparationID: c.Receipt.AttemptID, Offset: "0", SHA256: v.SHA256, ByteLength: v.ByteLength, Data: base64.StdEncoding.EncodeToString(raw), EOF: true}
					if kind == "source identity" {
						chunk.PreparationID = uuid.NewString()
					} else {
						chunk.Data = "not-base64"
					}
					row.Result = encode(chunk)
					return row
				}
			}
			if e := f.s.copyCapture(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, c); e == nil {
				t.Fatal("changed original source copied", kind)
			}
			if len(f.d.resources) != 0 {
				t.Fatal("invalid source became saved resource")
			}
		})
	}
}

type occurrenceBoundaryDAO struct {
	*imageBoundaryDAO
	point string
}

func (d *occurrenceBoundaryDAO) SessionCaptureByImage(ctx context.Context, s, id string) (store.SessionCaptureRecord, error) {
	if d.point == "capture" {
		return store.SessionCaptureRecord{}, d.cause
	}
	return d.imageRuleDAO.SessionCaptureByImage(ctx, s, id)
}
func (d *occurrenceBoundaryDAO) SaveSessionCapture(ctx context.Context, c store.SessionCaptureRecord) error {
	if d.point == "capture save" {
		return d.cause
	}
	return d.imageRuleDAO.SaveSessionCapture(ctx, c)
}
func (d *occurrenceBoundaryDAO) SessionMediaRequest(ctx context.Context, s, id string) (store.SessionMediaRequest, error) {
	if d.point == "media" {
		return store.SessionMediaRequest{}, d.cause
	}
	return d.imageRuleDAO.SessionMediaRequest(ctx, s, id)
}

func TestImageOccurrenceObservationsAndRetriesPreserveFailedAdmission(t *testing.T) {
	for _, kind := range []string{"observe rate", "observe capture", "observe media", "observe failure receipt", "retry rate", "retry capture", "retry history", "retry offline", "retry usage", "retry save", "retry invalid result"} {
		t.Run(kind, func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("original"))
			c := failOccurrenceFixture(f, registerOccurrenceFixture(t, f), "invalid_image")
			f.d.bundle.Ledger = encode(archiveLedger{HistoryID: f.d.bundle.HistoryID, HistoryEpoch: f.r.Snapshot.HistoryEpoch, SourceThrough: "0", Sealable: true})
			d := &occurrenceBoundaryDAO{imageBoundaryDAO: &imageBoundaryDAO{imageRuleDAO: f.d, cause: errors.New("occurrence transaction unavailable")}}
			bindImageBoundary(f, d, true)
			switch kind {
			case "observe rate":
				f.d.rateDeny = "observe"
			case "observe capture", "retry capture":
				d.point = "capture"
			case "observe media":
				c.Receipt.State = "reserved"
				c.Receipt.Error = nil
				c.Receipt.AttemptID = uuid.NewString()
				id := uuid.NewString()
				c.Receipt.ResourceID = &id
				f.d.captures[c.Request.CaptureID] = c
				d.point = "media"
			case "observe failure receipt":
				c.Receipt.Error = nil
				f.d.captures[c.Request.CaptureID] = c
			case "retry rate":
				f.d.rateDeny = "prepare"
			case "retry history":
				f.d.bundle.Ledger = encode(archiveLedger{Sealable: false})
			case "retry offline":
				f.r.Live = nil
			case "retry usage":
				d.imageBoundaryDAO.point = "usage"
			case "retry save":
				d.point = "capture save"
			case "retry invalid result":
				f.d.respond = func(row store.SessionMediaRequest) store.SessionMediaRequest {
					row.Complete = true
					row.Result = []byte(`{}`)
					return row
				}
			}
			var e error
			if len(kind) >= 7 && kind[:7] == "observe" {
				_, e = f.s.GetImageOccurrence(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, c.Request.Occurrence.ImageID)
			} else {
				_, e = f.s.RetryImageOccurrence(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, c.Request.Occurrence.ImageID)
			}
			if e == nil {
				t.Fatal("failed occurrence admission succeeded", kind)
			}
			if d.point != "" || d.imageBoundaryDAO.point != "" {
				if !errors.Is(e, d.cause) {
					t.Fatal("occurrence storage cause hidden", e)
				}
			}
			if kind != "retry invalid result" && len(f.d.media) != 0 {
				t.Fatal("refused occurrence created source RPC")
			}
		})
	}
}
