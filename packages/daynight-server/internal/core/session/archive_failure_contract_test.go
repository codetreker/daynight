package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

var archiveDependencyFailure = errors.New("archive dependency unavailable")

type archiveFailureDAO struct {
	*archiveFlowDAO
	fail string
	seen map[string]int
	at   int
}

func (d *archiveFailureDAO) refusal(kind string) error {
	d.seen[kind]++
	if d.fail == kind && (d.at == 0 || d.seen[kind] == d.at) {
		return archiveDependencyFailure
	}
	return nil
}
func (d *archiveFailureDAO) SessionArchiveBundle(ctx context.Context, id string) (store.ArchiveBundle, error) {
	if e := d.refusal("bundle"); e != nil {
		return store.ArchiveBundle{}, e
	}
	return d.archiveFlowDAO.SessionArchiveBundle(ctx, id)
}
func (d *archiveFailureDAO) SaveSessionArchiveBundle(ctx context.Context, v store.ArchiveBundle) error {
	if e := d.refusal("save-bundle"); e != nil {
		return e
	}
	return d.archiveFlowDAO.SaveSessionArchiveBundle(ctx, v)
}
func (d *archiveFailureDAO) SessionArchiveFile(ctx context.Context, id, file string) (store.ArchiveBundleFile, error) {
	if e := d.refusal("file"); e != nil {
		return store.ArchiveBundleFile{}, e
	}
	return d.archiveFlowDAO.SessionArchiveFile(ctx, id, file)
}
func (d *archiveFailureDAO) SaveSessionArchiveFile(ctx context.Context, v store.ArchiveBundleFile) error {
	if e := d.refusal("save-file"); e != nil {
		return e
	}
	return d.archiveFlowDAO.SaveSessionArchiveFile(ctx, v)
}
func (d *archiveFailureDAO) SessionArchiveChunks(ctx context.Context, id, file string) ([]store.ArchiveBundleChunk, error) {
	if e := d.refusal("chunks"); e != nil {
		return nil, e
	}
	return d.archiveFlowDAO.SessionArchiveChunks(ctx, id, file)
}
func (d *archiveFailureDAO) InsertSessionArchiveChunk(ctx context.Context, v store.ArchiveBundleChunk) error {
	if e := d.refusal("insert-chunk"); e != nil {
		return e
	}
	return d.archiveFlowDAO.InsertSessionArchiveChunk(ctx, v)
}
func (d *archiveFailureDAO) SessionResourceUsage(ctx context.Context, id string) (store.SessionResourceUsage, error) {
	if e := d.refusal("usage"); e != nil {
		return store.SessionResourceUsage{}, e
	}
	return d.archiveFlowDAO.SessionResourceUsage(ctx, id)
}
func (d *archiveFailureDAO) AcquireSessionResourceLease(ctx context.Context, v store.SessionResourceLease) error {
	if e := d.refusal("lease"); e != nil {
		return e
	}
	return d.archiveFlowDAO.AcquireSessionResourceLease(ctx, v)
}
func (d *archiveFailureDAO) SessionResourceLeaseCount(ctx context.Context, id string) (int, error) {
	if e := d.refusal("lease-count"); e != nil {
		return 0, e
	}
	return d.archiveFlowDAO.SessionResourceLeaseCount(ctx, id)
}
func (d *archiveFailureDAO) SessionArchiveFiles(ctx context.Context, id string) ([]store.ArchiveBundleFile, error) {
	if e := d.refusal("files"); e != nil {
		return nil, e
	}
	return d.archiveFlowDAO.SessionArchiveFiles(ctx, id)
}
func (d *archiveFailureDAO) UnsettledSessionResourceWrites(ctx context.Context, id string) (int, error) {
	if e := d.refusal("unsettled"); e != nil {
		return 0, e
	}
	return d.archiveFlowDAO.UnsettledSessionResourceWrites(ctx, id)
}
func (d *archiveFailureDAO) SetUnifiedSessionArchiveReady(ctx context.Context, id, hash string, size int, path, completeness string) error {
	if e := d.refusal("ready"); e != nil {
		return e
	}
	return d.archiveFlowDAO.SetUnifiedSessionArchiveReady(ctx, id, hash, size, path, completeness)
}
func (d *archiveFailureDAO) SavedSessionResource(ctx context.Context, id, resource string) (store.SessionResourceRecord, error) {
	if e := d.refusal("resource"); e != nil {
		return store.SessionResourceRecord{}, e
	}
	return d.archiveFlowDAO.SavedSessionResource(ctx, id, resource)
}
func (d *archiveFailureDAO) InsertSessionResource(ctx context.Context, v store.SessionResourceRecord) error {
	if e := d.refusal("insert-resource"); e != nil {
		return e
	}
	return d.archiveFlowDAO.InsertSessionResource(ctx, v)
}
func (d *archiveFailureDAO) AddSessionResourceReference(ctx context.Context, v store.SessionResourceReference) error {
	if e := d.refusal("reference"); e != nil {
		return e
	}
	return d.archiveFlowDAO.AddSessionResourceReference(ctx, v)
}
func (d *archiveFailureDAO) RemoveSessionResourceReference(ctx context.Context, v store.SessionResourceReference) error {
	if e := d.refusal("remove-reference"); e != nil {
		return e
	}
	return nil
}

func bindArchiveFailureDAO(op *ArchiveOperation, base *archiveFlowDAO, r *record, kind string, at int) *archiveFailureDAO {
	d := &archiveFailureDAO{archiveFlowDAO: base, fail: kind, at: at, seen: map[string]int{}}
	op.execution.archiveRun = func(_ context.Context, _ model.Principal, _, _, _ string, _ bool, work func(*Access) error) error {
		return work(&Access{tx: &operationTx{dao: d}, record: r})
	}
	return d
}

type archiveFailureStorage struct {
	filestorage.Storage
	kind string
}

func (s archiveFailureStorage) Put(ctx context.Context, bucket, path string, in io.Reader) (filestorage.FileInfo, error) {
	if s.kind == "put" {
		return filestorage.FileInfo{}, archiveDependencyFailure
	}
	return s.Storage.Put(ctx, bucket, path, in)
}
func (s archiveFailureStorage) Open(ctx context.Context, bucket, path string) (filestorage.Object, error) {
	if s.kind == "open" {
		return filestorage.Object{}, archiveDependencyFailure
	}
	return s.Storage.Open(ctx, bucket, path)
}
func (s archiveFailureStorage) Delete(ctx context.Context, bucket, path string) error {
	if s.kind == "delete" {
		return archiveDependencyFailure
	}
	return s.Storage.Delete(ctx, bucket, path)
}

func TestArchiveFileTransferRetainsDependencyFailures(t *testing.T) {
	for _, kind := range []string{"bundle", "usage", "file", "save-file", "save-bundle", "lease", "insert-chunk", "chunks"} {
		t.Run(kind, func(t *testing.T) {
			op, base, r := archiveFlowFixture(t)
			d := bindArchiveFailureDAO(op, base, r, kind, 0)
			body := activeHistoryBytes(r, localEntry(t, "1"))
			out, e := op.PutArchiveFile(t.Context(), "history", uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body)
			if !errors.Is(e, archiveDependencyFailure) || out.State == "complete" || d.status.State == "ready" || d.leases != 0 {
				t.Fatal("dependency failure became durable success or leaked a lease", kind, out, e, d.leases)
			}
		})
	}
	for _, at := range []int{2, 3} {
		t.Run("usage-check-"+decimal(int64(at)), func(t *testing.T) {
			op, base, r := archiveFlowFixture(t)
			d := bindArchiveFailureDAO(op, base, r, "usage", at)
			body := activeHistoryBytes(r, localEntry(t, "1"))
			out, e := op.PutArchiveFile(t.Context(), "history", uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body)
			if !errors.Is(e, archiveDependencyFailure) || out.State == "complete" || d.leases != 0 {
				t.Fatal(out, e, d.leases)
			}
		})
	}
}

func TestArchivePreparationAndSealRetainStorageRefusals(t *testing.T) {
	for _, kind := range []string{"bundle", "save-bundle", "lease-count", "files"} {
		t.Run("prepare-"+kind, func(t *testing.T) {
			op, base, r := archiveFlowFixture(t)
			base.bundle = nil
			if kind == "lease-count" || kind == "files" {
				identity := sp.ArchivePrepareRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID}
				base.bundle = &store.ArchiveBundle{SessionID: op.id, Phase: "active", Identity: encode(identity)}
			}
			d := bindArchiveFailureDAO(op, base, r, kind, 0)
			_, e := op.PrepareArchive(t.Context(), sp.ArchivePrepareRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID})
			if !errors.Is(e, archiveDependencyFailure) || d.status.State == "ready" {
				t.Fatal(e)
			}
		})
	}
	for _, kind := range []string{"bundle", "unsettled", "save-bundle"} {
		t.Run("seal-"+kind, func(t *testing.T) {
			op, base, r := archiveFlowFixture(t)
			body := activeHistoryBytes(r, localEntry(t, "1"))
			if _, e := op.PutArchiveFile(t.Context(), "history", uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e != nil {
				t.Fatal(e)
			}
			d := bindArchiveFailureDAO(op, base, r, kind, 0)
			_, e := op.SealArchive(t.Context())
			if !errors.Is(e, archiveDependencyFailure) || d.bundle.Phase == "sealed" {
				t.Fatal(e)
			}
		})
	}
}

func TestArchiveManifestPublicationRetainsFinalCommitRefusals(t *testing.T) {
	for _, kind := range []string{"bundle", "usage", "file", "save-bundle", "lease", "ready"} {
		t.Run(kind, func(t *testing.T) {
			op, base, r := archiveFlowFixture(t)
			publishArchiveRecoveryFixture(t, op, r)
			object, e := op.execution.files.Open(t.Context(), archiveBucket, base.archivePath)
			if e != nil {
				t.Fatal(e)
			}
			body, e := io.ReadAll(object.Body)
			closeErr := object.Body.Close()
			if e != nil || closeErr != nil {
				t.Fatal(e, closeErr)
			}
			base.status = sp.ArchiveStatus{State: "pending"}
			base.bundle.Phase = "sealed"
			d := bindArchiveFailureDAO(op, base, r, kind, 0)
			out, e := op.PutArchiveManifest(t.Context(), body)
			if !errors.Is(e, archiveDependencyFailure) || out.State == "ready" || d.status.State == "ready" || d.leases != 0 {
				t.Fatal("refused manifest became ready", out, e, d.leases)
			}
		})
	}
}

func TestActiveHistoryStatusAndPreparationRequireOriginalRound(t *testing.T) {
	for _, kind := range []string{"original", "missing-file", "wrong-purpose", "closed", "wrong-phase", "prepare-conflict", "prepare-read-error"} {
		t.Run(kind, func(t *testing.T) {
			op, d, r, writer := activeHistoryFixture(t)
			body, id := activeHistoryBytes(r, localEntry(t, "1")), uuid.NewString()
			if _, e := op.PutHistoryLedger(t.Context(), writer, id, 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e != nil {
				t.Fatal(e)
			}
			switch kind {
			case "missing-file":
				id = uuid.NewString()
			case "wrong-purpose":
				f := d.files[id]
				f.Purpose = "timeline"
				d.files[id] = f
			case "closed":
				op.closed = true
			case "wrong-phase":
				d.bundle.Phase = "sealed"
			case "prepare-conflict":
				d.bundle.Identity = []byte(`{}`)
			case "prepare-read-error":
				bindArchiveFailureDAO(op, d, r, "bundle", 0)
			}
			if kind == "prepare-conflict" || kind == "prepare-read-error" {
				if _, e := op.PutHistoryLedger(t.Context(), writer, uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e == nil {
					t.Fatal("new round bypassed original active identity")
				}
				return
			}
			out, e := op.HistoryLedgerStatus(t.Context(), writer, id)
			if kind == "original" {
				if e != nil || out.State != "complete" || out.FileID != id {
					t.Fatal(out, e)
				}
			} else if e == nil {
				t.Fatal("status escaped its exact original active round", kind, out)
			}
		})
	}
}

func TestArchiveErrorsAndUnsupportedStorageRemainObservable(t *testing.T) {
	validation := invalidArchiveFile(archiveDependencyFailure)
	if !errors.Is(validation, archiveDependencyFailure) || !strings.Contains(validation.Error(), "validation failed") {
		t.Fatal("archive validation hid its cause", validation)
	}
	tx := &operationTx{dao: struct{ store.SessionDAO }{}}
	if _, e := archiveDAO(tx); e == nil {
		t.Fatal("legacy DAO advertised unified archive storage")
	}
	if _, e := archiveMediaDAO(tx); e == nil {
		t.Fatal("legacy DAO advertised immutable resource storage")
	}
	op, _, _ := archiveFlowFixture(t)
	files := archiveFailureStorage{Storage: op.execution.files, kind: "put"}
	if e := putArchiveChunk(t.Context(), files, "original/chunk", []byte("original"), archiveDigest([]byte("original"))); !errors.Is(e, archiveDependencyFailure) {
		t.Fatal("failed chunk write became acknowledged", e)
	}
}

func (d *archiveFailureDAO) SessionArchiveMigration(ctx context.Context, id string) (store.ArchiveMigration, error) {
	if e := d.refusal("migration"); e != nil {
		return store.ArchiveMigration{}, e
	}
	return d.archiveFlowDAO.SessionArchiveMigration(ctx, id)
}
func (d *archiveFailureDAO) SaveSessionArchiveMigration(ctx context.Context, v store.ArchiveMigration) error {
	if e := d.refusal("save-migration"); e != nil {
		return e
	}
	return d.archiveFlowDAO.SaveSessionArchiveMigration(ctx, v)
}
func (d *archiveFailureDAO) SessionArchive(ctx context.Context, id string) (sp.ArchiveStatus, string, error) {
	if e := d.refusal("status"); e != nil {
		return sp.ArchiveStatus{}, "", e
	}
	return d.archiveFlowDAO.SessionArchive(ctx, id)
}

func TestArchiveRejectedRoundsDoNotAdvancePublication(t *testing.T) {
	for _, kind := range []string{"closed-prepare", "closed-seal", "invalid-ledger-seal", "resource-descriptor", "unknown-purpose", "invalid-chunk", "ledger-projection"} {
		t.Run(kind, func(t *testing.T) {
			op, d, r := archiveFlowFixture(t)
			var e error
			switch kind {
			case "closed-prepare":
				op.closed = true
				_, e = op.PrepareArchive(t.Context(), sp.ArchivePrepareRequest{})
			case "closed-seal":
				op.closed = true
				_, e = op.SealArchive(t.Context())
			case "invalid-ledger-seal":
				d.bundle.HistoryID = uuid.NewString()
				d.bundle.Ledger = []byte(`{`)
				_, e = op.SealArchive(t.Context())
			case "resource-descriptor":
				_, e = op.PutArchiveResource(t.Context(), uuid.NewString(), 0, 1, strings.Repeat("a", 64), archiveDigest([]byte("x")), []byte("x"), sp.Resource{})
			case "unknown-purpose":
				_, e = op.PutArchiveFile(t.Context(), "other", uuid.NewString(), 0, 1, archiveDigest([]byte("x")), archiveDigest([]byte("x")), []byte("x"))
			case "invalid-chunk":
				_, e = op.PutArchiveFile(t.Context(), "history", uuid.NewString(), 0, 1, "invalid", archiveDigest([]byte("x")), []byte("x"))
			case "ledger-projection":
				entry := sp.TimelineEntry{EntryID: uuid.NewString(), EntrySeq: "1", Revision: "1", Kind: "assistant_message", Data: map[string]json.RawMessage{"content": json.RawMessage(`[{"type":"resource","resourceId":3,"label":"original"}]`)}}
				_, e = makeArchiveLedger(sp.ArchiveHistoryContent{HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: decimal(r.SourceSeq), Entries: []sp.TimelineEntry{entry}}, r.Snapshot.HistoryEpoch, r.SourceSeq)
			}
			if e == nil || d.status.State == "ready" {
				t.Fatal("unproven round became ready", kind, e)
			}
		})
	}
}

func TestArchiveAssemblyRefusesMissingOrInconsistentOriginalChunks(t *testing.T) {
	for _, kind := range []string{"offset", "missing", "size", "length", "write"} {
		t.Run(kind, func(t *testing.T) {
			op, _, _ := archiveFlowFixture(t)
			body := []byte("original")
			file := store.ArchiveBundleFile{FileID: uuid.NewString(), Purpose: "history", ByteLength: int64(len(body)), SHA256: archiveDigest(body), Path: "original/history"}
			chunk := store.ArchiveBundleChunk{Offset: 0, ByteLength: int64(len(body)), Path: "original/chunk"}
			if kind != "missing" {
				if _, e := op.execution.files.Put(t.Context(), archiveBucket, chunk.Path, bytes.NewReader(body)); e != nil {
					t.Fatal(e)
				}
			}
			switch kind {
			case "offset":
				chunk.Offset = 1
			case "size":
				chunk.ByteLength++
			case "length":
				file.ByteLength++
			case "write":
				op.execution.files = archiveFailureStorage{Storage: op.execution.files, kind: "put"}
			}
			if e := op.assembleArchiveFile(t.Context(), file, []store.ArchiveBundleChunk{chunk}); e == nil {
				t.Fatal("incomplete original chunks assembled", kind)
			}
		})
	}
}

func TestArchiveFailureAndCleanupDoNotLoseOriginalTombstone(t *testing.T) {
	for _, kind := range []string{"failed-receipt", "file", "save-file", "wrong-state", "cleanup-file", "cleanup-chunks", "cleanup-delete", "cleanup-save"} {
		t.Run(kind, func(t *testing.T) {
			op, base, r := archiveFlowFixture(t)
			file := store.ArchiveBundleFile{SessionID: op.id, FileID: uuid.NewString(), Purpose: "history", State: "receiving", ByteLength: 1, SHA256: archiveDigest([]byte("x")), Path: "original/history", TimelineRevision: 1}
			base.files[file.FileID] = file
			target := kind
			if strings.HasPrefix(kind, "cleanup-") {
				target = strings.TrimPrefix(kind, "cleanup-")
				file.State = "failed"
				base.files[file.FileID] = file
			}
			if target == "save" {
				target = "save-file"
			}
			d := bindArchiveFailureDAO(op, base, r, target, 0)
			if kind == "wrong-state" {
				f := file
				f.State = "complete"
				base.files[file.FileID] = f
			}
			var e error
			if strings.HasPrefix(kind, "cleanup-") {
				if target == "delete" {
					op.execution.files = archiveFailureStorage{Storage: op.execution.files, kind: "delete"}
				}
				e = op.cleanupArchiveStaging(t.Context(), file)
			} else {
				e = op.failArchiveFile(t.Context(), file)
			}
			if kind == "failed-receipt" {
				if e != nil {
					t.Fatal(e)
				}
				receipt := fileReceipt(d.files[file.FileID])
				if receipt.State != "failed" || receipt.Error == nil || receipt.Error.Code != "archive_incomplete" {
					t.Fatal("failed file receipt lost its refusal", receipt)
				}
				return
			}
			if e == nil {
				t.Fatal("failed storage outcome became successful cleanup", kind)
			}
			if kind != "wrong-state" && !errors.Is(e, archiveDependencyFailure) {
				t.Fatal("original cleanup cause replaced", kind, e)
			}
			if d.files[file.FileID].StagingReleased {
				t.Fatal("failed cleanup released retained staging identity")
			}
		})
	}
}

func TestArchiveResetRequiresExactFailedRoundAndCompleteResourceRelease(t *testing.T) {
	for _, kind := range []string{"original", "file", "lease-count", "files", "remove-reference", "receiving-file", "save-bundle"} {
		t.Run(kind, func(t *testing.T) {
			op, base, r := archiveFlowFixture(t)
			file := store.ArchiveBundleFile{SessionID: op.id, FileID: uuid.NewString(), Purpose: "timeline", State: "failed", TimelineRevision: 1}
			base.files[file.FileID] = file
			base.bundle.Phase = "failed"
			base.bundle.TimelineID = file.FileID
			base.bundle.Resources = encode([]sp.ArchiveResourceReference{{Resource: sp.Resource{ResourceID: uuid.NewString()}}})
			if kind == "receiving-file" {
				other := file
				other.FileID = uuid.NewString()
				other.State = "receiving"
				base.files[other.FileID] = other
			}
			d := bindArchiveFailureDAO(op, base, r, kind, 0)
			bundle := *base.bundle
			e := resetArchivePreparation(t.Context(), &operationTx{dao: d}, d, &bundle, sp.ArchivePrepareRequest{ExpectedTimelineRevision: "1", FailedFileID: file.FileID})
			if kind == "original" {
				if e != nil || bundle.Revision != 2 || bundle.Phase != "settling" || bundle.TimelineID != "" || string(bundle.Resources) != "[]" {
					t.Fatal("original failed round did not reset atomically", bundle, e)
				}
			} else if e == nil {
				t.Fatal("reset bypassed retained writes or failed resource release", kind)
			}
		})
	}
}

func TestLegacyMigrationRetainsDependencyFailuresBeforeReady(t *testing.T) {
	for _, failure := range []struct {
		kind string
		at   int
	}{{"migration", 1}, {"save-migration", 1}, {"save-migration", 2}, {"save-migration", 3}, {"save-migration", 4}, {"usage", 1}, {"usage", 2}, {"lease", 1}, {"status", 1}, {"save-bundle", 1}, {"save-file", 1}, {"ready", 1}} {
		t.Run(failure.kind+decimal(int64(failure.at)), func(t *testing.T) {
			op, base, r := archiveFlowFixture(t)
			source := encode(sp.ArchiveDocument{SchemaVersion: 1, Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID, Provider: r.Snapshot.Identity.Provider, Entries: []sp.TimelineEntry{localEntry(t, "1")}, Resources: []sp.ArchiveResource{}})
			digest := archiveDigest(source)
			sourcePath, e := archiveObjectPath("", r.Owner, op.id, digest)
			if e != nil {
				t.Fatal(e)
			}
			base.status = sp.ArchiveStatus{State: "ready", SHA256: &digest}
			base.archivePath = sourcePath
			d := bindArchiveFailureDAO(op, base, r, failure.kind, failure.at)
			_, e = op.execution.migrateLegacyArchive(t.Context(), op, source, sourcePath)
			if !errors.Is(e, archiveDependencyFailure) || d.leases != 0 {
				t.Fatal("migration lost storage refusal or lease", failure, e, d.leases)
			}
			if failure.kind != "save-migration" || failure.at < 3 {
				if d.status.SchemaVersion == 3 {
					t.Fatal("pre-commit dependency failure published archive")
				}
			}
		})
	}
}

func TestArchiveStatusObservesMigratedClosureBeforeReportingUnifiedReady(t *testing.T) {
	for _, kind := range []string{"original", "missing-original"} {
		t.Run(kind, func(t *testing.T) {
			op, d, r := archiveFlowFixture(t)
			source := encode(sp.ArchiveDocument{SchemaVersion: 1, Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID, Provider: r.Snapshot.Identity.Provider, Entries: []sp.TimelineEntry{localEntry(t, "1")}, Resources: []sp.ArchiveResource{}})
			digest, length := archiveDigest(source), decimal(int64(len(source)))
			path, e := archiveObjectPath("", r.Owner, op.id, digest)
			if e != nil {
				t.Fatal(e)
			}
			d.status = sp.ArchiveStatus{State: "ready", SHA256: &digest, ByteLength: &length}
			d.archivePath = path
			if kind == "original" {
				if _, e = op.execution.files.Put(t.Context(), archiveBucket, path, bytes.NewReader(source)); e != nil {
					t.Fatal(e)
				}
			}
			op.execution.archivePreflightRun = func(context.Context, model.Principal, string, string, string, ArchiveMode) (string, error) {
				return r.Owner, nil
			}
			out, e := op.execution.ArchiveStatus(t.Context(), op.principal, "", "", op.id)
			if kind == "original" {
				if e != nil || out.State != "ready" || out.SchemaVersion != 3 || d.migration == nil || d.migration.Phase != "verified" {
					t.Fatal("status returned before unified closure verification", out, e)
				}
			} else if e == nil || out.SchemaVersion == 3 {
				t.Fatal("missing legacy bytes were reported as migrated", out, e)
			}
			if len(op.execution.archiveSlots) != 0 || d.leases != 0 {
				t.Fatal("status migration leaked its archive or media permit")
			}
		})
	}
}
