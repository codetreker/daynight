package session

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func activeHistoryFixture(t *testing.T) (*ArchiveOperation, *archiveFlowDAO, *record, ActiveHistoryWriter) {
	t.Helper()
	op, d, r := archiveFlowFixture(t)
	d.bundle = nil
	r.Snapshot.Lifecycle, r.Snapshot.ContentRevision = "active", sp.ContentRevision
	r.Snapshot.TestExecutionID, r.Snapshot.ClaimID = uuid.NewString(), ""
	r.Snapshot.ConnectionEpoch = "1"
	r.Live = newLive(r.Snapshot)
	r.ConnectionParent, r.Consumed = uuid.NewString(), true
	expires := time.Now().Add(time.Hour)
	r.ConnectionExpiry = &expires
	writer := ActiveHistoryWriter{Fence: r.Snapshot.ControllerFence, Credential: "dncontroller_original-active-grant"}
	digest := sha256.Sum256([]byte(writer.Credential))
	r.GrantHash = digest[:]
	return op, d, r, writer
}

func activeHistoryBytes(r *record, entries ...sp.TimelineEntry) []byte {
	return encode(sp.ArchiveHistoryContent{HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: decimal(r.SourceSeq), Entries: entries, Resources: []sp.Resource{}})
}

func TestActiveHistoryUsesConsumedGrantAndCannotReuseReceivingOrOldCheckpoint(t *testing.T) {
	op, d, r, writer := activeHistoryFixture(t)
	entry := localEntry(t, "1")
	body, id := activeHistoryBytes(r, entry), uuid.NewString()
	if _, e := op.HistoryLedgerStatus(t.Context(), writer, id); !errors.Is(e, model.ErrNotFound) {
		t.Fatal(e)
	}
	first, e := op.PutHistoryLedger(t.Context(), writer, id, 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body)
	if e != nil || first.State != "complete" || first.TimelineRevision == nil || *first.TimelineRevision != "1" || !imageHistoryCurrent(*d.bundle, r) {
		t.Fatal(first, e)
	}
	file := d.files[id]
	if !file.StagingReleased {
		t.Fatal("complete history retained transient bodies")
	}
	if _, e = op.execution.files.Open(t.Context(), archiveBucket, file.Path+"/content"); e == nil {
		t.Fatal("history text remained on the volume")
	}
	if _, e = op.PutHistoryLedger(t.Context(), writer, id, 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e != nil {
		t.Fatal("exact retry after stage release", e)
	}
	newID := uuid.NewString()
	half := len(body) / 2
	if _, e = op.PutHistoryLedger(t.Context(), writer, newID, 0, int64(len(body)), archiveDigest(body), archiveDigest(body[:half]), body[:half]); e != nil {
		t.Fatal(e)
	}
	if imageHistoryCurrent(*d.bundle, r) {
		t.Fatal("receiving round reused the previous ledger")
	}
	if _, e = op.PutHistoryLedger(t.Context(), writer, newID, int64(half), int64(len(body)), archiveDigest(body), archiveDigest(body[half:]), body[half:]); e != nil {
		t.Fatal(e)
	}
	if !imageHistoryCurrent(*d.bundle, r) {
		t.Fatal("complete round was not admitted")
	}
	r.SourceSeq++
	if imageHistoryCurrent(*d.bundle, r) {
		t.Fatal("new source was admitted against an old checkpoint")
	}
	if _, e = op.PutHistoryLedger(t.Context(), writer, id, 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e == nil {
		t.Fatal("old round replaced current history")
	}
}

func TestActiveHistoryRejectsOlderCompleteCheckpoint(t *testing.T) {
	op, d, r, writer := activeHistoryFixture(t)
	r.SourceSeq = 2
	entry := localEntry(t, "1")
	newer := activeHistoryBytes(r, entry)
	if _, err := op.PutHistoryLedger(t.Context(), writer, uuid.NewString(), 0, int64(len(newer)), archiveDigest(newer), archiveDigest(newer), newer); err != nil {
		t.Fatal(err)
	}
	before := append([]byte(nil), d.bundle.Ledger...)
	older := encode(sp.ArchiveHistoryContent{HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: "1", Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{}})
	if _, err := op.PutHistoryLedger(t.Context(), writer, uuid.NewString(), 0, int64(len(older)), archiveDigest(older), archiveDigest(older), older); err == nil {
		t.Fatal("older source checkpoint was accepted")
	}
	if !jsonEqual(before, d.bundle.Ledger) {
		t.Fatal("older checkpoint replaced accepted ledger")
	}
}

func TestActiveHistoryRechecksGrantFenceLifecycleAndFinalStoppedRound(t *testing.T) {
	for _, kind := range []string{"unconsumed", "grant", "connection", "generation", "expired", "disconnected", "stopped", "owner"} {
		t.Run(kind, func(t *testing.T) {
			op, d, r, writer := activeHistoryFixture(t)
			body, id := activeHistoryBytes(r, localEntry(t, "1")), uuid.NewString()
			if _, e := op.PutHistoryLedger(t.Context(), writer, id, 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e != nil {
				t.Fatal(e)
			}
			switch kind {
			case "unconsumed":
				r.Consumed = false
			case "grant":
				writer.Credential = "dncontroller_other"
			case "connection":
				writer.Fence.ConnectionEpoch = "2"
			case "generation":
				writer.Fence.ExecutionGeneration = "2"
			case "expired":
				expiry := time.Now().Add(-time.Hour)
				r.ConnectionExpiry = &expiry
			case "disconnected":
				r.Live = nil
			case "stopped":
				r.Snapshot.Lifecycle = "archived"
			case "owner":
				r.Owner = uuid.NewString()
			}
			if _, e := op.HistoryLedgerStatus(t.Context(), writer, id); e == nil {
				t.Fatal("stale delegation observed ledger")
			}
			if d.bundle.HistoryID != id {
				t.Fatal("rejected delegation changed original ledger")
			}
		})
	}
	op, d, r, writer := activeHistoryFixture(t)
	body, id := activeHistoryBytes(r, localEntry(t, "1")), uuid.NewString()
	if _, e := op.PutHistoryLedger(t.Context(), writer, id, 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e != nil {
		t.Fatal(e)
	}
	r.Snapshot.Lifecycle = "archived"
	r.Live = nil
	stopped := &ArchiveOperation{execution: op.execution, principal: op.principal, project: op.project, task: op.task, id: op.id, owner: op.owner, mode: op.mode}
	prepared, e := stopped.PrepareArchive(t.Context(), sp.ArchivePrepareRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID})
	if e != nil || prepared.Phase != "settling" || d.bundle.HistoryID != "" || d.bundle.Revision != 2 {
		t.Fatal(prepared, e)
	}
	if _, e = stopped.SealArchive(t.Context()); e == nil {
		t.Fatal("active checkpoint sealed as final history")
	}
}

func TestActiveHistoryLedgerStoresBoundedPositionsWithoutText(t *testing.T) {
	entryID, imageID, partID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	text := "private source text"
	digest := archiveDigest([]byte(text))
	position := `{"imageId":"` + imageID + `","start":0,"end":1,"part":{"type":"image_unavailable","imageId":"` + imageID + `","alt":"a","reason":"source_unavailable","message":"unavailable"}}`
	// This exercises the internal extractor on already validated wire entries.
	entry := sp.TimelineEntry{EntryID: entryID, EntrySeq: "1", Revision: "1", Kind: "tool_call", Data: map[string]json.RawMessage{"callId": []byte(`"tool-call"`), "output": []byte(`[{"type":"markdown","partId":"` + partID + `","revision":"7","text":"` + text + `","textSha256":"` + digest + `","bindings":[` + position + `],"retainedImages":[]}]`)}}
	positions, e := archiveHistoryOccurrences([]sp.TimelineEntry{entry})
	if e != nil || len(positions) != 1 {
		t.Fatal(positions, e)
	}
	p := positions[0]
	if p.EntryID != entryID || p.ImageID != imageID || p.Container != "tool_output" || p.PartID == nil || *p.PartID != partID || p.SourceRevision == nil || *p.SourceRevision != "7" || p.SourceTextSHA256 == nil || *p.SourceTextSHA256 != digest || p.CallIDSHA256 == nil || *p.CallIDSHA256 != archiveDigest([]byte("tool-call")) {
		t.Fatal(p)
	}
	if _, e = archiveHistoryOccurrences([]sp.TimelineEntry{entry, entry}); e == nil {
		t.Fatal("duplicate cross-entry occurrence admitted")
	}
}

func TestArchiveLedgerStorageBoundCoversDeclaredEntryAndOccurrenceCapacity(t *testing.T) {
	id, sequence, digest := strings.Repeat("f", 36), strings.Repeat("9", 19), strings.Repeat("f", 64)
	entry := archiveLedgerEntry{ID: id, Sequence: sequence, Revision: sequence, SHA256: digest, SourceSHA256: digest, ByteLength: sp.MaxArchiveBytes}
	position := archiveLedgerOccurrence{EntryID: id, ImageID: id, Container: "tool_output", PartID: &id, SourceRevision: &sequence, SourceTextSHA256: &digest, CallIDSHA256: &digest}
	entryBytes := archiveLedgerStorageBytes(encode(entry))
	positionBytes := archiveLedgerStorageBytes(encode(position))
	// Each descriptor has at most thirteen primitive fields. The 64 KiB covers
	// jsonb's structural spaces for all 1,000 descriptors, plus the root envelope.
	upper := 100000*(entryBytes+2) + maxArchiveHistoryOccurrences*(positionBytes+2) + sp.MaxArchiveManifestBytes + 65536
	if upper >= maxArchiveLedgerBytes {
		t.Fatalf("fixed metadata upper bound %d exceeds %d", upper, maxArchiveLedgerBytes)
	}
	t.Logf("entry jsonb <=%d, occurrence jsonb <=%d, full ledger upper bound <=%d bytes", entryBytes, positionBytes, upper)
	if archiveLedgerStorageBytes([]byte(`{"s":"commas,,, and colons::: and escaped\\\"quote","a":[1,2]}`)) != len(`{"s":"commas,,, and colons::: and escaped\\\"quote","a":[1,2]}`)+4 {
		t.Fatal("structural spaces counted inside a JSON string")
	}
}
