package session

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type archiveSourceRecoveryDAO struct {
	*archiveFlowDAO
	hashes *sourceCheckpointDAO
	saved  *store.SessionRecord
}

func (d *archiveSourceRecoveryDAO) SessionSourceHash(ctx context.Context, h store.SessionSourceHash) ([]byte, error) {
	return d.hashes.SessionSourceHash(ctx, h)
}
func (d *archiveSourceRecoveryDAO) SaveSessionSourceHash(ctx context.Context, h store.SessionSourceHash) error {
	return d.hashes.SaveSessionSourceHash(ctx, h)
}
func (d *archiveSourceRecoveryDAO) SaveSession(_ context.Context, r store.SessionRecord) error {
	d.saved = &r
	return nil
}

func TestArchiveSourceRecoveryUsesOnlyOriginalStoppedScope(t *testing.T) {
	for _, variant := range []string{"prepared", "before-prepare", "wrong-mode", "invalid-tail", "owner", "controller", "active", "sealed", "history-started", "wrong-epoch", "hash-failure"} {
		t.Run(variant, func(t *testing.T) {
			op, base, r := archiveFlowFixture(t)
			epoch, native := uuid.NewString(), "original-native"
			r.SourceEpoch = &epoch
			d := &archiveSourceRecoveryDAO{archiveFlowDAO: base, hashes: &sourceCheckpointDAO{hashes: map[string][]byte{}}}
			op.execution.archiveRun = func(_ context.Context, _ model.Principal, _, _, _ string, _ bool, work func(*Access) error) error {
				return work(&Access{tx: &operationTx{dao: d}, record: r})
			}
			in := sp.ArchiveSourceTailRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "8", Kind: "state", Payload: encode(sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Activity: "working"})}}}
			switch variant {
			case "before-prepare":
				d.bundle = nil
			case "wrong-mode":
				op.mode = ArchiveV1Read
			case "invalid-tail":
				in.Events = nil
			case "owner":
				op.owner = uuid.NewString()
			case "controller":
				in.ControllerID = uuid.NewString()
			case "active":
				r.Snapshot.TestExecutionID, r.Snapshot.Lifecycle = uuid.NewString(), "active"
			case "sealed":
				d.bundle.Phase = "sealed"
			case "history-started":
				d.bundle.HistoryID = uuid.NewString()
			case "wrong-epoch":
				in.SourceEpoch = uuid.NewString()
			case "hash-failure":
				d.hashes.fail = true
			}
			out, e := op.AppendArchiveSourceTail(t.Context(), in)
			if variant != "prepared" && variant != "before-prepare" {
				if e == nil || d.saved != nil {
					t.Fatal("unproven tail proposed a source checkpoint", variant, out, e)
				}
				return
			}
			if e != nil || out.LastAckedSourceSeq != "8" || d.saved == nil || d.saved.SourceSeq != 8 || !sameNative(d.saved.Snapshot.Identity.NativeSessionID, &native) || d.saved.Snapshot.Lifecycle != "archived" {
				t.Fatal("original checkpoint proposal missing", out, d.saved, e)
			}
			if d.bundle != nil {
				var ledger archiveLedger
				if json.Unmarshal(d.bundle.Ledger, &ledger) != nil || ledger.SourceThrough != "8" || ledger.HistoryEpoch != r.Snapshot.HistoryEpoch {
					t.Fatal("prepared source barrier did not follow its original tail", string(d.bundle.Ledger))
				}
			}
		})
	}
}

func publishArchiveRecoveryFixture(t *testing.T, op *ArchiveOperation, r *record) ([]byte, string) {
	t.Helper()
	entry := localEntry(t, "1")
	history := encode(sp.ArchiveHistoryContent{HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: decimal(r.SourceSeq), Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{}})
	if _, e := op.PutArchiveFile(t.Context(), "history", uuid.NewString(), 0, int64(len(history)), archiveDigest(history), archiveDigest(history), history); e != nil {
		t.Fatal(e)
	}
	sealed, e := op.SealArchive(t.Context())
	if e != nil {
		t.Fatal(e)
	}
	timeline := encode(sp.ArchiveTimeline{Entries: []sp.TimelineEntry{entry}})
	fileID := uuid.NewString()
	if _, e = op.PutArchiveFile(t.Context(), "timeline", fileID, 0, int64(len(timeline)), archiveDigest(timeline), archiveDigest(timeline), timeline); e != nil {
		t.Fatal(e)
	}
	manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentKind: "native_timeline", RecordID: op.id, Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID, Provider: r.Snapshot.Identity.Provider, Timeline: sp.ArchiveFileReference{FileID: fileID, SHA256: archiveDigest(timeline), ByteLength: decimal(int64(len(timeline)))}, Resources: sealed.Resources, Completeness: "complete"}
	if _, e = op.PutArchiveManifest(t.Context(), encode(manifest)); e != nil {
		t.Fatal(e)
	}
	return timeline, fileID
}

func TestArchiveTimelineRecoveryRechecksStoredIdentityAndReleasesReadLease(t *testing.T) {
	for _, variant := range []string{"original", "wrong-file", "not-ready", "invalid-ledger", "incomplete-file", "missing-file", "corrupt-file", "changed-ledger"} {
		t.Run(variant, func(t *testing.T) {
			op, d, r := archiveFlowFixture(t)
			timeline, fileID := publishArchiveRecoveryFixture(t, op, r)
			op.execution.archivePreflightRun = func(context.Context, model.Principal, string, string, string, ArchiveMode) (string, error) {
				return r.Owner, nil
			}
			switch variant {
			case "wrong-file":
				fileID = uuid.NewString()
			case "not-ready":
				d.status.State = "pending"
			case "invalid-ledger":
				d.bundle.Ledger = []byte(`{`)
			case "incomplete-file":
				file := d.files[fileID]
				file.State = "receiving"
				d.files[fileID] = file
			case "missing-file":
				if e := op.execution.files.Delete(t.Context(), archiveBucket, archiveFilePath(d.files[fileID])); e != nil {
					t.Fatal(e)
				}
			case "corrupt-file":
				if _, e := op.execution.files.Put(t.Context(), archiveBucket, archiveFilePath(d.files[fileID]), bytes.NewReader([]byte("corrupt"))); e != nil {
					t.Fatal(e)
				}
			case "changed-ledger":
				var ledger archiveLedger
				if e := json.Unmarshal(d.bundle.Ledger, &ledger); e != nil {
					t.Fatal(e)
				}
				ledger.Entries[0].SHA256 = archiveDigest([]byte("another original"))
				d.bundle.Ledger = encode(ledger)
			}
			reservation, e := op.execution.TryReserveArchivePreflight()
			if e != nil {
				t.Fatal(e)
			}
			retained, e := op.execution.ArchiveTimelineContentReserved(t.Context(), op.principal, "", "", op.id, fileID, reservation)
			if variant == "original" {
				if e != nil || retained == nil || !bytes.Equal(retained.Data, timeline) || d.leases != 1 {
					t.Fatal("original timeline was not retained", retained, e, d.leases)
				}
				if e = retained.Close(); e != nil {
					t.Fatal(e)
				}
				if e = retained.Close(); e != nil {
					t.Fatal("read close is not idempotent", e)
				}
			} else if e == nil || retained != nil {
				t.Fatal("unverified timeline was returned", variant, retained, e)
			}
			if d.leases != 0 || len(op.execution.archiveSlots) != 0 || len(op.execution.archivePreflightSlots) != 0 {
				t.Fatal("timeline result leaked its read or capacity lease", d.leases)
			}
		})
	}
}

func TestArchiveRecoveryReceiptsRemainBoundToOriginalOwnerAndRound(t *testing.T) {
	for _, variant := range []string{"original", "owner", "controller", "active", "corrupt-identity", "missing-round", "missing-file"} {
		t.Run(variant, func(t *testing.T) {
			op, d, r := archiveFlowFixture(t)
			_, fileID := publishArchiveRecoveryFixture(t, op, r)
			principal := op.principal
			switch variant {
			case "owner":
				principal.UserID = uuid.NewString()
			case "controller":
				r.Snapshot.Identity.ControllerID = uuid.NewString()
			case "active":
				r.Snapshot.TestExecutionID, r.Snapshot.Lifecycle = uuid.NewString(), "active"
			case "corrupt-identity":
				d.bundle.Identity = []byte(`{`)
			case "missing-round":
				d.bundle = nil
			case "missing-file":
				fileID = uuid.NewString()
			}
			// These operations execute their own authorization; bypass only the
			// fixture's caller assertion so they can observe a foreign principal.
			op.execution.archiveRun = func(_ context.Context, _ model.Principal, _, _, _ string, _ bool, work func(*Access) error) error {
				return work(&Access{tx: &operationTx{dao: d}, record: r})
			}
			prepared, pe := op.execution.ArchivePreparation(t.Context(), principal, "", "", op.id)
			file, fe := op.execution.ArchiveFileStatus(t.Context(), principal, "", "", op.id, fileID)
			if variant == "original" {
				if pe != nil || fe != nil || prepared.Phase != "sealed" || prepared.TimelineRevision == nil || *prepared.TimelineRevision != "1" || file.State != "complete" || file.FileID != fileID {
					t.Fatal(prepared, pe, file, fe)
				}
			} else if variant == "missing-file" {
				if pe != nil || fe == nil {
					t.Fatal("missing file confused original round observation", pe, fe)
				}
			} else if pe == nil || fe == nil {
				t.Fatal("receipt escaped its original owner or stopped round", variant, pe, fe)
			}
		})
	}
}
