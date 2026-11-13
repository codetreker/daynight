package session

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type imageRuleDAO struct {
	store.SessionDAO
	store.SessionResourceDAO
	store.SessionArchiveDAO
	bundle              store.ArchiveBundle
	uploads             map[string]store.SessionUploadRecord
	chunks              map[string][]store.SessionUploadChunk
	resources           map[string]store.SessionResourceRecord
	references          map[store.SessionResourceReference]bool
	leases              map[string]store.SessionResourceLease
	usage               store.SessionResourceUsage
	media               map[string]store.SessionMediaRequest
	captures            map[string]store.SessionCaptureRecord
	respond             func(store.SessionMediaRequest) store.SessionMediaRequest
	failSave, failChunk bool
	rateCalls           []string
	rateDeny            string
}

func (d *imageRuleDAO) SessionArchiveBundle(context.Context, string) (store.ArchiveBundle, error) {
	if d.bundle.SessionID == "" {
		return d.bundle, model.ErrNotFound
	}
	return d.bundle, nil
}
func (d *imageRuleDAO) LockSessionMediaRate(_ context.Context, _ string, kind string, initial store.SessionMediaRate) (store.SessionMediaRate, error) {
	d.rateCalls = append(d.rateCalls, kind)
	if kind == d.rateDeny {
		initial.Tokens = 0
	}
	return initial, nil
}
func (d *imageRuleDAO) SaveSessionMediaRate(context.Context, string, string, store.SessionMediaRate) error {
	return nil
}
func (d *imageRuleDAO) SessionImageUploadExists(_ context.Context, _, image string) (bool, error) {
	for _, u := range d.uploads {
		if u.Spec.ImageID == image {
			return true, nil
		}
	}
	return false, nil
}
func (d *imageRuleDAO) SessionCaptureByImage(_ context.Context, _, image string) (store.SessionCaptureRecord, error) {
	for _, c := range d.captures {
		if c.Request.Occurrence.ImageID == image {
			return c, nil
		}
	}
	return store.SessionCaptureRecord{}, model.ErrNotFound
}
func (d *imageRuleDAO) SaveSession(context.Context, store.SessionRecord) error { return nil }
func (d *imageRuleDAO) SessionUpload(_ context.Context, s, id string) (store.SessionUploadRecord, error) {
	u, ok := d.uploads[id]
	if !ok {
		return u, model.ErrNotFound
	}
	if u.SessionID != s {
		panic("wrong Session")
	}
	return u, nil
}
func (d *imageRuleDAO) SaveSessionUpload(_ context.Context, u store.SessionUploadRecord) error {
	if d.failSave {
		return errors.New("commit outcome unknown")
	}
	d.uploads[u.Spec.UploadID] = u
	return nil
}
func (d *imageRuleDAO) SessionUploadChunks(_ context.Context, s, id string) ([]store.SessionUploadChunk, error) {
	return d.chunks[id], nil
}
func (d *imageRuleDAO) InsertSessionUploadChunk(_ context.Context, c store.SessionUploadChunk) error {
	if d.failChunk {
		return errors.New("chunk commit outcome unknown")
	}
	d.chunks[c.UploadID] = append(d.chunks[c.UploadID], c)
	return nil
}
func (d *imageRuleDAO) SessionResourceUsage(context.Context, string) (store.SessionResourceUsage, error) {
	u := d.usage
	u.UploadIdentities += len(d.uploads)
	for _, r := range d.resources {
		u.Bytes += number(*r.Resource.ByteLength)
		u.Resources++
	}
	for _, r := range d.uploads {
		if !r.StorageReleased && r.Receipt.State != "complete" {
			u.ReservedBytes += number(r.Spec.ByteLength)
			u.ReservedResources++
		}
	}
	for _, c := range d.captures {
		if _, exists := d.uploads[c.Request.CaptureID]; !exists {
			u.UploadIdentities++
		}
		if c.Receipt.State != "reserved" && c.Receipt.State != "copying" {
			continue
		}
		if _, exists := d.uploads[c.Receipt.AttemptID]; exists {
			continue
		}
		size := int64(sp.MaxImageBytes)
		if c.Validated != nil {
			size = number(c.Validated.ByteLength)
		}
		u.ReservedBytes += size
		u.ReservedResources++
	}
	return u, nil
}
func (d *imageRuleDAO) MarkSessionResourceReclaim(_ context.Context, s, id string) (bool, error) {
	for ref := range d.references {
		if ref.SessionID == s && ref.ResourceID == id {
			return false, nil
		}
	}
	if resource, ok := d.resources[id]; ok {
		resource.GCPending = true
		d.resources[id] = resource
	}
	return true, nil
}
func (d *imageRuleDAO) DeleteReclaimedSessionResource(_ context.Context, s, id string) error {
	for ref := range d.references {
		if ref.SessionID == s && ref.ResourceID == id {
			return fault("resource_in_use", "Original remains referenced.")
		}
	}
	for _, lease := range d.leases {
		if lease.SessionID == s && (lease.ResourceID == "" || lease.ResourceID == id) {
			return fault("resource_busy", "Original has an active reader.")
		}
	}
	delete(d.resources, id)
	return nil
}
func (d *imageRuleDAO) ListSessionUploadsForSettlement(_ context.Context, s string, now time.Time) ([]store.SessionUploadRecord, error) {
	out := []store.SessionUploadRecord{}
	for _, upload := range d.uploads {
		expired := !now.Before(upload.ExpiresAt) && (upload.Receipt.State == "receiving" || upload.Receipt.State == "verifying" || upload.Receipt.State == "complete")
		_, original := d.resources[upload.BlobID]
		terminal := upload.Receipt.State == "failed" || upload.Receipt.State == "expired" || upload.Receipt.State == "released"
		if upload.SessionID == s && (expired || terminal && (!upload.StorageReleased || original)) {
			out = append(out, upload)
		}
	}
	return out, nil
}
func (d *imageRuleDAO) ListSessionResourceLeases(_ context.Context, s string) ([]store.SessionResourceLease, error) {
	out := []store.SessionResourceLease{}
	for _, lease := range d.leases {
		if lease.SessionID == s {
			out = append(out, lease)
		}
	}
	return out, nil
}
func (d *imageRuleDAO) AcquireSessionResourceLease(_ context.Context, r store.SessionResourceLease) error {
	if d.usage.Deleting {
		return conflict()
	}
	if r.ResourceID != "" && d.resources[r.ResourceID].GCPending {
		return conflict()
	}
	if r.ResourceID == "" {
		for _, resource := range d.resources {
			if resource.SessionID == r.SessionID && resource.GCPending {
				return conflict()
			}
		}
	}
	d.leases[r.ID] = r
	return nil
}
func (d *imageRuleDAO) ReleaseSessionResourceLease(_ context.Context, s, id string) error {
	delete(d.leases, id)
	return nil
}
func (d *imageRuleDAO) SavedSessionResource(_ context.Context, s, id string) (store.SessionResourceRecord, error) {
	r, ok := d.resources[id]
	if !ok {
		return r, model.ErrNotFound
	}
	return r, nil
}
func (d *imageRuleDAO) ListSessionResources(context.Context, string) ([]store.SessionResourceRecord, error) {
	out := []store.SessionResourceRecord{}
	for _, r := range d.resources {
		out = append(out, r)
	}
	return out, nil
}
func (d *imageRuleDAO) InsertSessionResource(_ context.Context, r store.SessionResourceRecord) error {
	if _, ok := d.resources[r.Resource.ResourceID]; ok {
		panic("duplicate immutable resource")
	}
	d.resources[r.Resource.ResourceID] = r
	return nil
}
func (d *imageRuleDAO) AddSessionResourceReference(_ context.Context, r store.SessionResourceReference) error {
	if d.resources[r.ResourceID].GCPending {
		return conflict()
	}
	d.references[r] = true
	return nil
}
func (d *imageRuleDAO) RemoveSessionResourceReference(_ context.Context, r store.SessionResourceReference) error {
	delete(d.references, r)
	return nil
}
func (d *imageRuleDAO) SessionResourceReferenceExists(_ context.Context, r store.SessionResourceReference) (bool, error) {
	return d.references[r], nil
}
func (d *imageRuleDAO) SessionResourceReferenceCount(_ context.Context, s, id string) (int, error) {
	n := 0
	for r := range d.references {
		if r.SessionID == s && r.ResourceID == id {
			n++
		}
	}
	return n, nil
}

func (d *imageRuleDAO) SessionMediaRequest(_ context.Context, _, id string) (store.SessionMediaRequest, error) {
	row, ok := d.media[id]
	if !ok {
		return row, model.ErrNotFound
	}
	return row, nil
}
func (d *imageRuleDAO) SaveSessionMediaRequest(_ context.Context, row store.SessionMediaRequest) error {
	if old, ok := d.media[row.RequestID]; ok {
		if row.Expected != nil {
			expected := row.Expected
			if old.Action != row.Action || old.Fence != expected.Fence || !jsonEqual(old.Body, expected.Body) || !(old.Result == nil && expected.Result == nil || jsonEqual(old.Result, expected.Result)) || !jsonEqual(encode(old.Error), encode(expected.Error)) || old.Complete != expected.Complete {
				return conflict()
			}
		} else {
			if old.Action != row.Action || old.Fence.Fence != row.Fence.Fence || !jsonEqual(old.Body, row.Body) {
				return conflict()
			}
			if old.Complete && (!row.Complete || !jsonEqual(old.Result, row.Result)) {
				return conflict()
			}
		}
	}
	row.Expected = nil
	if !row.Complete && d.respond != nil {
		row = d.respond(row)
	}
	d.media[row.RequestID] = row
	return nil
}
func (d *imageRuleDAO) SessionUploadMediaRequests(_ context.Context, s, id, resource string) ([]store.SessionMediaRequest, error) {
	out := []store.SessionMediaRequest{}
	for _, row := range d.media {
		var body map[string]string
		_ = json.Unmarshal(row.Body, &body)
		if row.SessionID == s && (body["uploadId"] == id || body["attemptId"] == id || body["preparationId"] == id || body["resourceId"] == resource) {
			out = append(out, row)
		}
	}
	return out, nil
}
func (d *imageRuleDAO) PendingSessionMediaRequests(_ context.Context, fence sp.Fence) ([]store.SessionMediaRequest, error) {
	out := []store.SessionMediaRequest{}
	for _, row := range d.media {
		if !row.Complete && row.Fence.Fence == fence {
			out = append(out, row)
		}
	}
	return out, nil
}
func (d *imageRuleDAO) SessionCapture(_ context.Context, _, id string) (store.SessionCaptureRecord, error) {
	row, ok := d.captures[id]
	if !ok {
		return row, model.ErrNotFound
	}
	return row, nil
}
func (d *imageRuleDAO) SaveSessionCapture(_ context.Context, row store.SessionCaptureRecord) error {
	if old, ok := d.captures[row.Request.CaptureID]; ok {
		if row.Expected == nil || !jsonEqual(encode(old.Request), encode(row.Request)) || !jsonEqual(encode(old.Receipt), encode(row.Expected.Receipt)) || !jsonEqual(encode(old.Validated), encode(row.Expected.Validated)) {
			return conflict()
		}
	} else if row.Expected != nil {
		return conflict()
	}
	row.Expected = nil
	d.captures[row.Request.CaptureID] = row
	return nil
}

type imageRuleStorage struct {
	filestorage.Storage
	free, total int64
	beforePut   func(string)
}

func (s *imageRuleStorage) ResourceSpace(context.Context) (int64, int64, error) {
	return s.free, s.total, nil
}
func (s *imageRuleStorage) DeleteSessionUpload(ctx context.Context, n sessionresource.Namespace, uploadID string) error {
	return s.Storage.(filestorage.UploadStorage).DeleteSessionUpload(ctx, n, uploadID)
}
func (s *imageRuleStorage) Put(ctx context.Context, bucket, path string, r io.Reader) (filestorage.FileInfo, error) {
	if s.beforePut != nil {
		s.beforePut(path)
	}
	return s.Storage.Put(ctx, bucket, path, r)
}

type imageRuleFixture struct {
	s     *Execution
	d     *imageRuleDAO
	r     *record
	p     model.Principal
	spec  sp.ImageUploadSpec
	files *imageRuleStorage
}

func supportedImageRuleCapabilities(native *string) *sp.ImageCapabilities {
	model := "controlled-model"
	return &sp.ImageCapabilities{Revision: "2", ProviderRevision: "7", ExpectedNativeSessionID: native, ModelID: &model, Send: "supported", Steer: "unsupported", InputMediaTypes: []string{"image/png", "image/jpeg", "image/webp"}, MaxImageBytes: decimal(sp.MaxImageBytes), MaxMessageImageBytes: decimal(sp.MaxMessageImageBytes), MaxImagesPerMessage: sp.MaxImagesPerMessage, Geometry: sp.ImageGeometry{Version: 1, Known: true, MaxWidth: 16384, MaxHeight: 16384, MaxPixels: 33554432, MaxFrames: 256}}
}

func newImageRuleFixture(t *testing.T, raw []byte) imageRuleFixture {
	t.Helper()
	storage, e := local.New(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		if e := storage.Close(); e != nil {
			t.Error(e)
		}
	})
	d := &imageRuleDAO{media: map[string]store.SessionMediaRequest{}, captures: map[string]store.SessionCaptureRecord{}, uploads: map[string]store.SessionUploadRecord{}, chunks: map[string][]store.SessionUploadChunk{}, resources: map[string]store.SessionResourceRecord{}, references: map[store.SessionResourceReference]bool{}, leases: map[string]store.SessionResourceLease{}}
	files := &imageRuleStorage{Storage: storage, free: 1 << 45, total: 1 << 46}
	engine := NewEngine(files)
	engine.Origin = "https://daynight.cc"
	owner := uuid.NewString()
	p := model.Principal{UserID: owner, CredentialID: uuid.NewString(), Kind: model.PATCredential}
	native := "native"
	now := time.Now()
	expiry := now.Add(time.Hour)
	r := &record{Owner: owner, Live: &liveSession{Synced: true}, LastSeen: &now, ConnectionExpiry: &expiry, Snapshot: sp.Snapshot{ContentRevision: 2, ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), TestExecutionID: uuid.NewString(), ExecutionGeneration: "1"}, ConnectionEpoch: "1"}, Identity: sp.Identity{OwnerUserID: owner, NativeSessionID: &native}, Lifecycle: "active", ConnectionState: "connected", Synchronized: true}}
	historyID := uuid.NewString()
	r.Snapshot.Capabilities.Images = supportedImageRuleCapabilities(&native)
	d.bundle = store.ArchiveBundle{SessionID: r.Snapshot.SessionID, Phase: "active", HistoryID: historyID, Ledger: encode(archiveLedger{HistoryID: historyID, HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: "0", Sealable: true})}
	s := &Execution{Engine: engine}
	s.browserRun = func(ctx context.Context, actor model.Principal, _, _, id string, _ BrowserPurpose, fn func(*Access) error) error {
		if e := ctx.Err(); e != nil {
			return e
		}
		if actor.UserID != owner || id != r.Snapshot.SessionID {
			return denied()
		}
		return fn(&Access{tx: &operationTx{dao: d, op: &Operation{}}, record: r, write: true})
	}
	s.archiveRun = func(ctx context.Context, actor model.Principal, project, task, id string, finalize bool, fn func(*Access) error) error {
		if finalize {
			t.Fatal("resource reader requested owner finalization access")
		}
		return s.browserRun(ctx, actor, project, task, id, BrowserAccess, fn)
	}
	engine.SetMediaLeaseCleanup(func(_ context.Context, id, lease string) error {
		return d.ReleaseSessionResourceLease(context.Background(), id, lease)
	})
	engine.SetImageDecoder(func(ctx context.Context, input io.Reader, size int64, digest string) (sp.ValidatedImage, error) {
		data, e := io.ReadAll(input)
		if e != nil {
			return sp.ValidatedImage{}, e
		}
		if !bytes.Equal(data, raw) || int64(len(data)) != size || imageBytesHash(data) != digest {
			return sp.ValidatedImage{}, errors.New("invalid controlled original")
		}
		return sp.ValidatedImage{MediaType: "image/png", ByteLength: decimal(size), SHA256: digest, Width: 2, Height: 3, FrameCount: 1}, nil
	})
	spec := sp.ImageUploadSpec{UploadID: uuid.NewString(), ImageID: uuid.NewString(), Target: sp.ImageTarget{ServerOrigin: engine.Origin, ActorUserID: owner, Fence: r.Snapshot.Fence, ExpectedNativeSessionID: &native}, Name: "image.png", MediaType: "image/png", ByteLength: decimal(int64(len(raw))), SHA256: imageBytesHash(raw)}
	return imageRuleFixture{s, d, r, p, spec, files}
}
func (f imageRuleFixture) prepare(t *testing.T) sp.ImageUploadReceipt {
	t.Helper()
	u, created, e := f.s.prepareUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec, false)
	if e != nil || !created {
		t.Fatalf("prepare: %+v %v %v", u, created, e)
	}
	return u
}
func (f imageRuleFixture) write(t *testing.T, raw []byte, offset int64) (sp.ImageUploadReceipt, error) {
	t.Helper()
	return f.s.writeUploadChunk(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID, sp.ImageChunkWrite{UploadID: f.spec.UploadID, Offset: decimal(offset), SHA256: imageBytesHash(raw), Data: base64.StdEncoding.EncodeToString(raw)}, false)
}
func (f imageRuleFixture) complete(t *testing.T) (sp.ImageUploadReceipt, error) {
	t.Helper()
	return f.s.completeUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID, sp.ImageUploadComplete{SHA256: f.spec.SHA256, ByteLength: f.spec.ByteLength}, false)
}

func TestImageUploadRulesPublishOnlyVerifiedDurableOriginal(t *testing.T) {
	raw := bytes.Repeat([]byte("image"), 110000)
	f := newImageRuleFixture(t, raw)
	first := f.prepare(t)
	if retry, created, e := f.s.prepareUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec, false); e != nil || created || retry.ExpiresAt != first.ExpiresAt {
		t.Fatal("same prepare did not retain original identity/TTL", retry, created, e)
	}
	changed := f.spec
	changed.Name = "other"
	if _, _, e := f.s.prepareUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, changed, false); e == nil {
		t.Fatal("conflicting identity accepted")
	}
	if _, e := f.write(t, raw[imageChunkBytes:], imageChunkBytes); e == nil {
		t.Fatal("noncontiguous first chunk accepted")
	}
	if _, e := f.write(t, raw[:imageChunkBytes], 0); e != nil {
		t.Fatal(e)
	}
	if _, e := f.write(t, raw[:imageChunkBytes], 0); e != nil {
		t.Fatal("identical chunk retry", e)
	}
	if _, e := f.write(t, []byte("changed"), 0); e == nil {
		t.Fatal("changed chunk identity accepted")
	}
	if _, e := f.complete(t); e == nil {
		t.Fatal("incomplete original published")
	}
	if _, e := f.write(t, raw[imageChunkBytes:], imageChunkBytes); e != nil {
		t.Fatal(e)
	}
	f.files.beforePut = func(path string) {
		if len(f.d.resources) != 0 {
			t.Fatal("available descriptor preceded file publication")
		}
	}
	receipt, e := f.complete(t)
	if e != nil || receipt.State != "complete" || receipt.Resource == nil {
		t.Fatalf("complete %+v %v", receipt, e)
	}
	if len(f.d.leases) != 0 || !f.d.uploads[f.spec.UploadID].StorageReleased {
		t.Fatal("I/O lease or staging reservation retained after completed cleanup")
	}
	f.files.beforePut = nil
	retry, e := f.complete(t)
	if e != nil || retry.Resource.ResourceID != receipt.Resource.ResourceID {
		t.Fatal("completed retry changed resource identity", retry, e)
	}
	data, descriptor, e := f.s.savedResource(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, receipt.Resource.ResourceID)
	if e != nil || !bytes.Equal(data, raw) || descriptor.Width == nil || *descriptor.Width != 2 {
		t.Fatal("persistent reader did not consume saved original", e)
	}
	chunk, e := f.s.ReadResource(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, sp.ImageReadRequest{ResourceID: descriptor.ResourceID, Offset: "524288", Limit: imageChunkBytes})
	if e != nil || !chunk.EOF || chunk.Offset != "524288" {
		t.Fatal("reader chunk", chunk, e)
	}
	pin := store.SessionResourceReference{SessionID: f.r.Snapshot.SessionID, ResourceID: descriptor.ResourceID, Kind: "unknown", ReferenceID: uuid.NewString()}
	f.d.references[pin] = true
	if _, e = f.s.ReleaseUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID); e == nil {
		t.Fatal("release removed unknown pin")
	}
	delete(f.d.references, pin)
	if receipt, e = f.s.ReleaseUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID); e != nil || receipt.State != "released" {
		t.Fatal("release", receipt, e)
	}
}
func TestImageAdmissionExpiryAndFailureRetainFacts(t *testing.T) {
	for _, kind := range []string{"actor", "origin", "native", "fence", "revision", "space", "bytes", "resources", "identities", "deleting", "frozen"} {
		t.Run(kind, func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("image"))
			switch kind {
			case "actor":
				f.spec.Target.ActorUserID = uuid.NewString()
			case "origin":
				f.spec.Target.ServerOrigin = "https://other.invalid"
			case "native":
				n := "other"
				f.spec.Target.ExpectedNativeSessionID = &n
			case "fence":
				f.spec.Target.Fence.ExecutionGeneration = "2"
			case "revision":
				f.r.Snapshot.ContentRevision = 0
			case "space":
				f.files.free = 1
			case "bytes":
				f.d.usage.Bytes = sp.MaxSessionResourceBytes
			case "resources":
				f.d.usage.Resources = sp.MaxSessionResources
			case "identities":
				f.d.usage.UploadIdentities = sp.MaxUploadIdentities
			case "deleting":
				f.d.usage.Deleting = true
			case "frozen":
				f.d.usage.Frozen = true
			}
			if _, _, e := f.s.prepareUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec, false); e == nil {
				t.Fatal("invalid admission accepted")
			}
			if len(f.d.uploads) != 0 {
				t.Fatal("failed admission wrote a ledger row")
			}
		})
	}
	t.Run("expired staging is reclaimed after actual deletion", func(t *testing.T) {
		f := newImageRuleFixture(t, []byte("image"))
		f.prepare(t)
		if _, e := f.write(t, []byte("image"), 0); e != nil {
			t.Fatal(e)
		}
		f.s.now = func() time.Time { return time.Now().Add(25 * time.Hour) }
		receipt, e := f.s.GetUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID)
		if e != nil || receipt.State != "expired" || !f.d.uploads[f.spec.UploadID].StorageReleased {
			t.Fatal("expiry cleanup", receipt, e)
		}
		if _, e = f.complete(t); e == nil {
			t.Fatal("expired upload completed")
		}
	})
	t.Run("uncertain chunk commit reuses exact published identity", func(t *testing.T) {
		raw := []byte("image")
		f := newImageRuleFixture(t, raw)
		f.prepare(t)
		f.d.failChunk = true
		if _, e := f.write(t, raw, 0); e == nil {
			t.Fatal("unknown commit hidden")
		}
		if len(f.d.resources) != 0 || f.d.uploads[f.spec.UploadID].Receipt.AcceptedOffset != "0" {
			t.Fatal("unknown became available")
		}
		f.d.failChunk = false
		if _, e := f.write(t, raw, 0); e != nil {
			t.Fatal("same chunk reconciliation", e)
		}
		if _, e := f.complete(t); e != nil {
			t.Fatal(e)
		}
	})
	t.Run("independent decoder failure never publishes resource", func(t *testing.T) {
		f := newImageRuleFixture(t, []byte("image"))
		f.prepare(t)
		if _, e := f.write(t, []byte("image"), 0); e != nil {
			t.Fatal(e)
		}
		f.s.SetImageDecoder(func(context.Context, io.Reader, int64, string) (sp.ValidatedImage, error) {
			return sp.ValidatedImage{}, errors.New("decoder failed")
		})
		if _, e := f.complete(t); e == nil || len(f.d.resources) != 0 || len(f.d.leases) != 0 {
			t.Fatal("decode failure published or retained lease", e)
		}
	})
}

type imageCanceledPut struct {
	filestorage.Storage
	entered chan struct{}
}

func (s imageCanceledPut) Put(ctx context.Context, bucket, path string, input io.Reader) (filestorage.FileInfo, error) {
	close(s.entered)
	<-ctx.Done()
	return filestorage.FileInfo{}, ctx.Err()
}
func TestImageDeletionCancellationWaitsForActualIOExit(t *testing.T) {
	raw := []byte("image")
	f := newImageRuleFixture(t, raw)
	f.prepare(t)
	entered := make(chan struct{})
	f.s.files = imageCanceledPut{Storage: f.files, entered: entered}
	done := make(chan error, 1)
	go func() { _, e := f.write(t, raw, 0); done <- e }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("writer did not reach storage")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if e := f.s.CancelSessionMedia(ctx, f.r.Snapshot.SessionID); e != nil {
		t.Fatal(e)
	}
	select {
	case e := <-done:
		if !errors.Is(e, context.Canceled) {
			t.Fatal("writer cancellation lost", e)
		}
	case <-time.After(time.Second):
		t.Fatal("cancel returned before writer joined")
	}
	if len(f.d.leases) != 0 || len(f.d.resources) != 0 {
		t.Fatal("canceled writer retained lease or published resource")
	}
	if e := f.s.Stop(ctx); e != nil {
		t.Fatal("stopped engine retained admitted image work", e)
	}
}

func TestImageUploadRemoteValidationBudgetAndOriginalRelease(t *testing.T) {
	raw := bytes.Repeat([]byte("image"), 110000)
	f := newImageRuleFixture(t, raw)
	tx := &operationTx{dao: f.d}
	if e := f.s.refreshImageState(t.Context(), tx, f.r, nil); e != nil {
		t.Fatal(e)
	}
	initialRevision := f.r.Snapshot.Capabilities.Images.Revision
	if e := f.s.refreshImageState(t.Context(), tx, f.r, nil); e != nil || f.r.Snapshot.Capabilities.Images.Revision != initialRevision {
		t.Fatal("unchanged capability revision advanced", e)
	}
	f.r.Snapshot.Capabilities.Images = supportedImageRuleCapabilities(f.r.Snapshot.Identity.NativeSessionID)
	f.prepare(t)
	reservedRevision := f.r.Snapshot.ImageBudget.Revision
	if f.r.Snapshot.ImageBudget.ReservedBytes != f.spec.ByteLength {
		t.Fatal("prepare did not publish reserved budget")
	}
	f.d.respond = func(row store.SessionMediaRequest) store.SessionMediaRequest {
		row.Complete = true
		switch row.Action {
		case "prepare", "write":
			row.Result = encode(sp.LocalImagePreparation{UploadID: f.spec.UploadID, ImageID: f.spec.ImageID, Target: f.spec.Target, State: "receiving", AcceptedOffset: "0"})
		case "release":
			row.Result = encode(sp.LocalImagePreparation{UploadID: f.spec.UploadID, ImageID: f.spec.ImageID, Target: f.spec.Target, State: "released", AcceptedOffset: f.spec.ByteLength})
		case "complete":
			row.Result = encode(sp.LocalImagePreparation{UploadID: f.spec.UploadID, ImageID: f.spec.ImageID, Target: f.spec.Target, State: "validated", AcceptedOffset: f.spec.ByteLength, Validated: &sp.ValidatedImage{MediaType: f.spec.MediaType, ByteLength: f.spec.ByteLength, SHA256: f.spec.SHA256, Width: 2, Height: 3, FrameCount: 1}})
		default:
			t.Fatalf("unexpected media action %s", row.Action)
		}
		return row
	}
	for offset := 0; offset < len(raw); offset += imageChunkBytes {
		if _, e := f.write(t, raw[offset:min(offset+imageChunkBytes, len(raw))], int64(offset)); e != nil {
			t.Fatal(e)
		}
	}
	receipt, e := f.s.CompleteUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID, sp.ImageUploadComplete{SHA256: f.spec.SHA256, ByteLength: f.spec.ByteLength})
	if e != nil || receipt.State != "complete" {
		t.Fatalf("remote completion %+v %v", receipt, e)
	}
	if f.r.Snapshot.ImageBudget.ReservedBytes != "0" || f.r.Snapshot.ImageBudget.CommittedBytes != f.spec.ByteLength || number(f.r.Snapshot.ImageBudget.Revision) <= number(reservedRevision) {
		t.Fatal("complete budget was stale")
	}
	// A later component outage cannot make the already durable original unreadable.
	f.s.SetImageDecoder(nil)
	read, _, e := f.s.Resource(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, receipt.Resource.ResourceID)
	if e != nil || !bytes.Equal(read, raw) {
		t.Fatal("decoder absence hid durable resource", e)
	}
	if _, e = f.s.ReleaseUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID); e != nil {
		t.Fatal(e)
	}
	if row, ok := f.d.media[mediaIdentity(f.spec.UploadID, "release")]; !ok || !row.Complete {
		t.Fatal("original controller preparation was not released")
	}
	if len(f.d.media) != 5 {
		t.Fatalf("request identity count %d", len(f.d.media))
	}
	if _, e = f.s.ReleaseUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID); e != nil || len(f.d.media) != 5 {
		t.Fatal("release retry changed request identity", e)
	}
}

func TestImageValidationRejectionAndUnknownHaveDistinctReceipts(t *testing.T) {
	for _, known := range []bool{false, true} {
		t.Run(map[bool]string{false: "unknown", true: "definite rejection"}[known], func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("image"))
			f.prepare(t)
			if _, e := f.write(t, []byte("image"), 0); e != nil {
				t.Fatal(e)
			}
			f.s.SetImageDecoder(func(context.Context, io.Reader, int64, string) (sp.ValidatedImage, error) {
				if known {
					return sp.ValidatedImage{}, fault("image_decode_failed", "Invalid image original.")
				}
				return sp.ValidatedImage{}, context.DeadlineExceeded
			})
			if _, e := f.complete(t); e == nil {
				t.Fatal("failure hidden")
			}
			row := f.d.uploads[f.spec.UploadID]
			if known && (row.Receipt.State != "failed" || row.Receipt.Error == nil || row.Receipt.Error.Code != "image_decode_failed") {
				t.Fatal("definite rejection not persisted", row.Receipt)
			}
			if !known && (row.Receipt.State != "verifying" || row.Receipt.Error != nil) {
				t.Fatal("unknown downgraded", row.Receipt)
			}
			if len(f.d.resources) != 0 || len(f.d.leases) != 0 {
				t.Fatal("failure leaked publication or I/O lease")
			}
		})
	}
}

func TestImageCaptureCopiesTheOriginalAndReusesAliases(t *testing.T) {
	raw := []byte("image")
	f := newImageRuleFixture(t, raw)
	captureID := uuid.NewString()
	occurrence := sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "content", SourceKey: "native-occurrence-1"}
	request := sp.ImageCaptureRequest{CaptureID: captureID, AttemptID: uuid.NewString(), Occurrence: occurrence, Locator: sp.ImageLocator{Kind: "external", URL: "https://images.example/image.png"}}
	// This test uses the real storage reader/writer with a controlled controller
	// transport; it establishes capture and alias semantics, not native projection.
	f.d.bundle.Ledger = encode(archiveLedger{HistoryID: f.d.bundle.HistoryID, HistoryEpoch: f.r.Snapshot.HistoryEpoch, SourceThrough: "0", Sealable: false, Occurrences: []archiveLedgerOccurrence{{EntryID: occurrence.EntryID, ImageID: occurrence.ImageID, Container: occurrence.Container}}})
	tx := &operationTx{dao: f.d, op: &Operation{}}
	msg := sp.ControllerMessage{ControllerFence: f.r.Snapshot.ControllerFence, RequestID: uuid.NewString(), Action: "register", MediaBody: encode(request)}
	out, e := f.s.captureMessage(t.Context(), tx, f.r, msg)
	if e != nil {
		t.Fatal("register", e)
	}
	reserved := out["result"].(sp.ImageCaptureReceipt)
	validated := sp.ValidatedImage{MediaType: "image/png", ByteLength: decimal(int64(len(raw))), SHA256: imageBytesHash(raw), Width: 2, Height: 3, FrameCount: 1}
	msg.Action, msg.MediaBody = "commit", encode(sp.ImageCaptureCommit{CaptureID: captureID, AttemptID: request.AttemptID, Validated: validated})
	if _, e = f.s.captureMessage(t.Context(), tx, f.r, msg); e != nil {
		t.Fatal("commit", e)
	}
	f.d.respond = func(row store.SessionMediaRequest) store.SessionMediaRequest {
		if row.Action != "read_capture" {
			t.Fatal("unexpected capture RPC", row.Action)
		}
		row.Complete = true
		row.Result = encode(sp.PreparedImageChunk{PreparationID: request.AttemptID, ByteLength: validated.ByteLength, SHA256: validated.SHA256, Offset: "0", Data: base64.StdEncoding.EncodeToString(raw), EOF: true})
		return row
	}
	if e = f.s.copyCapture(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.d.captures[captureID]); e != nil {
		t.Fatal("copy", e)
	}
	capture := f.d.captures[captureID]
	if capture.Receipt.State != "committed" || *capture.Receipt.ResourceID != *reserved.ResourceID {
		t.Fatal("capture resource identity changed")
	}
	if n, _ := f.d.SessionResourceReferenceCount(t.Context(), f.r.Snapshot.SessionID, *reserved.ResourceID); n != 1 {
		t.Fatal("synthetic upload pin retained", n)
	}
	alias := request
	alias.CaptureID, alias.Occurrence.ImageID, alias.Occurrence.SourceKey = uuid.NewString(), uuid.NewString(), "native-occurrence-2"
	alias.AttemptID = uuid.NewString()
	alias.Locator = sp.ImageLocator{Kind: "resource", ResourceID: *reserved.ResourceID}
	f.d.bundle.Ledger = encode(archiveLedger{HistoryID: f.d.bundle.HistoryID, HistoryEpoch: f.r.Snapshot.HistoryEpoch, SourceThrough: "0", Sealable: false, Occurrences: []archiveLedgerOccurrence{{EntryID: alias.Occurrence.EntryID, ImageID: alias.Occurrence.ImageID, Container: alias.Occurrence.Container}}})
	msg.Action, msg.MediaBody = "register", encode(alias)
	if _, e = f.s.captureMessage(t.Context(), tx, f.r, msg); e != nil {
		t.Fatal("alias", e)
	}
	if _, e = f.s.ReleaseUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, request.AttemptID); e == nil {
		t.Fatal("capture message reference was released")
	}
	if len(f.d.resources) != 1 || *f.d.captures[alias.CaptureID].Receipt.ResourceID != *reserved.ResourceID {
		t.Fatal("alias copied bytes or changed blob")
	}
	changed := request
	changed.Occurrence.EntryID = "other"
	msg.MediaBody = encode(changed)
	if _, e = f.s.captureMessage(t.Context(), tx, f.r, msg); e == nil {
		t.Fatal("capture identity overwritten")
	}
}

func TestImageMediaReconnectAndResponseKeepOriginalRequest(t *testing.T) {
	f := newImageRuleFixture(t, []byte("image"))
	id := uuid.NewString()
	row := store.SessionMediaRequest{SessionID: f.r.Snapshot.SessionID, RequestID: id, Action: "read", Fence: f.r.Snapshot.ControllerFence, Body: encode(map[string]any{"resourceId": uuid.NewString(), "offset": "0", "limit": 1})}
	f.d.media[id] = row
	f.r.Snapshot.ConnectionEpoch = "2"
	tx := &operationTx{dao: f.d}
	offers, e := f.s.mediaOffers(t.Context(), tx, f.r)
	if e != nil || len(offers) != 1 || offers[0]["requestId"] != id || f.d.media[id].Fence.ConnectionEpoch != "2" {
		t.Fatal("reconnect replaced or dropped request", offers, e)
	}
	old := sp.ControllerMessage{ControllerFence: row.Fence, RequestID: id, Action: row.Action, MediaResult: json.RawMessage(`{"original":"receipt"}`)}
	if _, e = f.s.acceptMediaResponse(t.Context(), tx, f.r, old); e == nil {
		t.Fatal("old epoch completed rebound request")
	}
	old.ControllerFence = f.r.Snapshot.ControllerFence
	if _, e = f.s.acceptMediaResponse(t.Context(), tx, f.r, old); e != nil {
		t.Fatal(e)
	}
	if !f.d.media[id].Complete {
		t.Fatal("media response not durable")
	}
}

func TestImageAdmissionRequiresCurrentCompleteHistory(t *testing.T) {
	f := newImageRuleFixture(t, []byte("image"))
	f.d.bundle.Ledger = encode(archiveLedger{HistoryID: f.d.bundle.HistoryID, HistoryEpoch: f.r.Snapshot.HistoryEpoch, SourceThrough: "0", Sealable: false})
	if _, _, e := f.s.PrepareUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec); e == nil {
		t.Fatal("new image input admitted without resource closure")
	}
	if e := requireImageHistoryLedger(t.Context(), &operationTx{dao: f.d}, f.r, true); e != nil {
		t.Fatal("capture cannot settle a complete metadata checkpoint", e)
	}
	f.r.SourceSeq = 1
	if e := requireImageHistoryLedger(t.Context(), &operationTx{dao: f.d}, f.r, true); e == nil {
		t.Fatal("stale source checkpoint admitted capture")
	}
	f.r.SourceSeq = 0
	f.d.bundle.Ledger = encode(archiveLedger{HistoryID: f.d.bundle.HistoryID, HistoryEpoch: f.r.Snapshot.HistoryEpoch, SourceThrough: "0", Sealable: true})
	if _, _, e := f.s.PrepareUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec); e != nil {
		t.Fatal("current complete checkpoint refused input", e)
	}
}
