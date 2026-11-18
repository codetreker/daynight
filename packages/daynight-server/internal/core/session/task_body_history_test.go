package session

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func taskBodyEntry(t *testing.T, seq string) sp.TimelineEntry {
	t.Helper()
	entry, err := sp.DecodeTimeline(encode(map[string]any{"entryId": uuid.NewString(), "entrySeq": seq, "revision": "1", "kind": "assistant_message", "content": []any{map[string]any{"type": "text", "text": "Assistant body"}}}))
	if err != nil {
		t.Fatal(err)
	}
	return entry
}

func TestTaskBodyArchiveFinalizesOnlyMatchingPolicy(t *testing.T) {
	op, d, r := archiveFlowFixture(t)
	entry := taskBodyEntry(t, "3")
	history := sp.ArchiveHistoryContent{ContentPolicy: "task_body", HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: decimal(r.SourceSeq), Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{}}
	body := encode(history)
	if _, err := op.PutArchiveFile(t.Context(), "history", uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); err != nil {
		t.Fatal(err)
	}
	var saved archiveLedger
	if json.Unmarshal(d.bundle.Ledger, &saved) != nil || saved.ContentPolicy != "task_body" || saved.SourceThrough != "7" {
		t.Fatalf("%+v", saved)
	}
	sealed, err := op.SealArchive(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	timeline := encode(sp.ArchiveTimeline{Entries: history.Entries})
	file := sp.ArchiveFileReference{FileID: uuid.NewString(), SHA256: archiveDigest(timeline), ByteLength: decimal(int64(len(timeline)))}
	if _, err = op.PutArchiveFile(t.Context(), "timeline", file.FileID, 0, int64(len(timeline)), file.SHA256, file.SHA256, timeline); err != nil {
		t.Fatal(err)
	}
	manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentKind: "native_timeline", RecordID: op.id, Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID, Provider: "codex", Timeline: file, Resources: sealed.Resources, Completeness: "complete"}
	if _, err = op.PutArchiveManifest(t.Context(), encode(manifest)); err == nil {
		t.Fatal("body ledger mislabeled as legacy")
	}
	manifest.ContentPolicy = "task_body"
	if result, err := op.PutArchiveManifest(t.Context(), encode(manifest)); err != nil || result.State != "ready" {
		t.Fatal(result, err)
	}
}

func TestTaskBodyHistoryRejectsPolicyChangesAndCountsOnlyBodyResources(t *testing.T) {
	history := sp.ArchiveHistoryContent{ContentPolicy: "task_body", HistoryEpoch: "epoch", SourceThrough: "7", Entries: []sp.TimelineEntry{taskBodyEntry(t, "3")}, Resources: []sp.Resource{}}
	before, err := makeArchiveLedger(history, "epoch", 7)
	if err != nil {
		t.Fatal(err)
	}
	after := before
	after.ContentPolicy = ""
	if verifySourceHistoryAdvance(before, after) == nil || verifyArchiveHistoryAdvance(before, after) == nil {
		t.Fatal("history policy changed")
	}
	length := "134217728"
	tool := sp.Resource{ResourceID: uuid.NewString(), Status: "available", ByteLength: &length}
	cost, err := checkContentReplacement(contentState{resources: []sp.Resource{tool}}, historyContentChange{before})
	if err != nil || cost.ResourceBytes != 0 {
		t.Fatal(cost, err)
	}
	before.Resources = []sp.Resource{tool}
	if _, err = checkContentReplacement(contentState{resources: []sp.Resource{tool}}, historyContentChange{before}); err == nil {
		t.Fatal("body resource ignored its capacity")
	}
}

func TestTaskBodyOnlineOccurrenceRequiresCurrentActiveCheckpoint(t *testing.T) {
	op, d, r := archiveFlowFixture(t)
	callID := "tool"
	position := sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "tool_output", CallID: &callID, SourceKey: "image"}
	ledger := archiveLedger{ContentPolicy: "task_body", HistoryID: uuid.NewString(), HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: decimal(r.SourceSeq), OnlineImageOccurrences: []sp.ImageOccurrence{position}}
	d.bundle.Phase, d.bundle.HistoryID, d.bundle.Ledger = "active", ledger.HistoryID, encode(ledger)
	tx := &operationTx{dao: d}
	if err := verifyImageOccurrence(t.Context(), tx, r, position); err != nil {
		t.Fatal(err)
	}
	r.SourceSeq++
	if verifyImageOccurrence(t.Context(), tx, r, position) == nil {
		t.Fatal("stale source admitted online image")
	}
	r.SourceSeq--
	d.bundle.Phase = "settling"
	if verifyImageOccurrence(t.Context(), tx, r, position) == nil {
		t.Fatal("stopped archive admitted online image")
	}
	_ = op
}

type onlineImageRetirementDAO struct {
	store.SessionDAO
	store.SessionResourceDAO
	capture store.SessionCaptureRecord
	upload  store.SessionUploadRecord
	count   int
	failure error
	removed []store.SessionResourceReference
	saved   []store.SessionUploadRecord
}

func (d *onlineImageRetirementDAO) SessionCaptureByImage(context.Context, string, string) (store.SessionCaptureRecord, error) {
	return d.capture, d.failure
}
func (d *onlineImageRetirementDAO) RemoveSessionResourceReference(_ context.Context, ref store.SessionResourceReference) error {
	d.removed = append(d.removed, ref)
	return nil
}
func (d *onlineImageRetirementDAO) SessionResourceReferenceCount(context.Context, string, string) (int, error) {
	return d.count, nil
}
func (d *onlineImageRetirementDAO) SessionUpload(context.Context, string, string) (store.SessionUploadRecord, error) {
	return d.upload, nil
}
func (d *onlineImageRetirementDAO) SaveSessionUpload(_ context.Context, value store.SessionUploadRecord) error {
	d.saved = append(d.saved, value)
	return nil
}

func TestTaskBodyRetiresOnlyUnsharedCommittedImageReferences(t *testing.T) {
	for _, shared := range []bool{false, true} {
		t.Run(map[bool]string{false: "exclusive", true: "shared"}[shared], func(t *testing.T) {
			id, resource, attempt := uuid.NewString(), uuid.NewString(), uuid.NewString()
			position := sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "reasoning", SourceKey: "image"}
			d := &onlineImageRetirementDAO{capture: store.SessionCaptureRecord{Request: sp.ImageCaptureRequest{Occurrence: position}, Receipt: sp.ImageCaptureReceipt{State: "committed", ResourceID: &resource, AttemptID: attempt}}, upload: store.SessionUploadRecord{BlobID: resource, Receipt: sp.ImageUploadReceipt{State: "complete"}}}
			if shared {
				d.count = 1
			}
			r := &record{Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id}}}}
			s := &Execution{}
			if err := s.retireOnlineImageReferences(t.Context(), &operationTx{dao: d}, r, []sp.ImageOccurrence{position}, nil); err != nil {
				t.Fatal(err)
			}
			if len(d.removed) != 1 || d.removed[0] != (store.SessionResourceReference{SessionID: id, ResourceID: resource, Kind: "message", ReferenceID: position.ImageID}) {
				t.Fatal(d.removed)
			}
			if shared && len(d.saved) != 0 || !shared && (len(d.saved) != 1 || d.saved[0].Receipt.State != "released") {
				t.Fatal(d.saved)
			}
			d.failure = errors.New("capture unavailable")
			if err := s.retireOnlineImageReferences(t.Context(), &operationTx{dao: d}, r, []sp.ImageOccurrence{position}, nil); !errors.Is(err, d.failure) {
				t.Fatal(err)
			}
			d.failure = model.ErrNotFound
			if err := s.retireOnlineImageReferences(t.Context(), &operationTx{dao: d}, r, []sp.ImageOccurrence{position}, nil); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestTaskBodyRetirementWaitsForCapturesAndPreservesBodyPin(t *testing.T) {
	resource := uuid.NewString()
	position := sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "reasoning", SourceKey: "image"}
	for _, state := range []string{"reserved", "copying", "failed", "committed"} {
		t.Run(state, func(t *testing.T) {
			d := &onlineImageRetirementDAO{capture: store.SessionCaptureRecord{Request: sp.ImageCaptureRequest{Occurrence: position}, Receipt: sp.ImageCaptureReceipt{State: state, ResourceID: &resource}}}
			r := &record{Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString()}}}}
			err := (&Execution{}).retireOnlineImageReferences(t.Context(), &operationTx{dao: d}, r, []sp.ImageOccurrence{position}, []sp.Resource{{ResourceID: resource}})
			if (err != nil) != (state == "reserved" || state == "copying") {
				t.Fatal(state, err)
			}
			if len(d.removed) != 0 || len(d.saved) != 0 {
				t.Fatal(d.removed, d.saved)
			}
		})
	}
}
