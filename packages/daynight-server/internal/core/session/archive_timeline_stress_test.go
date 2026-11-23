//go:build stress

package session

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

// Run separately from CI: this exercises real file I/O and both production
// schema3 readers on a valid timeline larger than the legacy transport limit.
func TestLargeSchema3ManifestAndTimelineRead(t *testing.T) {
	op, dao, r := archiveFlowFixture(t)
	r.SourceSeq = 65
	value, err := json.Marshal(strings.Repeat("x", 1024*1024))
	if err != nil {
		t.Fatal(err)
	}
	entries := make([]sp.TimelineEntry, 65)
	for i := range entries {
		entries[i] = sp.TimelineEntry{EntryID: uuid.NewString(), EntrySeq: fmt.Sprint(i + 1), Revision: "1", Kind: "reasoning", Data: map[string]json.RawMessage{"text": value}}
	}
	timeline, err := sp.MarshalWire(sp.ArchiveTimeline{Entries: entries})
	if err != nil || len(timeline) <= sp.MaxArchiveBytes || len(timeline) > sp.MaxArchiveTimelineBytes {
		t.Fatalf("timeline size=%d error=%v", len(timeline), err)
	}
	history := sp.ArchiveHistoryContent{HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: decimal(r.SourceSeq), Entries: entries, Resources: []sp.Resource{}}
	ledger, err := makeArchiveLedger(history, history.HistoryEpoch, r.SourceSeq)
	if err != nil {
		t.Fatal(err)
	}
	ledger.HistoryID = uuid.NewString()
	fileID := uuid.NewString()
	namespace, err := archiveNamespace(op.project, op.owner, op.id)
	if err != nil {
		t.Fatal(err)
	}
	file := store.ArchiveBundleFile{SessionID: op.id, FileID: fileID, Purpose: "timeline", SHA256: archiveDigest(timeline), State: "complete", ByteLength: int64(len(timeline)), AcceptedOffset: int64(len(timeline)), TimelineRevision: 1, Path: namespace.Directory() + "/files/" + fileID}
	if _, err = op.execution.files.Put(t.Context(), archiveBucket, archiveFilePath(file), bytes.NewReader(timeline)); err != nil {
		t.Fatal(err)
	}
	dao.files[fileID] = file
	dao.bundle.Phase, dao.bundle.TimelineID, dao.bundle.Ledger = "sealed", fileID, encode(ledger)
	dao.bundle.Resources = []byte(`[]`)
	ref := sp.ArchiveFileReference{FileID: fileID, SHA256: file.SHA256, ByteLength: decimal(file.ByteLength)}
	manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentKind: "native_timeline", RecordID: op.id, Fence: r.Snapshot.Fence, Provider: r.Snapshot.Identity.Provider, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID, Timeline: ref, Resources: []sp.ArchiveResourceReference{}, Completeness: "complete"}
	status, err := op.PutArchiveManifest(t.Context(), encode(manifest))
	if err != nil || status.State != "ready" || status.SchemaVersion != 3 || dao.bundle.Phase != "committed" {
		t.Fatalf("manifest publication: %+v phase=%s error=%v", status, dao.bundle.Phase, err)
	}
	permit, err := op.execution.files.TryAcquireResidency(t.Context(), "large-schema3-read/"+op.id)
	if err != nil {
		t.Fatal(err)
	}
	op.execution.archiveSlots <- struct{}{}
	readOp := &ArchiveOperation{execution: op.execution, principal: op.principal, project: op.project, task: op.task, id: op.id, owner: op.owner, mode: ArchiveV1Read, permit: permit}
	retained, err := op.execution.archiveTimelineContent(t.Context(), readOp, fileID, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(retained.Data, timeline) || archiveDigest(retained.Data) != ref.SHA256 {
		t.Fatal("retained timeline differs from committed original")
	}
	if err = retained.Close(); err != nil {
		t.Fatal(err)
	}
	if dao.leases != 0 {
		t.Fatalf("read retained %d leases", dao.leases)
	}
	t.Logf("verified schema3 timeline bytes=%d manifest bytes=%d", len(timeline), len(encode(manifest)))
}
