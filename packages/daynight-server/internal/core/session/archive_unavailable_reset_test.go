package session

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type archiveUnavailableSealDAO struct {
	*archiveFlowDAO
	insertCalls int
	lookups     int
	lookupErr   error
	insertErr   error
}

func (d *archiveUnavailableSealDAO) SavedSessionResource(ctx context.Context, session, id string) (store.SessionResourceRecord, error) {
	d.lookups++
	if d.lookupErr != nil {
		return store.SessionResourceRecord{}, d.lookupErr
	}
	return d.archiveFlowDAO.SavedSessionResource(ctx, session, id)
}
func (d *archiveUnavailableSealDAO) InsertSessionResource(ctx context.Context, r store.SessionResourceRecord) error {
	d.insertCalls++
	if d.insertCalls > 1 {
		return errors.New("second unavailable INSERT must not be proposed")
	}
	if d.insertErr != nil {
		return d.insertErr
	}
	return d.archiveFlowDAO.InsertSessionResource(ctx, r)
}

func unavailableArchiveHistory(t *testing.T, op *ArchiveOperation, r *record) (sp.Resource, []byte) {
	t.Helper()
	reason := "Original bytes were never captured."
	resource := sp.Resource{ResourceID: uuid.NewString(), Status: "unavailable", Name: "legacy-missing", Error: &reason}
	entry, e := sp.DecodeTimeline(encode(map[string]any{"entryId": uuid.NewString(), "entrySeq": "1", "revision": "1", "kind": "assistant_message", "content": []any{map[string]any{"type": "resource", "resourceId": resource.ResourceID, "label": "missing original"}}}))
	if e != nil {
		t.Fatal(e)
	}
	history := encode(sp.ArchiveHistoryContent{HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: decimal(r.SourceSeq), Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{resource}})
	if _, e = sp.DecodeArchiveHistory(history); e != nil {
		t.Fatal(e)
	}
	if _, e = op.PutArchiveFile(t.Context(), "history", uuid.NewString(), 0, int64(len(history)), archiveDigest(history), archiveDigest(history), history); e != nil {
		t.Fatal(e)
	}
	return resource, encode(sp.ArchiveTimeline{Entries: []sp.TimelineEntry{entry}})
}

func TestArchiveUnavailableResourceSurvivesExactStoppedResetAndReseal(t *testing.T) {
	op, base, r := archiveFlowFixture(t)
	resource, timeline := unavailableArchiveHistory(t, op, r)
	d := &archiveUnavailableSealDAO{archiveFlowDAO: base}
	op.execution.archiveRun = func(_ context.Context, _ model.Principal, _, _, _ string, _ bool, work func(*Access) error) error {
		return work(&Access{tx: &operationTx{dao: d}, record: r})
	}
	sealed, e := op.SealArchive(t.Context())
	if e != nil || len(sealed.Resources) != 1 || !reflect.DeepEqual(sealed.Resources[0].Resource, resource) {
		t.Fatal("first unavailable seal failed", sealed, e)
	}
	original := d.resources[resource.ResourceID]
	bad := []byte(`{"entries":[`)
	failedID := uuid.NewString()
	if _, e = op.PutArchiveFile(t.Context(), "timeline", failedID, 0, int64(len(bad)), archiveDigest(bad), archiveDigest(bad), bad); e == nil {
		t.Fatal("invalid timeline accepted")
	}
	reset := sp.ArchivePrepareRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID, ExpectedTimelineRevision: "1", FailedFileID: failedID}
	prepared, e := op.PrepareArchive(t.Context(), reset)
	if e != nil || prepared.Phase != "settling" || d.bundle.Revision != 2 {
		t.Fatal("exact reset failed", prepared, e)
	}
	resealed, e := op.SealArchive(t.Context())
	if e != nil || resealed.Phase != "sealed" || len(resealed.Resources) != 1 || !reflect.DeepEqual(resealed.Resources[0].Resource, resource) || d.insertCalls != 1 || !reflect.DeepEqual(d.resources[resource.ResourceID], original) {
		t.Fatal("exact reseal repeated an unavailable insert or changed its identity", resealed, e, d.insertCalls)
	}
	fileID := uuid.NewString()
	if _, e = op.PutArchiveFile(t.Context(), "timeline", fileID, 0, int64(len(timeline)), archiveDigest(timeline), archiveDigest(timeline), timeline); e != nil {
		t.Fatal("recovered timeline failed", e)
	}
	manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentKind: "native_timeline", RecordID: op.id, Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID, Provider: r.Snapshot.Identity.Provider, Timeline: sp.ArchiveFileReference{FileID: fileID, SHA256: archiveDigest(timeline), ByteLength: decimal(int64(len(timeline)))}, Resources: resealed.Resources, Completeness: "partial"}
	if out, e := op.PutArchiveManifest(t.Context(), encode(manifest)); e != nil || out.State != "ready" {
		t.Fatal("recovered unavailable archive did not publish", out, e)
	}
	if d.leases != 0 {
		t.Fatal("reset/reseal leaked archive lease")
	}
}

func TestArchiveUnavailableSealRejectsConflictingSavedIdentityAndPreservesFailures(t *testing.T) {
	for _, kind := range []string{"same", "changed-descriptor", "unexpected-blob", "inline-content", "pending-gc", "lookup-failure", "insert-failure"} {
		t.Run(kind, func(t *testing.T) {
			op, base, r := archiveFlowFixture(t)
			resource, _ := unavailableArchiveHistory(t, op, r)
			d := &archiveUnavailableSealDAO{archiveFlowDAO: base}
			original := store.SessionResourceRecord{SessionID: op.id, Resource: resource}
			failure := errors.New("unavailable resource dependency failed")
			switch kind {
			case "changed-descriptor":
				original.Resource.Name = "another-original"
			case "unexpected-blob":
				original.BlobID = uuid.NewString()
				original.BlobPath = "unexpected/blob"
			case "inline-content":
				original.HasInlineContent = true
			case "pending-gc":
				original.GCPending = true
			case "lookup-failure":
				d.lookupErr = failure
			case "insert-failure":
				d.insertErr = failure
			}
			if kind != "insert-failure" {
				d.resources[resource.ResourceID] = original
			}
			op.execution.archiveRun = func(_ context.Context, _ model.Principal, _, _, _ string, _ bool, work func(*Access) error) error {
				return work(&Access{tx: &operationTx{dao: d}, record: r})
			}
			out, e := op.SealArchive(t.Context())
			if kind == "same" {
				if e != nil || out.Phase != "sealed" || d.insertCalls != 0 {
					t.Fatal("matching unavailable resource was not reused", out, e, d.insertCalls)
				}
				return
			}
			if e == nil || out.Phase != "" || d.bundle.Phase != "settling" {
				t.Fatal("conflicting or failed unavailable record produced seal", kind, out, e)
			}
			if kind == "lookup-failure" || kind == "insert-failure" {
				if !errors.Is(e, failure) {
					t.Fatal("lost resource dependency failure", e)
				}
			} else {
				var fault *model.Fault
				if !errors.As(e, &fault) || fault.Code != "archive_conflict" {
					t.Fatal("conflict escaped archive boundary", e)
				}
			}
		})
	}
}

func TestArchiveUnavailableMigrationRejectsInlineOriginal(t *testing.T) {
	for _, inline := range []bool{false, true} {
		t.Run(map[bool]string{false: "absent", true: "present"}[inline], func(t *testing.T) {
			op, base, r, source, _, resource := legacyArchiveReviewFixture(t)
			doc, e := sp.DecodeArchive(source)
			if e != nil {
				t.Fatal(e)
			}
			resource.Status, resource.MediaType, resource.ByteLength, resource.SHA256 = "unavailable", nil, nil, nil
			doc.Resources = []sp.ArchiveResource{{Resource: resource}}
			source = encode(doc)
			hash, size := archiveDigest(source), decimal(int64(len(source)))
			path, e := archiveObjectPath("", r.Owner, op.id, hash)
			if e != nil {
				t.Fatal(e)
			}
			base.status, base.archivePath = sp.ArchiveStatus{State: "ready", SHA256: &hash, ByteLength: &size}, path
			d := &archiveMigrationIdentityDAO{archiveFlowDAO: base}
			original := store.SessionResourceRecord{SessionID: op.id, Resource: resource, HasInlineContent: inline}
			d.resources[resource.ResourceID] = original
			op.execution.archiveRun = func(_ context.Context, _ model.Principal, _, _, _ string, _ bool, work func(*Access) error) error {
				return work(&Access{tx: &operationTx{dao: d}, record: r})
			}
			manifest, e := op.execution.migrateLegacyArchive(t.Context(), op, source, path)
			if inline {
				var refusal *model.Fault
				if !errors.As(e, &refusal) || refusal.Code != "archive_conflict" || len(manifest) != 0 || d.status.SchemaVersion == 3 || d.migration != nil {
					t.Fatal("unavailable migration accepted retained inline original", e)
				}
			} else if e != nil || len(manifest) == 0 || d.status.SchemaVersion != 3 || d.migration == nil || d.migration.Phase != "verified" {
				t.Fatal("metadata-only unavailable resource did not migrate", e)
			}
			if d.inserts != 0 || d.conversions != 0 || !reflect.DeepEqual(d.resources[resource.ResourceID], original) || d.leases != 0 {
				t.Fatal("unavailable migration changed the original or leaked a lease")
			}
		})
	}
}

func TestArchiveAvailableInlineOriginalStillMigrates(t *testing.T) {
	op, base, r, source, path, resource := legacyArchiveReviewFixture(t)
	d := &archiveMigrationIdentityDAO{archiveFlowDAO: base}
	d.resources[resource.ResourceID] = store.SessionResourceRecord{SessionID: op.id, Resource: resource, HasInlineContent: true}
	op.execution.archiveRun = func(_ context.Context, _ model.Principal, _, _, _ string, _ bool, work func(*Access) error) error {
		return work(&Access{tx: &operationTx{dao: d}, record: r})
	}
	manifest, e := op.execution.migrateLegacyArchive(t.Context(), op, source, path)
	saved := d.resources[resource.ResourceID]
	if e != nil || len(manifest) == 0 || d.status.SchemaVersion != 3 || d.migration == nil || d.migration.Phase != "verified" || d.inserts != 0 || d.conversions != 1 || saved.HasInlineContent || saved.BlobID == "" || saved.BlobPath == "" || !reflect.DeepEqual(saved.Resource, resource) || d.leases != 0 {
		t.Fatal("available inline original failed its external storage conversion", e)
	}
}
