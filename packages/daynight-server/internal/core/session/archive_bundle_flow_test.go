package session

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type archiveFlowDAO struct {
	store.SessionDAO
	store.SessionResourceDAO
	store.SessionArchiveDAO
	bundle      *store.ArchiveBundle
	files       map[string]store.ArchiveBundleFile
	chunks      map[string][]store.ArchiveBundleChunk
	resources   map[string]store.SessionResourceRecord
	status      sp.ArchiveStatus
	leases      int
	leaseRows   map[string]store.SessionResourceLease
	migration   *store.ArchiveMigration
	archivePath string
}

func (d *archiveFlowDAO) ListSessionUploadsForSettlement(context.Context, string, time.Time) ([]store.SessionUploadRecord, error) {
	return []store.SessionUploadRecord{}, nil
}
func (d *archiveFlowDAO) MarkSessionResourceReclaim(context.Context, string, string) (bool, error) {
	return false, errors.New("unconfigured archive resource reclamation")
}
func (d *archiveFlowDAO) DeleteReclaimedSessionResource(context.Context, string, string) error {
	return errors.New("unconfigured archive resource reclamation")
}

func (d *archiveFlowDAO) SessionArchiveBundle(context.Context, string) (store.ArchiveBundle, error) {
	if d.bundle == nil {
		return store.ArchiveBundle{}, model.ErrNotFound
	}
	return *d.bundle, nil
}
func (d *archiveFlowDAO) SaveSessionArchiveBundle(_ context.Context, b store.ArchiveBundle) error {
	d.bundle = &b
	return nil
}
func (d *archiveFlowDAO) SessionArchiveFile(_ context.Context, _, id string) (store.ArchiveBundleFile, error) {
	if v, ok := d.files[id]; ok {
		return v, nil
	}
	return store.ArchiveBundleFile{}, model.ErrNotFound
}
func (d *archiveFlowDAO) SaveSessionArchiveFile(_ context.Context, f store.ArchiveBundleFile) error {
	d.files[f.FileID] = f
	return nil
}
func (d *archiveFlowDAO) FailSessionArchiveFile(_ context.Context, expected store.ArchiveBundleFile, resource json.RawMessage) error {
	current, ok := d.files[expected.FileID]
	if !ok || !jsonEqual(encode(current), encode(expected)) || current.State != "receiving" {
		return archiveConflict()
	}
	current.State, current.Resource = "failed", resource
	d.files[current.FileID] = current
	return nil
}
func (d *archiveFlowDAO) InsertSessionArchiveChunk(_ context.Context, c store.ArchiveBundleChunk) error {
	d.chunks[c.FileID] = append(d.chunks[c.FileID], c)
	return nil
}
func (d *archiveFlowDAO) SessionArchiveChunks(_ context.Context, _, id string) ([]store.ArchiveBundleChunk, error) {
	return d.chunks[id], nil
}
func (d *archiveFlowDAO) SessionResourceUsage(context.Context, string) (store.SessionResourceUsage, error) {
	return store.SessionResourceUsage{}, nil
}
func (d *archiveFlowDAO) ListSessionResources(_ context.Context, id string) ([]store.SessionResourceRecord, error) {
	var rows []store.SessionResourceRecord
	for _, row := range d.resources {
		if row.SessionID != id {
			return nil, errors.New("wrong session resource scope")
		}
		rows = append(rows, row)
	}
	return rows, nil
}
func (d *archiveFlowDAO) AcquireSessionResourceLease(_ context.Context, lease store.SessionResourceLease) error {
	d.leases++
	if d.leaseRows == nil {
		d.leaseRows = map[string]store.SessionResourceLease{}
	}
	d.leaseRows[lease.ID] = lease
	return nil
}
func (d *archiveFlowDAO) ReleaseSessionResourceLease(_ context.Context, _, id string) error {
	d.leases--
	delete(d.leaseRows, id)
	return nil
}
func (d *archiveFlowDAO) ListSessionResourceLeases(context.Context, string) ([]store.SessionResourceLease, error) {
	rows := make([]store.SessionResourceLease, 0, len(d.leaseRows))
	for _, lease := range d.leaseRows {
		rows = append(rows, lease)
	}
	return rows, nil
}
func (d *archiveFlowDAO) UnsettledSessionResourceWrites(context.Context, string) (int, error) {
	return 0, nil
}
func (d *archiveFlowDAO) AddSessionResourceReference(context.Context, store.SessionResourceReference) error {
	return nil
}
func (d *archiveFlowDAO) InsertSessionResource(_ context.Context, r store.SessionResourceRecord) error {
	d.resources[r.Resource.ResourceID] = r
	return nil
}
func (d *archiveFlowDAO) SavedSessionResource(_ context.Context, _, id string) (store.SessionResourceRecord, error) {
	r, ok := d.resources[id]
	if !ok {
		return r, model.ErrNotFound
	}
	return r, nil
}
func (d *archiveFlowDAO) SetUnifiedSessionArchiveReady(_ context.Context, _, hash string, size int, path, completeness string) error {
	d.archivePath = path
	length := decimal(int64(size))
	d.status = sp.ArchiveStatus{State: "ready", SchemaVersion: 3, SHA256: &hash, ByteLength: &length, Completeness: &completeness}
	return nil
}

func TestArchiveBundlePublishesOnlyAfterExactTimelineAndBlobClosure(t *testing.T) {
	for _, original := range [][]byte{[]byte("original"), {}} {
		t.Run(decimal(int64(len(original))), func(t *testing.T) {
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer files.Close()
			engine := NewEngine(&imageRuleStorage{Storage: files, free: 1 << 45, total: 1 << 46})
			d := &archiveFlowDAO{files: map[string]store.ArchiveBundleFile{}, chunks: map[string][]store.ArchiveBundleChunk{}, resources: map[string]store.SessionResourceRecord{}}
			owner, session, claim, controller, instance := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			p := model.Principal{Kind: model.PATCredential, UserID: owner}
			fence := sp.Fence{SessionID: session, ClaimID: claim, ExecutionGeneration: "1"}
			r := &record{Owner: owner, SourceSeq: 7, Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: fence}, Identity: sp.Identity{ControllerID: controller, ControllerInstanceID: instance, Provider: "codex"}, Lifecycle: "archived", HistoryEpoch: "original-history"}}
			execution := &Execution{Engine: engine}
			execution.archiveRun = func(ctx context.Context, principal model.Principal, _, _, id string, finalize bool, work func(*Access) error) error {
				if principal != p || id != session || !finalize {
					t.Fatal("wrong archive scope")
				}
				return work(&Access{tx: &operationTx{dao: d}, record: r})
			}
			engine.SetMediaLeaseCleanup(func(ctx context.Context, id, lease string) error {
				return d.ReleaseSessionResourceLease(ctx, id, lease)
			})
			op := &ArchiveOperation{execution: execution, principal: p, id: session, owner: owner, mode: ArchiveV1Upload}
			ctx := t.Context()
			prepared, err := op.PrepareArchive(ctx, sp.ArchivePrepareRequest{Fence: fence, ControllerID: controller, ControllerInstanceID: instance})
			if err != nil || prepared.SourceThrough != "7" || prepared.HistoryEpoch != "original-history" {
				t.Fatal(prepared, err)
			}
			if _, err = op.SealArchive(ctx); err == nil {
				t.Fatal("sealed before complete history")
			}
			id := uuid.NewString()
			length, hash, mime := decimal(int64(len(original))), archiveDigest(original), "text/plain"
			resource := sp.Resource{ResourceID: id, Status: "available", Name: "legacy", MediaType: &mime, ByteLength: &length, SHA256: &hash}
			entry, err := sp.DecodeTimeline([]byte(`{"entryId":"` + uuid.NewString() + `","entrySeq":"1","revision":"1","kind":"assistant_message","content":[{"type":"resource","resourceId":"` + id + `","label":"legacy"}]}`))
			if err != nil {
				t.Fatal(err)
			}
			history := encode(sp.ArchiveHistoryContent{HistoryEpoch: "original-history", SourceThrough: "7", Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{resource}})
			historyID := uuid.NewString()
			half := len(history) / 2
			first, err := op.PutArchiveFile(ctx, "history", historyID, 0, int64(len(history)), archiveDigest(history), archiveDigest(history[:half]), history[:half])
			if err != nil || first.State != "receiving" {
				t.Fatal(first, err)
			}
			if _, err = op.PutArchiveFile(ctx, "history", historyID, 1, int64(len(history)), archiveDigest(history), archiveDigest(history[:half]), history[:half]); err == nil {
				t.Fatal("overlapping chunk accepted")
			}
			if _, err = op.PutArchiveFile(ctx, "history", historyID, 0, int64(len(history)), archiveDigest(history), archiveDigest(history[:half]), history[:half]); err != nil {
				t.Fatal("exact retry", err)
			}
			last, err := op.PutArchiveFile(ctx, "history", historyID, int64(half), int64(len(history)), archiveDigest(history), archiveDigest(history[half:]), history[half:])
			if err != nil || last.State != "complete" {
				t.Fatal(last, err)
			}
			if _, err = op.SealArchive(ctx); !errors.Is(err, model.ErrNotFound) {
				t.Fatal("missing available original must block seal", err)
			}
			blobID := uuid.NewString()
			saved, err := op.PutArchiveResource(ctx, blobID, 0, int64(len(original)), hash, hash, original, resource)
			if err != nil || saved.State != "complete" {
				t.Fatal(saved, err)
			}
			if retry, err := op.PutArchiveResource(ctx, blobID, 0, int64(len(original)), hash, hash, original, resource); err != nil || !reflect.DeepEqual(retry, saved) {
				t.Fatal("original resource retry", retry, err)
			}
			sealed, err := op.SealArchive(ctx)
			if err != nil || sealed.Phase != "sealed" || len(sealed.Resources) != 1 {
				t.Fatal(sealed, err)
			}
			timeline := encode(sp.ArchiveTimeline{Entries: []sp.TimelineEntry{entry}})
			fileID := uuid.NewString()
			reference := sp.ArchiveFileReference{FileID: fileID, SHA256: archiveDigest(timeline), ByteLength: decimal(int64(len(timeline)))}
			manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentKind: "native_timeline", RecordID: session, Fence: fence, Provider: "codex", ControllerID: controller, ControllerInstanceID: instance, Timeline: reference, Resources: sealed.Resources, Completeness: "complete"}
			body := encode(manifest)
			if _, err = op.PutArchiveManifest(ctx, body); err == nil {
				t.Fatal("manifest accepted before timeline")
			}
			receipt, err := op.PutArchiveFile(ctx, "timeline", fileID, 0, int64(len(timeline)), reference.SHA256, reference.SHA256, timeline)
			if err != nil || receipt.State != "complete" {
				t.Fatal(receipt, err)
			}
			status, err := op.PutArchiveManifest(ctx, body)
			if err != nil || status.State != "ready" || status.SchemaVersion != 3 || d.leases != 0 {
				t.Fatal(status, err, d.leases)
			}
			encoded, err := json.Marshal(status)
			if err != nil || !json.Valid(encoded) {
				t.Fatal(string(encoded), err)
			}
			if _, err = op.PutArchiveManifest(ctx, body); err != nil {
				t.Fatal("original commit retry", err)
			}
			manifest.Completeness = "partial"
			if _, err = op.PutArchiveManifest(ctx, encode(manifest)); err == nil {
				t.Fatal("different manifest replaced original")
			}
			if err = files.Delete(ctx, "session-resources", d.resources[id].BlobPath); err != nil {
				t.Fatal(err)
			}
			if _, err = op.PutArchiveManifest(ctx, body); err == nil {
				t.Fatal("known available missing blob became partial/ready")
			}
		})
	}
}

func (d *archiveFlowDAO) SessionArchive(context.Context, string) (sp.ArchiveStatus, string, error) {
	return d.status, d.archivePath, nil
}
func (d *archiveFlowDAO) SessionArchiveMigration(context.Context, string) (store.ArchiveMigration, error) {
	if d.migration == nil {
		return store.ArchiveMigration{}, model.ErrNotFound
	}
	return *d.migration, nil
}
func (d *archiveFlowDAO) SaveSessionArchiveMigration(_ context.Context, value store.ArchiveMigration) error {
	d.migration = &value
	return nil
}

func TestLegacyArchiveMigrationKeepsOriginalBytesAndVerifiesNewClosure(t *testing.T) {
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	engine := NewEngine(&imageRuleStorage{Storage: files, free: 1 << 45, total: 1 << 46})
	d := &archiveFlowDAO{files: map[string]store.ArchiveBundleFile{}, chunks: map[string][]store.ArchiveBundleChunk{}, resources: map[string]store.SessionResourceRecord{}}
	owner, id, claim := uuid.NewString(), uuid.NewString(), uuid.NewString()
	p := model.Principal{Kind: model.PATCredential, UserID: owner}
	fence := sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}
	original := []byte("old original")
	encoded := base64.StdEncoding.EncodeToString(original)
	length, hash, mime := decimal(int64(len(original))), archiveDigest(original), "text/plain"
	resource := sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "legacy", ByteLength: &length, SHA256: &hash, MediaType: &mime}
	entry, e := sp.DecodeTimeline([]byte(`{"entryId":"` + uuid.NewString() + `","entrySeq":"1","revision":"1","kind":"assistant_message","content":[{"type":"resource","resourceId":"` + resource.ResourceID + `","label":"legacy"}]}`))
	if e != nil {
		t.Fatal(e)
	}
	document := sp.ArchiveDocument{SchemaVersion: 1, Fence: fence, ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", Entries: []sp.TimelineEntry{entry}, Resources: []sp.ArchiveResource{{Resource: resource, Data: &encoded}}}
	source := encode(document)
	digest, size := archiveDigest(source), decimal(int64(len(source)))
	path, e := archiveObjectPath("", owner, id, digest)
	if e != nil {
		t.Fatal(e)
	}
	d.status = sp.ArchiveStatus{State: "ready", SHA256: &digest, ByteLength: &size}
	d.archivePath = path
	if _, e = files.Put(t.Context(), archiveBucket, path, bytes.NewReader(source)); e != nil {
		t.Fatal(e)
	}
	r := &record{Owner: owner, SourceSeq: 7, Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: fence}, HistoryEpoch: "original-history", Lifecycle: "archived"}}
	execution := &Execution{Engine: engine}
	execution.archiveRun = func(ctx context.Context, _ model.Principal, _, _, _ string, _ bool, work func(*Access) error) error {
		return work(&Access{tx: &operationTx{dao: d}, record: r})
	}
	engine.SetMediaLeaseCleanup(func(ctx context.Context, id, lease string) error {
		return d.ReleaseSessionResourceLease(ctx, id, lease)
	})
	op := &ArchiveOperation{execution: execution, principal: p, id: id, owner: owner, mode: ArchiveV1Read}
	manifestBytes, e := execution.migrateLegacyArchive(t.Context(), op, source, path)
	if e != nil {
		t.Fatal(e)
	}
	manifest, e := sp.DecodeArchiveManifest(manifestBytes)
	if e != nil {
		t.Fatal(e)
	}
	if manifest.Fence != fence || manifest.Resources[0].Resource.ResourceID != resource.ResourceID || d.migration == nil || d.migration.Phase != "verified" || d.status.SchemaVersion != 3 || d.leases != 0 {
		t.Fatal(manifest, d.migration, d.status, d.leases)
	}
	old, e := files.Open(t.Context(), archiveBucket, path)
	if e != nil {
		t.Fatal("source removed", e)
	}
	preserved, e := io.ReadAll(old.Body)
	old.Body.Close()
	if e != nil || !bytes.Equal(preserved, source) {
		t.Fatal("source bytes changed", e)
	}
	retried, e := execution.migrateLegacyArchive(t.Context(), op, source, path)
	if e != nil || !bytes.Equal(retried, manifestBytes) {
		t.Fatal("migration identity changed", e)
	}
}

func (d *archiveFlowDAO) SessionResourceLeaseCount(context.Context, string) (int, error) {
	return d.leases, nil
}
func (d *archiveFlowDAO) SessionArchiveFiles(context.Context, string) ([]store.ArchiveBundleFile, error) {
	out := []store.ArchiveBundleFile{}
	for _, f := range d.files {
		out = append(out, f)
	}
	return out, nil
}
func (d *archiveFlowDAO) RemoveSessionResourceReference(context.Context, store.SessionResourceReference) error {
	return nil
}

func archiveFlowFixture(t *testing.T) (*ArchiveOperation, *archiveFlowDAO, *record) {
	t.Helper()
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	engine := NewEngine(&imageRuleStorage{Storage: files, free: 1 << 45, total: 1 << 46})
	d := &archiveFlowDAO{files: map[string]store.ArchiveBundleFile{}, chunks: map[string][]store.ArchiveBundleChunk{}, resources: map[string]store.SessionResourceRecord{}}
	owner, id, claim, controller, instance := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	p := model.Principal{Kind: model.PATCredential, UserID: owner}
	fence := sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}
	r := &record{Owner: owner, SourceSeq: 7, Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: fence}, Identity: sp.Identity{ControllerID: controller, ControllerInstanceID: instance, Provider: "codex"}, Lifecycle: "archived", HistoryEpoch: "original-history"}}
	execution := &Execution{Engine: engine}
	execution.archiveRun = func(ctx context.Context, principal model.Principal, _, _, session string, _ bool, work func(*Access) error) error {
		if principal != p || session != id {
			t.Fatal("wrong scope")
		}
		return work(&Access{tx: &operationTx{dao: d}, record: r})
	}
	engine.SetMediaLeaseCleanup(func(ctx context.Context, id, lease string) error {
		return d.ReleaseSessionResourceLease(ctx, id, lease)
	})
	op := &ArchiveOperation{execution: execution, principal: p, id: id, owner: owner, mode: ArchiveV1Upload}
	if _, err = op.PrepareArchive(t.Context(), sp.ArchivePrepareRequest{Fence: fence, ControllerID: controller, ControllerInstanceID: instance}); err != nil {
		t.Fatal(err)
	}
	return op, d, r
}

func TestArchiveHistoryRecoveryAdvancesOnlySameStoppedProjection(t *testing.T) {
	op, d, r := archiveFlowFixture(t)
	id, part := uuid.NewString(), uuid.NewString()
	// The complete source text is known while the image projection is unresolved.
	original := []byte(`{"entryId":"` + id + `","entrySeq":"1","revision":"1","kind":"assistant_message","imageProjectionError":{"code":"source_unavailable","message":"Projection pending."},"content":[{"type":"text","text":"source"},{"type":"markdown","partId":"` + part + `","revision":"1","text":"","textSha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","complete":true,"truncated":false,"bindings":[],"retainedImages":[]}]}`)
	entry, err := sp.DecodeTimeline(original)
	if err != nil {
		t.Fatal(err)
	}
	history := func(entry sp.TimelineEntry) []byte {
		return encode(sp.ArchiveHistoryContent{HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: "7", Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{}})
	}
	firstID := uuid.NewString()
	first := history(entry)
	receipt, err := op.PutArchiveFile(t.Context(), "history", firstID, 0, int64(len(first)), archiveDigest(first), archiveDigest(first), first)
	if err != nil || receipt.State != "complete" || *receipt.TimelineRevision != "1" {
		t.Fatal(receipt, err)
	}
	if _, err = op.SealArchive(t.Context()); err == nil {
		t.Fatal("incomplete projection sealed")
	}
	corrected, err := sp.DecodeTimeline(bytes.ReplaceAll(bytes.ReplaceAll(original, []byte(`"imageProjectionError":{"code":"source_unavailable","message":"Projection pending."}`), []byte(`"imageProjectionError":null`)), []byte(`"revision":"1"`), []byte(`"revision":"2"`)))
	if err != nil {
		t.Fatal(err)
	}
	secondID := uuid.NewString()
	second := history(corrected)
	receipt, err = op.PutArchiveFile(t.Context(), "history", secondID, 0, int64(len(second)), archiveDigest(second), archiveDigest(second), second)
	if err != nil || receipt.State != "complete" || *receipt.TimelineRevision != "2" {
		t.Fatal(receipt, err)
	}
	if _, err = op.PutArchiveFile(t.Context(), "history", firstID, 0, int64(len(first)), archiveDigest(first), archiveDigest(first), first); err == nil {
		t.Fatal("late old round replaced current")
	}
	sealed, err := op.SealArchive(t.Context())
	if err != nil || sealed.Phase != "sealed" || *sealed.TimelineRevision != "2" {
		t.Fatal(sealed, err)
	}
	if d.leases != 0 {
		t.Fatal("writer lease retained", d.leases)
	}
}

func TestArchiveDefiniteFailureRequiresExactStoppedReset(t *testing.T) {
	op, d, r := archiveFlowFixture(t)
	ctx := t.Context()
	history := encode(sp.ArchiveHistoryContent{HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: "7", Entries: []sp.TimelineEntry{}, Resources: []sp.Resource{}})
	historyID := uuid.NewString()
	if _, err := op.PutArchiveFile(ctx, "history", historyID, 0, int64(len(history)), archiveDigest(history), archiveDigest(history), history); err != nil {
		t.Fatal(err)
	}
	if _, err := op.SealArchive(ctx); err != nil {
		t.Fatal(err)
	}
	bad := []byte(`{"entries":[`)
	fileID := uuid.NewString()
	if _, err := op.PutArchiveFile(ctx, "timeline", fileID, 0, int64(len(bad)), archiveDigest(bad), archiveDigest(bad), bad); err == nil {
		t.Fatal("invalid timeline accepted")
	}
	if d.files[fileID].State != "failed" || d.bundle.Phase != "failed" {
		t.Fatal("definite failure not durable", d.files[fileID], d.bundle)
	}
	input := sp.ArchivePrepareRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID, ExpectedTimelineRevision: "1", FailedFileID: fileID}
	d.leases = 1
	if _, err := op.PrepareArchive(ctx, input); err == nil {
		t.Fatal("active writer reset")
	}
	d.leases = 0
	wrong := input
	wrong.ExpectedTimelineRevision = "2"
	if _, err := op.PrepareArchive(ctx, wrong); err == nil {
		t.Fatal("wrong revision reset")
	}
	receipt, err := op.PrepareArchive(ctx, input)
	if err != nil || receipt.Phase != "settling" || d.bundle.Revision != 2 || d.files[fileID].State != "failed" {
		t.Fatal(receipt, err)
	}
	if _, err = op.SealArchive(ctx); err != nil {
		t.Fatal(err)
	}
	next := []byte(`{"entries":[]}`)
	nextID := uuid.NewString()
	if _, err = op.PutArchiveFile(ctx, "timeline", nextID, 0, int64(len(next)), archiveDigest(next), archiveDigest(next), next); err != nil {
		t.Fatal(err)
	}
	if _, err = op.PrepareArchive(ctx, input); err == nil {
		t.Fatal("stale reset accepted")
	}
}

func TestSealChecksNewUnavailableDescriptorBeforeSaving(t *testing.T) {
	op, d, r := archiveFlowFixture(t)
	descriptor := sp.Resource{ResourceID: uuid.NewString(), Status: "unavailable", Name: "missing"}
	historyID := uuid.NewString()
	ledger := archiveLedger{HistoryID: historyID, HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: "7", Sealable: true, Entries: []archiveLedgerEntry{{ByteLength: int(MaxSessionContentBytes - 1000)}}, Resources: []sp.Resource{descriptor}}
	cost, err := measureContent(contentState{ledger: &ledger, resources: []sp.Resource{descriptor}})
	if err != nil {
		t.Fatal(err)
	}
	ledger.Entries[0].ByteLength += int(MaxSessionContentBytes - cost.TimelineBytes - cost.IndexBytes - cost.ResourceMetadataBytes + 1)
	d.bundle.HistoryID, d.bundle.Ledger = historyID, encode(ledger)
	d.files[historyID] = store.ArchiveBundleFile{SessionID: op.id, FileID: historyID, Purpose: "history", State: "complete"}
	var refusal *model.Fault
	if _, err = op.SealArchive(t.Context()); !errors.As(err, &refusal) || refusal.Code != "quota_exceeded" || len(d.resources) != 0 || d.bundle.Phase != "settling" {
		t.Fatal("oversized descriptor was saved", err, d.bundle.Phase, d.resources)
	}
	ledger.Entries[0].ByteLength--
	d.bundle.Ledger = encode(ledger)
	if receipt, err := op.SealArchive(t.Context()); err != nil || receipt.Phase != "sealed" || len(d.resources) != 1 {
		t.Fatal("boundary descriptor was not sealed", receipt, err)
	}
	if _, err = op.SealArchive(t.Context()); err != nil || len(d.resources) != 1 {
		t.Fatal("sealed replay changed descriptors", err)
	}
}
