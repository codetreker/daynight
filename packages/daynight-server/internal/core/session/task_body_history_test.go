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
	capture       store.SessionCaptureRecord
	upload        store.SessionUploadRecord
	count         int
	failure       error
	removeFailure error
	countFailure  error
	uploadFailure error
	saveFailure   error
	uploadReads   int
	removed       []store.SessionResourceReference
	saved         []store.SessionUploadRecord
}

func (d *onlineImageRetirementDAO) SessionCaptureByImage(context.Context, string, string) (store.SessionCaptureRecord, error) {
	return d.capture, d.failure
}
func (d *onlineImageRetirementDAO) RemoveSessionResourceReference(_ context.Context, ref store.SessionResourceReference) error {
	d.removed = append(d.removed, ref)
	return d.removeFailure
}
func (d *onlineImageRetirementDAO) SessionResourceReferenceCount(context.Context, string, string) (int, error) {
	return d.count, d.countFailure
}
func (d *onlineImageRetirementDAO) SessionUploadByResource(context.Context, string, string) (store.SessionUploadRecord, error) {
	d.uploadReads++
	return d.upload, d.uploadFailure
}
func (d *onlineImageRetirementDAO) SaveSessionUpload(_ context.Context, value store.SessionUploadRecord) error {
	d.saved = append(d.saved, value)
	return d.saveFailure
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

func TestTaskBodyRetirementRejectsConflictingEvidenceAndPropagatesFailures(t *testing.T) {
	for _, scenario := range []string{"occurrence", "missing-resource", "remove", "count", "upload", "missing-owner", "wrong-blob", "pending-upload", "released", "save"} {
		t.Run(scenario, func(t *testing.T) {
			id, resource := uuid.NewString(), uuid.NewString()
			callID := "tool"
			position := sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "tool_output", CallID: &callID, SourceKey: "original"}
			d := &onlineImageRetirementDAO{capture: store.SessionCaptureRecord{Request: sp.ImageCaptureRequest{Occurrence: position}, Receipt: sp.ImageCaptureReceipt{State: "committed", ResourceID: &resource, AttemptID: uuid.NewString()}}, upload: store.SessionUploadRecord{BlobID: resource, Receipt: sp.ImageUploadReceipt{State: "complete"}}}
			failure := errors.New("retirement storage failed")
			wantRemoved, wantReads, wantSaved := 1, 1, 0
			storageFailure := false
			switch scenario {
			case "occurrence":
				d.capture.Request.Occurrence.SourceKey = "changed"
				wantRemoved, wantReads = 0, 0
			case "missing-resource":
				d.capture.Receipt.ResourceID = nil
				wantRemoved, wantReads = 0, 0
			case "remove":
				d.removeFailure, storageFailure, wantReads = failure, true, 0
			case "count":
				d.countFailure, storageFailure, wantReads = failure, true, 0
			case "upload":
				d.uploadFailure, storageFailure = failure, true
			case "missing-owner":
				failure = model.ErrNotFound
				d.uploadFailure, storageFailure = failure, true
			case "wrong-blob":
				d.upload.BlobID = uuid.NewString()
			case "pending-upload":
				d.upload.Receipt.State = "receiving"
			case "released":
				d.upload.Receipt.State = "released"
			case "save":
				d.saveFailure, storageFailure, wantSaved = failure, true, 1
			}
			r := &record{Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id}}}}
			err := (&Execution{}).retireOnlineImageReferences(t.Context(), &operationTx{dao: d}, r, []sp.ImageOccurrence{position}, nil)
			if scenario == "released" {
				if err != nil {
					t.Fatal(err)
				}
			} else if storageFailure {
				if !errors.Is(err, failure) {
					t.Fatal(err)
				}
			} else {
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != "archive_conflict" {
					t.Fatal(err)
				}
			}
			if len(d.removed) != wantRemoved || d.uploadReads != wantReads || len(d.saved) != wantSaved {
				t.Fatal(d.removed, d.uploadReads, d.saved)
			}
			if len(d.removed) != 0 && d.removed[0] != (store.SessionResourceReference{SessionID: id, ResourceID: resource, Kind: "message", ReferenceID: position.ImageID}) {
				t.Fatal(d.removed)
			}
			if len(d.saved) != 0 && (d.saved[0].Receipt.State != "released" || d.saved[0].Receipt.Resource != nil || d.saved[0].Receipt.Error != nil) {
				t.Fatal(d.saved)
			}
		})
	}
}

func TestTaskBodyLedgerRequiresExactClosureAndDistinctImageOwnership(t *testing.T) {
	for _, scenario := range []string{"epoch", "source", "missing-descriptor", "wrong-descriptor", "duplicate-image", "online-image-collision", "distinct-online-image"} {
		t.Run(scenario, func(t *testing.T) {
			imageID, resourceID := uuid.NewString(), uuid.NewString()
			entry := taskBodyEntry(t, "3")
			entry.Data["content"] = encode([]any{map[string]any{"type": "image", "imageId": imageID, "resourceId": resourceID}})
			h := sp.ArchiveHistoryContent{ContentPolicy: "task_body", HistoryEpoch: "epoch", SourceThrough: "7", Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{{ResourceID: resourceID}}}
			switch scenario {
			case "epoch":
				h.HistoryEpoch = "other"
			case "source":
				h.SourceThrough = "6"
			case "missing-descriptor":
				h.Resources = nil
			case "wrong-descriptor":
				h.Resources[0].ResourceID = uuid.NewString()
			case "duplicate-image":
				h.Entries = append(h.Entries, entry)
			case "online-image-collision", "distinct-online-image":
				if scenario == "distinct-online-image" {
					imageID = uuid.NewString()
				}
				h.OnlineImageOccurrences = []sp.ImageOccurrence{{ImageID: imageID, EntryID: uuid.NewString(), Container: "reasoning", SourceKey: "source"}}
			}
			ledger, err := makeArchiveLedger(h, "epoch", 7)
			if scenario == "distinct-online-image" {
				if err != nil || len(ledger.Occurrences) != 1 || len(ledger.OnlineImageOccurrences) != 1 || ledger.Resources[0].ResourceID != resourceID {
					t.Fatal(ledger, err)
				}
			} else {
				var f *model.Fault
				if !errors.As(err, &f) || f.Code != "archive_conflict" {
					t.Fatal(ledger, err)
				}
			}
		})
	}
}

func TestTaskBodyActiveHistoryPreservesOnlineImageAuthority(t *testing.T) {
	for _, scenario := range []string{"retained", "removed", "changed", "policy"} {
		t.Run(scenario, func(t *testing.T) {
			op, d, r, writer := activeHistoryFixture(t)
			r.Snapshot.ClaimID, r.Snapshot.TestExecutionID = uuid.NewString(), ""
			writer.Fence = r.Snapshot.ControllerFence
			r.Live = newLive(r.Snapshot)
			op.execution.archiveRun = func(ctx context.Context, principal model.Principal, _, _, id string, _ bool, work func(*Access) error) error {
				if principal != op.principal || id != op.id {
					t.Fatal("wrong history scope")
				}
				return work(&Access{tx: &operationTx{dao: d}, record: r, task: task{Status: "in_progress", Worker: &model.WorkerClaim{ClaimID: r.Snapshot.ClaimID, State: model.WorkerActive, AgentControlMode: model.AgentControlModeWeb}}})
			}
			callID := "tool"
			position := sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "tool_output", CallID: &callID, SourceKey: "original"}
			h := sp.ArchiveHistoryContent{ContentPolicy: "task_body", HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: decimal(r.SourceSeq), Entries: []sp.TimelineEntry{taskBodyEntry(t, "3")}, Resources: []sp.Resource{}, OnlineImageOccurrences: []sp.ImageOccurrence{position}}
			put := func(h sp.ArchiveHistoryContent) error {
				body := encode(h)
				_, err := op.PutHistoryLedger(t.Context(), writer, uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body)
				return err
			}
			if err := put(h); err != nil {
				t.Fatal(err)
			}
			before := append([]byte(nil), d.bundle.Ledger...)
			r.SourceSeq++
			h.SourceThrough = decimal(r.SourceSeq)
			switch scenario {
			case "removed":
				h.OnlineImageOccurrences = nil
			case "changed":
				h.OnlineImageOccurrences[0].SourceKey = "changed"
			case "policy":
				h.ContentPolicy = ""
			}
			err := put(h)
			if scenario == "retained" {
				var ledger archiveLedger
				if err != nil || json.Unmarshal(d.bundle.Ledger, &ledger) != nil || ledger.SourceThrough != "8" || len(ledger.OnlineImageOccurrences) != 1 {
					t.Fatal(ledger, err)
				}
			} else if err == nil || !jsonEqual(before, d.bundle.Ledger) {
				t.Fatal("rejected checkpoint replaced image authority", err)
			}
		})
	}
}

type sharedOnlineRetirementDAO struct {
	*archiveFlowDAO
	t                 *testing.T
	session, resource string
	captures          map[string]store.SessionCaptureRecord
	counts            []int
	owner             store.SessionUploadRecord
	removed           []string
	saved             []store.SessionUploadRecord
	ownerReads        int
}

func (d *sharedOnlineRetirementDAO) SessionCaptureByImage(_ context.Context, session, image string) (store.SessionCaptureRecord, error) {
	capture, ok := d.captures[image]
	if session != d.session || !ok {
		d.t.Fatal("unexpected capture query", session, image)
	}
	return capture, nil
}
func (d *sharedOnlineRetirementDAO) RemoveSessionResourceReference(_ context.Context, ref store.SessionResourceReference) error {
	if ref.SessionID != d.session || ref.ResourceID != d.resource || ref.Kind != "message" {
		d.t.Fatal(ref)
	}
	d.removed = append(d.removed, ref.ReferenceID)
	return nil
}
func (d *sharedOnlineRetirementDAO) SessionResourceReferenceCount(_ context.Context, session, resource string) (int, error) {
	if session != d.session || resource != d.resource || len(d.counts) == 0 {
		d.t.Fatal("unexpected reference count", session, resource)
	}
	count := d.counts[0]
	d.counts = d.counts[1:]
	return count, nil
}
func (d *sharedOnlineRetirementDAO) SessionUploadByResource(_ context.Context, session, resource string) (store.SessionUploadRecord, error) {
	if session != d.session || resource != d.resource {
		d.t.Fatal("unexpected owner query", session, resource)
	}
	d.ownerReads++
	return d.owner, nil
}
func (d *sharedOnlineRetirementDAO) SaveSessionUpload(_ context.Context, upload store.SessionUploadRecord) error {
	d.saved = append(d.saved, upload)
	return nil
}

func TestTaskBodyFinalHistoryReclaimsOriginalOwnerOfReusedOnlineResource(t *testing.T) {
	for _, order := range []string{"original-first", "reuse-first", "owner-outside-positions", "multiple-reusers"} {
		t.Run(order, func(t *testing.T) {
			op, base, r := archiveFlowFixture(t)
			resource, originalAttempt, call := uuid.NewString(), uuid.NewString(), "tool"
			original := sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "tool_output", CallID: &call, SourceKey: "original"}
			reused := sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "tool_output", CallID: &call, SourceKey: "reused"}
			d := &sharedOnlineRetirementDAO{archiveFlowDAO: base, t: t, session: op.id, resource: resource, counts: []int{1, 0}, captures: map[string]store.SessionCaptureRecord{
				original.ImageID: {Request: sp.ImageCaptureRequest{Occurrence: original, Locator: sp.ImageLocator{Kind: "local"}}, Receipt: sp.ImageCaptureReceipt{State: "committed", AttemptID: originalAttempt, ResourceID: &resource}},
				reused.ImageID:   {Request: sp.ImageCaptureRequest{Occurrence: reused, Locator: sp.ImageLocator{Kind: "resource", ResourceID: resource}}, Receipt: sp.ImageCaptureReceipt{State: "committed", AttemptID: uuid.NewString(), ResourceID: &resource}},
			}, owner: store.SessionUploadRecord{SessionID: op.id, BlobID: resource, Spec: sp.ImageUploadSpec{UploadID: originalAttempt}, Receipt: sp.ImageUploadReceipt{State: "complete", Resource: &sp.Resource{ResourceID: resource}}}}
			positions := []sp.ImageOccurrence{original, reused}
			if order == "reuse-first" {
				positions = []sp.ImageOccurrence{reused, original}
			}
			if order == "owner-outside-positions" {
				positions, d.counts = []sp.ImageOccurrence{reused}, []int{0}
			}
			if order == "multiple-reusers" {
				third := reused
				third.ImageID, third.EntryID = uuid.NewString(), uuid.NewString()
				capture := d.captures[reused.ImageID]
				capture.Request.Occurrence, capture.Receipt.AttemptID = third, uuid.NewString()
				d.captures[third.ImageID] = capture
				positions, d.counts = append(positions, third), []int{2, 1, 0}
			}
			h := sp.ArchiveHistoryContent{ContentPolicy: "task_body", HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: decimal(r.SourceSeq), Entries: []sp.TimelineEntry{taskBodyEntry(t, "3")}, Resources: []sp.Resource{}}
			previous, err := makeArchiveLedger(h, h.HistoryEpoch, r.SourceSeq)
			if err != nil {
				t.Fatal(err)
			}
			previous.HistoryID, previous.OnlineImageOccurrences = uuid.NewString(), positions
			base.bundle.Ledger = encode(previous)
			op.execution.archiveRun = func(ctx context.Context, p model.Principal, _, _, id string, _ bool, work func(*Access) error) error {
				if p != op.principal || id != op.id {
					t.Fatal("wrong final history scope")
				}
				return work(&Access{tx: &operationTx{dao: d}, record: r})
			}
			body, id := encode(h), uuid.NewString()
			put := func() error {
				_, err := op.PutArchiveFile(t.Context(), "history", id, 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body)
				return err
			}
			if err = put(); err != nil {
				t.Fatal(err)
			}
			var final archiveLedger
			if json.Unmarshal(base.bundle.Ledger, &final) != nil || len(final.OnlineImageOccurrences) != 0 || len(final.PendingImageRetirement) != len(positions) || final.HistoryID != id || len(d.removed) != 0 || len(d.saved) != 0 {
				t.Fatal(final, d.removed, d.saved)
			}
			if err = put(); err != nil || len(d.saved) != 0 || d.ownerReads != 0 {
				t.Fatal("final history retry released ownership", err, d.saved)
			}
			if _, err = op.SealArchive(t.Context()); err != nil {
				t.Fatal(err)
			}
			timeline := encode(sp.ArchiveTimeline{Entries: h.Entries})
			fileID := uuid.NewString()
			ref := sp.ArchiveFileReference{FileID: fileID, SHA256: archiveDigest(timeline), ByteLength: decimal(int64(len(timeline)))}
			if _, err = op.PutArchiveFile(t.Context(), "timeline", fileID, 0, int64(len(timeline)), ref.SHA256, ref.SHA256, timeline); err != nil {
				t.Fatal(err)
			}
			manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentPolicy: "task_body", ContentKind: "native_timeline", RecordID: op.id, Fence: r.Snapshot.Fence, Provider: r.Snapshot.Identity.Provider, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID, Timeline: ref, Resources: []sp.ArchiveResourceReference{}, Completeness: "complete"}
			body = encode(manifest)
			// Use a controlled ledger size to exercise the final capacity boundary
			// without running a large stress workload in the unit suite.
			originalLedger := append([]byte(nil), base.bundle.Ledger...)
			var nearLimit archiveLedger
			if err = json.Unmarshal(originalLedger, &nearLimit); err != nil {
				t.Fatal(err)
			}
			nearLimit.Entries[0].ByteLength = int(MaxSessionContentBytes - 4096)
			cost, err := measureContent(contentState{ledger: &nearLimit})
			if err != nil {
				t.Fatal(err)
			}
			nearLimit.Entries[0].ByteLength += int(MaxSessionContentBytes - cost.TimelineBytes - cost.IndexBytes - int64(len(body))/2)
			base.bundle.Ledger = encode(nearLimit)
			if _, err = checkContentReplacement(contentState{ledger: &nearLimit}, historyContentChange{nearLimit}); err != nil {
				t.Fatal("history must fit", err)
			}
			var refusal *model.Fault
			if _, err = op.PutArchiveManifest(t.Context(), body); !errors.As(err, &refusal) || refusal.Code != "quota_exceeded" || len(d.removed) != 0 || len(d.saved) != 0 || base.status.State == "ready" {
				t.Fatal("capacity failure changed online ownership", err, d.removed, d.saved, base.status)
			}
			base.bundle.Ledger = originalLedger
			base.leaseRows["reader"] = store.SessionResourceLease{ID: "reader", Kind: "read", ResourceID: resource}
			if _, err = op.PutArchiveManifest(t.Context(), body); err == nil || len(d.removed) != 0 || len(d.saved) != 0 {
				t.Fatal("reader lost its pin", err, d.removed, d.saved)
			}
			delete(base.leaseRows, "reader")
			if status, err := op.PutArchiveManifest(t.Context(), body); err != nil || status.State != "ready" {
				t.Fatal(status, err)
			}
			if len(d.removed) != len(positions) || len(d.counts) != 0 || d.ownerReads != 1 || len(d.saved) != 1 || d.saved[0].Spec.UploadID != originalAttempt || d.saved[0].Receipt.State != "released" || d.saved[0].Receipt.Resource != nil {
				t.Fatal(d.removed, d.counts, d.ownerReads, d.saved)
			}
			if status, err := op.PutArchiveManifest(t.Context(), body); err != nil || status.State != "ready" || len(d.saved) != 1 || d.ownerReads != 1 {
				t.Fatal("manifest retry repeated ownership release", status, err, d.saved)
			}
		})
	}
}

func TestTaskBodyReusedResourceRetainsBodyAndOtherPinsAndReleasedOwner(t *testing.T) {
	for _, scenario := range []string{"body", "other-reference", "released-owner"} {
		t.Run(scenario, func(t *testing.T) {
			id, resource, call := uuid.NewString(), uuid.NewString(), "tool"
			position := sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "tool_output", CallID: &call, SourceKey: "reuse"}
			d := &sharedOnlineRetirementDAO{t: t, session: id, resource: resource, counts: []int{1}, captures: map[string]store.SessionCaptureRecord{
				position.ImageID: {Request: sp.ImageCaptureRequest{Occurrence: position, Locator: sp.ImageLocator{Kind: "resource", ResourceID: resource}}, Receipt: sp.ImageCaptureReceipt{State: "committed", AttemptID: uuid.NewString(), ResourceID: &resource}},
			}, owner: store.SessionUploadRecord{SessionID: id, BlobID: resource, Spec: sp.ImageUploadSpec{UploadID: uuid.NewString()}, Receipt: sp.ImageUploadReceipt{State: "released"}}}
			var body []sp.Resource
			wantRemoved, wantReads := 1, 0
			if scenario == "body" {
				body = []sp.Resource{{ResourceID: resource}}
				d.counts = nil
				wantRemoved = 0
			}
			if scenario == "released-owner" {
				d.counts = []int{0}
				wantReads = 1
			}
			r := &record{Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id}}}}
			if err := (&Execution{}).retireOnlineImageReferences(t.Context(), &operationTx{dao: d}, r, []sp.ImageOccurrence{position}, body); err != nil {
				t.Fatal(err)
			}
			if len(d.removed) != wantRemoved || d.ownerReads != wantReads || len(d.saved) != 0 || len(d.counts) != 0 {
				t.Fatal(d.removed, d.ownerReads, d.saved, d.counts)
			}
		})
	}
}
