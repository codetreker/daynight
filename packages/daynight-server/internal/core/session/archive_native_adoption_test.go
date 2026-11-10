package session

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

var nativeAdoptionFailure = errors.New("native adoption write unavailable")

type archiveNativeAdoptionDAO struct {
	*archiveFlowDAO
	t                        *testing.T
	scope, currentScope      int
	readyScopes, savedScopes []int
	commitScopes             []int
	saved                    []store.SessionRecord
	fail                     string
}

func (d *archiveNativeAdoptionDAO) SetUnifiedSessionArchiveReady(ctx context.Context, id, hash string, length int, path, completeness string) error {
	d.t.Helper()
	if d.currentScope == 0 || id != d.bundle.SessionID || hash != d.bundle.ManifestHash || decimal(int64(length)) != d.bundle.ManifestLength || path != d.bundle.ManifestPath || completeness != "complete" {
		d.t.Fatal("ready candidate escaped its original manifest scope")
	}
	d.readyScopes = append(d.readyScopes, d.currentScope)
	if d.fail == "ready" {
		return nativeAdoptionFailure
	}
	return d.archiveFlowDAO.SetUnifiedSessionArchiveReady(ctx, id, hash, length, path, completeness)
}

func (d *archiveNativeAdoptionDAO) SaveSession(_ context.Context, value store.SessionRecord) error {
	d.t.Helper()
	if d.currentScope == 0 || len(d.readyScopes) == 0 || d.currentScope != d.readyScopes[len(d.readyScopes)-1] {
		d.t.Fatal("native identity and ready candidates used different scopes")
	}
	d.savedScopes = append(d.savedScopes, d.currentScope)
	d.saved = append(d.saved, value)
	if d.fail == "session" {
		return nativeAdoptionFailure
	}
	return nil
}

func (d *archiveNativeAdoptionDAO) SaveSessionArchiveBundle(ctx context.Context, value store.ArchiveBundle) error {
	if d.currentScope == 0 {
		d.t.Fatal("bundle candidate escaped its archive scope")
	}
	// An exact retry also retains committed metadata while acquiring its lease;
	// only the write after ready belongs to the final commitment candidate.
	if value.Phase == "committed" && len(d.readyScopes) > 0 && d.currentScope == d.readyScopes[len(d.readyScopes)-1] {
		d.commitScopes = append(d.commitScopes, d.currentScope)
		if d.fail == "bundle" {
			return nativeAdoptionFailure
		}
	}
	return d.archiveFlowDAO.SaveSessionArchiveBundle(ctx, value)
}

func unifiedArchiveNativeAdoptionFixture(t *testing.T) (*ArchiveOperation, *archiveNativeAdoptionDAO, *record, sp.ArchiveManifest) {
	t.Helper()
	op, base, r := archiveFlowFixture(t)
	if r.Snapshot.Identity.NativeSessionID != nil {
		t.Fatal("fixture already acknowledged a native identity")
	}
	timeline := encode(sp.ArchiveTimeline{Entries: []sp.TimelineEntry{localEntry(t, "1")}})
	fileID := uuid.NewString()
	namespace, e := archiveNamespace(op.project, op.owner, op.id)
	if e != nil {
		t.Fatal(e)
	}
	file := store.ArchiveBundleFile{SessionID: op.id, FileID: fileID, Purpose: "timeline", State: "complete", Path: namespace.Directory() + "/files/" + fileID, SHA256: archiveDigest(timeline), ByteLength: int64(len(timeline)), AcceptedOffset: int64(len(timeline))}
	if _, e = op.execution.files.Put(t.Context(), archiveBucket, file.Path+"/content", bytes.NewReader(timeline)); e != nil {
		t.Fatal(e)
	}
	base.bundle.Phase, base.bundle.TimelineID = "sealed", fileID
	base.files[fileID] = file
	manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentKind: "native_timeline", RecordID: op.id, Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID, Provider: r.Snapshot.Identity.Provider, Timeline: sp.ArchiveFileReference{FileID: fileID, SHA256: file.SHA256, ByteLength: decimal(file.ByteLength)}, Resources: []sp.ArchiveResourceReference{}, Completeness: "complete"}
	d := &archiveNativeAdoptionDAO{archiveFlowDAO: base, t: t}
	op.execution.archiveRun = func(_ context.Context, principal model.Principal, project, taskID, id string, finalize bool, work func(*Access) error) error {
		if principal != op.principal || project != op.project || taskID != op.task || id != op.id || !finalize {
			t.Fatal("native adoption used another archive authorization")
		}
		d.scope++
		d.currentScope = d.scope
		defer func() { d.currentScope = 0 }()
		return work(&Access{tx: &operationTx{dao: d}, record: r})
	}
	return op, d, r, manifest
}

func TestUnifiedArchiveProposesNativeIdentityAndReadyInOneScope(t *testing.T) {
	op, d, r, manifest := unifiedArchiveNativeAdoptionFixture(t)
	native := "native-created-after-last-ack"
	manifest.NativeSessionID = &native
	body, originalFence := encode(manifest), r.Snapshot.Fence
	for attempt := range 2 {
		out, e := op.PutArchiveManifest(t.Context(), body)
		if e != nil || out.State != "ready" || out.SchemaVersion != 3 || len(d.readyScopes) != attempt+1 || len(d.commitScopes) != attempt+1 || len(d.saved) != 1 {
			t.Fatal("original manifest or lost-response retry refused", attempt, out, e)
		}
		if d.readyScopes[attempt] != d.commitScopes[attempt] || d.savedScopes[0] != d.readyScopes[0] || !sameNative(d.saved[0].Snapshot.Identity.NativeSessionID, &native) || d.saved[0].Snapshot.Fence != originalFence || d.leases != 0 {
			t.Fatal("native adoption changed its generation or split its write candidates")
		}
	}
	other := "another-native"
	for _, replacement := range []*string{nil, &other} {
		manifest.NativeSessionID = replacement
		if _, e := op.PutArchiveManifest(t.Context(), encode(manifest)); e == nil || len(d.readyScopes) != 2 || len(d.saved) != 1 || r.Snapshot.Fence != originalFence || !sameNative(r.Snapshot.Identity.NativeSessionID, &native) {
			t.Fatal("archive replaced or cleared an established native identity", e)
		}
	}
}

func TestUnifiedArchiveSuppressesReadyResultAfterNativeAdoptionWriteFailure(t *testing.T) {
	for _, failure := range []string{"ready", "session", "bundle"} {
		t.Run(failure, func(t *testing.T) {
			op, d, r, manifest := unifiedArchiveNativeAdoptionFixture(t)
			native := "native-created-after-last-ack"
			manifest.NativeSessionID, d.fail = &native, failure
			before := r.Snapshot.Fence
			out, e := op.PutArchiveManifest(t.Context(), encode(manifest))
			if !errors.Is(e, nativeAdoptionFailure) || !reflect.DeepEqual(out, sp.ArchiveStatus{}) || r.Snapshot.Fence != before || d.leases != 0 {
				t.Fatal("failed candidate produced a ready result or leaked its lease", out, e)
			}
			if failure == "ready" && len(d.saved) != 0 || failure != "bundle" && len(d.commitScopes) != 0 {
				t.Fatal("archive continued after a failed adoption write")
			}
		})
	}
}

func TestUnifiedArchiveRejectsEstablishedNativeIdentityChangeBeforeCommit(t *testing.T) {
	for _, kind := range []string{"clear", "replace"} {
		t.Run(kind, func(t *testing.T) {
			op, d, r, manifest := unifiedArchiveNativeAdoptionFixture(t)
			native, other := "already-acknowledged-native", "another-native"
			r.Snapshot.Identity.NativeSessionID = &native
			if kind == "replace" {
				manifest.NativeSessionID = &other
			}
			if d.bundle.ManifestHash != "" {
				t.Fatal("fixture already bound a manifest")
			}
			if _, e := op.PutArchiveManifest(t.Context(), encode(manifest)); e == nil || len(d.readyScopes) != 0 || len(d.saved) != 0 || !sameNative(r.Snapshot.Identity.NativeSessionID, &native) {
				t.Fatal("new manifest cleared or replaced a known native identity", e)
			}
		})
	}
}
