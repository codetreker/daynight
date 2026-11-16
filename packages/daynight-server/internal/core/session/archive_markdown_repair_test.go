package session

import (
	"context"
	"encoding/base64"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

// The real archive business operations and file storage verify the stopped
// repair handoff; the DAO fixture supplies deterministic persisted records.
func TestStoppedMarkdownRepairUploadsNewImageAfterSourceTail(t *testing.T) {
	op, base, r, writer := activeHistoryFixture(t)
	entryID, partID, imageID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	text := "![original](original.png)"
	failed, err := sp.DecodeTimeline(encode(map[string]any{
		"entryId": entryID, "entrySeq": "1", "revision": "1", "kind": "assistant_message",
		"imageProjectionError": map[string]any{"code": "source_unavailable", "message": "Markdown image analysis is unavailable."},
		"content":              []any{map[string]any{"type": "text", "text": text}, map[string]any{"type": "markdown", "text": "", "partId": partID, "revision": "1", "textSha256": archiveDigest(nil), "complete": true, "truncated": false, "bindings": []any{}, "retainedImages": []any{}}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	body := activeHistoryBytes(r, failed)
	if _, err = op.PutHistoryLedger(t.Context(), writer, uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); err != nil {
		t.Fatal(err)
	}
	stopped := stoppedHistoryOperation(op, r)
	epoch := uuid.NewString()
	r.SourceEpoch = &epoch
	d := &archiveSourceRecoveryDAO{archiveFlowDAO: base, hashes: &sourceCheckpointDAO{hashes: map[string][]byte{}}}
	op.execution.archiveRun = func(_ context.Context, _ model.Principal, _, _, _ string, _ bool, work func(*Access) error) error {
		return work(&Access{tx: &operationTx{dao: d}, record: r})
	}
	repaired, err := sp.DecodeTimeline(encode(map[string]any{
		"entryId": entryID, "entrySeq": "1", "revision": "2", "kind": "assistant_message", "imageProjectionError": nil,
		"content": []any{map[string]any{"type": "markdown", "text": text, "partId": partID, "revision": "2", "textSha256": archiveDigest([]byte(text)), "complete": true, "truncated": false, "retainedImages": []any{}, "bindings": []any{map[string]any{"imageId": imageID, "start": 0, "end": len(text), "part": map[string]any{"type": "image", "imageId": imageID, "resourceId": imageID, "label": "original"}}}}},
	}))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := sp.MarshalWire(repaired)
	if err != nil {
		t.Fatal(err)
	}
	in := sp.ArchiveSourceTailRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "8", Kind: "timeline_upsert", Payload: raw}}}
	if out, err := stopped.AppendArchiveSourceTail(t.Context(), in); err != nil || out.LastAckedSourceSeq != "8" {
		t.Fatal(out, err)
	}
	if len(d.resources) != 0 {
		t.Fatal("source checkpoint fabricated an image resource")
	}
	if _, err = stopped.PrepareArchive(t.Context(), sp.ArchivePrepareRequest{Fence: in.Fence, ControllerID: in.ControllerID, ControllerInstanceID: in.ControllerInstanceID}); err != nil {
		t.Fatal(err)
	}
	image, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	length, digest, mime := decimal(int64(len(image))), archiveDigest(image), "image/png"
	resource := sp.Resource{ResourceID: imageID, Status: "available", Name: "original.png", MediaType: &mime, ByteLength: &length, SHA256: &digest}
	body = encode(sp.ArchiveHistoryContent{HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: "8", Entries: []sp.TimelineEntry{repaired}, Resources: []sp.Resource{resource}})
	if _, err = stopped.PutArchiveFile(t.Context(), "history", uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); err != nil {
		t.Fatal(err)
	}
	if _, err = stopped.SealArchive(t.Context()); err == nil {
		t.Fatal("missing repaired image sealed")
	}
	if _, err = stopped.PutArchiveResource(t.Context(), uuid.NewString(), 0, int64(len(image)), digest, digest, image, resource); err != nil {
		t.Fatal(err)
	}
	sealed, err := stopped.SealArchive(t.Context())
	if err != nil || len(sealed.Resources) != 1 {
		t.Fatal(sealed, err)
	}
	timeline := encode(sp.ArchiveTimeline{Entries: []sp.TimelineEntry{repaired}})
	file := sp.ArchiveFileReference{FileID: uuid.NewString(), SHA256: archiveDigest(timeline), ByteLength: decimal(int64(len(timeline)))}
	if _, err = stopped.PutArchiveFile(t.Context(), "timeline", file.FileID, 0, int64(len(timeline)), file.SHA256, file.SHA256, timeline); err != nil {
		t.Fatal(err)
	}
	manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentKind: "native_timeline", RecordID: r.Snapshot.SessionID, Fence: in.Fence, Provider: "codex", ControllerID: in.ControllerID, ControllerInstanceID: in.ControllerInstanceID, Timeline: file, Resources: sealed.Resources, Completeness: "complete"}
	if out, err := stopped.PutArchiveManifest(t.Context(), encode(manifest)); err != nil || out.State != "ready" {
		t.Fatal(out, err)
	}
	if r.Live != nil || r.Snapshot.Lifecycle != "archived" || d.leases != 0 {
		t.Fatal("repair reactivated execution or retained an IO lease")
	}
}
