package session

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func stoppedHistoryOperation(op *ArchiveOperation, r *record) *ArchiveOperation {
	r.Snapshot.Lifecycle, r.Live = "archived", nil
	return &ArchiveOperation{execution: op.execution, principal: op.principal, project: op.project, task: op.task, id: op.id, owner: op.owner, mode: op.mode}
}

type archiveGrantDAO struct {
	*archiveFlowDAO
	rebound int
}

func (d *archiveGrantDAO) RebindSessionArchiveBundle(_ context.Context, id string, previous, next json.RawMessage) error {
	if d.bundle == nil || d.bundle.SessionID != id || !jsonEqual(d.bundle.Identity, previous) || d.bundle.Phase != "active" {
		return archiveConflict()
	}
	d.rebound++
	d.bundle.Identity = append([]byte(nil), next...)
	return nil
}
func (d *archiveGrantDAO) SetSessionGenerationStop(context.Context, string, []byte) error { return nil }
func (d *archiveGrantDAO) SetSessionGrant(context.Context, store.SessionGrant) error      { return nil }
func (d *archiveGrantDAO) SaveSession(context.Context, store.SessionRecord) error         { return nil }

func TestGenerationGrantHandsOffActiveHistoryAndRetainsOriginalRounds(t *testing.T) {
	op, base, r, writer := activeHistoryFixture(t)
	entry := localEntry(t, "1")
	body, firstID := activeHistoryBytes(r, entry), uuid.NewString()
	half := len(body) / 2
	if _, e := op.PutHistoryLedger(t.Context(), writer, firstID, 0, int64(len(body)), archiveDigest(body), archiveDigest(body[:half]), body[:half]); e != nil {
		t.Fatal(e)
	}
	prepareID, epoch := base.bundle.PrepareID, r.Snapshot.HistoryEpoch
	d := &archiveGrantDAO{archiveFlowDAO: base}
	op.execution.archiveRun = func(_ context.Context, _ model.Principal, _, _, _ string, _ bool, work func(*Access) error) error {
		return work(&Access{tx: &operationTx{dao: d}, record: r})
	}
	for _, generation := range []string{"2", "3"} {
		oldWriter, oldInstance, previous := writer, r.Snapshot.Identity.ControllerInstanceID, r.Snapshot.ExecutionGeneration
		grant := sp.Grant{Protocol: sp.Protocol, TestExecutionID: r.Snapshot.TestExecutionID, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: uuid.NewString(), ExecutionGeneration: generation, Kind: "reconnect", PreviousGeneration: &previous, StopProof: &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: oldInstance, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
		result, e := op.execution.grantRecord(t.Context(), &operationTx{dao: d}, op.principal, r, task{}, grant)
		if e != nil || result.ExecutionGeneration != generation || d.bundle.PrepareID != prepareID || r.Snapshot.HistoryEpoch != epoch || r.SourceSeq != 7 {
			t.Fatal("verified generation did not retain the active archive", result, e)
		}
		if _, e = op.PutHistoryLedger(t.Context(), oldWriter, uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e == nil {
			t.Fatal("old generation retained history authority")
		}
		writer = ActiveHistoryWriter{Fence: r.Snapshot.ControllerFence, Credential: result.Token}
		digest := sha256.Sum256([]byte(result.Token))
		r.GrantHash, r.Consumed = digest[:], true
		if _, e = op.PutHistoryLedger(t.Context(), writer, uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e != nil {
			t.Fatal("new generation cannot synchronize its original history", e)
		}
	}
	if d.rebound != 2 || d.files[firstID].State != "failed" || d.files[firstID].AcceptedOffset != int64(half) || len(d.chunks[firstID]) != 1 {
		t.Fatal("handoff changed the old partial round", d.rebound, d.files[firstID])
	}
	stopped := stoppedHistoryOperation(op, r)
	if _, e := stopped.PrepareArchive(t.Context(), sp.ArchivePrepareRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID}); e != nil {
		t.Fatal("recovered generation cannot enter final archival", e)
	}
}

func TestGenerationGrantCannotHandoffWithoutOriginalStopProofOrIdleStorage(t *testing.T) {
	for _, kind := range []string{"proof", "lease", "identity", "sealed"} {
		t.Run(kind, func(t *testing.T) {
			op, base, r, writer := activeHistoryFixture(t)
			body := activeHistoryBytes(r, localEntry(t, "1"))
			if _, e := op.PutHistoryLedger(t.Context(), writer, uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e != nil {
				t.Fatal(e)
			}
			d := &archiveGrantDAO{archiveFlowDAO: base}
			previous := "1"
			grant := sp.Grant{TestExecutionID: r.Snapshot.TestExecutionID, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: uuid.NewString(), ExecutionGeneration: "2", Kind: "reconnect", PreviousGeneration: &previous, StopProof: &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
			switch kind {
			case "proof":
				grant.StopProof.PreviousControllerInstanceID = uuid.NewString()
			case "lease":
				d.leases = 1
			case "identity":
				d.bundle.Identity = []byte(`{}`)
			case "sealed":
				d.bundle.Phase = "sealed"
			}
			if _, e := op.execution.grantRecord(t.Context(), &operationTx{dao: d}, op.principal, r, task{}, grant); e == nil || d.rebound != 0 || r.Snapshot.ExecutionGeneration != "1" {
				t.Fatal("unproven handoff replaced the active writer", e, d.rebound)
			}
		})
	}
}

type archiveHandoffFailureDAO struct{ *archiveFailureDAO }

func (d *archiveHandoffFailureDAO) RebindSessionArchiveBundle(context.Context, string, json.RawMessage, json.RawMessage) error {
	return d.refusal("rebind")
}

func TestArchiveHandoffRetainsDependencyFailures(t *testing.T) {
	for _, kind := range []string{"bundle", "lease-count", "files", "save-file", "rebind"} {
		t.Run(kind, func(t *testing.T) {
			op, base, r, writer := activeHistoryFixture(t)
			body, id := activeHistoryBytes(r, localEntry(t, "1")), uuid.NewString()
			if _, e := op.PutHistoryLedger(t.Context(), writer, id, 0, int64(len(body)), archiveDigest(body), archiveDigest(body[:1]), body[:1]); e != nil {
				t.Fatal(e)
			}
			d := &archiveHandoffFailureDAO{bindArchiveFailureDAO(op, base, r, kind, 0)}
			if e := handoffActiveHistory(t.Context(), &operationTx{dao: d}, r, sp.Grant{ExecutionGeneration: "2", ControllerInstanceID: uuid.NewString()}); !errors.Is(e, archiveDependencyFailure) {
				t.Fatal("handoff lost original storage failure", e)
			}
		})
	}
}

func TestFinalStoppedHistoryRetainsAcknowledgedEntryIdentityAndRevisions(t *testing.T) {
	entry := archiveLedgerEntry{ID: uuid.NewString(), Sequence: "1", Revision: "2", SHA256: "original", SourceSHA256: "source"}
	previous := archiveLedger{HistoryEpoch: "epoch", SourceThrough: "7", Entries: []archiveLedgerEntry{entry}}
	for _, kind := range []string{"same", "append", "update", "epoch", "source-regression", "missing-entry", "identity", "sequence", "revision-regression", "same-revision-content", "same-source-body", "same-source-append"} {
		t.Run(kind, func(t *testing.T) {
			next := previous
			next.Entries = append([]archiveLedgerEntry(nil), previous.Entries...)
			switch kind {
			case "append":
				next.SourceThrough = "8"
				next.Entries = append(next.Entries, archiveLedgerEntry{ID: uuid.NewString(), Sequence: "2", Revision: "1"})
			case "update":
				next.SourceThrough = "8"
				next.Entries[0].Revision = "3"
				next.Entries[0].SHA256 = "updated"
				next.Entries[0].SourceSHA256 = "updated source"
			case "epoch":
				next.HistoryEpoch = "foreign"
			case "source-regression":
				next.SourceThrough = "6"
			case "missing-entry":
				next.Entries = nil
			case "identity":
				next.Entries[0].ID = uuid.NewString()
			case "sequence":
				next.Entries[0].Sequence = "2"
			case "revision-regression":
				next.Entries[0].Revision = "1"
			case "same-revision-content":
				next.Entries[0].SHA256 = "changed"
			case "same-source-body":
				next.Entries[0].Revision = "3"
				next.Entries[0].SourceSHA256 = "changed"
			case "same-source-append":
				next.Entries = append(next.Entries, archiveLedgerEntry{ID: uuid.NewString(), Sequence: "2", Revision: "1"})
			}
			e := verifyStoppedHistoryAdvance(previous, next)
			if (kind == "same" || kind == "append" || kind == "update") != (e == nil) {
				t.Fatal(kind, e)
			}
		})
	}
}

func TestStoppedSourceTailTransitionsAnActiveLedgerBeforeItsFinalHistoryBarrier(t *testing.T) {
	op, base, r, writer := activeHistoryFixture(t)
	entry := localEntry(t, "1")
	body, oldID := activeHistoryBytes(r, entry), uuid.NewString()
	if _, e := op.PutHistoryLedger(t.Context(), writer, oldID, 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e != nil {
		t.Fatal(e)
	}
	previous := append([]byte(nil), base.bundle.Ledger...)
	stopped := stoppedHistoryOperation(op, r)
	epoch := uuid.NewString()
	r.SourceEpoch = &epoch
	d := &archiveSourceRecoveryDAO{archiveFlowDAO: base, hashes: &sourceCheckpointDAO{hashes: map[string][]byte{}}}
	op.execution.archiveRun = func(_ context.Context, _ model.Principal, _, _, _ string, _ bool, work func(*Access) error) error {
		return work(&Access{tx: &operationTx{dao: d}, record: r})
	}
	in := sp.ArchiveSourceTailRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "8", Kind: "state", Payload: encode(sp.State{InitialInputState: "confirmed", Activity: "working"})}}}
	for i := 0; i < 2; i++ {
		out, e := stopped.AppendArchiveSourceTail(t.Context(), in)
		if e != nil || out.LastAckedSourceSeq != "8" || d.bundle.Phase != "settling" || d.bundle.Revision != 2 || d.bundle.HistoryID != "" {
			t.Fatal("original tail or lost-ACK retry cannot reach final sync", out, e, d.bundle)
		}
	}
	var before, after archiveLedger
	if json.Unmarshal(previous, &before) != nil || json.Unmarshal(d.bundle.Ledger, &after) != nil || !jsonEqual(encode(before.Entries), encode(after.Entries)) || before.HistoryID != after.HistoryID || before.SourceThrough != after.SourceThrough {
		t.Fatal("transition discarded the acknowledged ledger")
	}
	prepared, e := stopped.PrepareArchive(t.Context(), sp.ArchivePrepareRequest{Fence: in.Fence, ControllerID: in.ControllerID, ControllerInstanceID: in.ControllerInstanceID})
	if e != nil || prepared.SourceThrough != "8" {
		t.Fatal("final source barrier did not follow replay", prepared, e)
	}
	if _, e = stopped.SealArchive(t.Context()); e == nil {
		t.Fatal("old active ledger sealed without final synchronization")
	}
	body = activeHistoryBytes(r, entry)
	if _, e = stopped.PutArchiveFile(t.Context(), "history", uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e != nil {
		t.Fatal("final checkpoint could not replace the active round", e)
	}
	if _, e = stopped.SealArchive(t.Context()); e != nil {
		t.Fatal(e)
	}
}

func TestStoppedPreparationRetiresInterruptedHistoryWithoutRewritingItsAcknowledgedPrefix(t *testing.T) {
	op, d, r, writer := activeHistoryFixture(t)
	body, oldID := activeHistoryBytes(r, localEntry(t, "1")), uuid.NewString()
	half := len(body) / 2
	if _, e := op.PutHistoryLedger(t.Context(), writer, oldID, 0, int64(len(body)), archiveDigest(body), archiveDigest(body[:half]), body[:half]); e != nil {
		t.Fatal(e)
	}
	old, chunks := d.files[oldID], append([]store.ArchiveBundleChunk(nil), d.chunks[oldID]...)
	stopped := stoppedHistoryOperation(op, r)
	in := sp.ArchivePrepareRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID}
	d.leases = 1
	if _, e := stopped.PrepareArchive(t.Context(), in); e == nil || d.files[oldID].State != "receiving" {
		t.Fatal("retired a round with a live physical writer", e)
	}
	d.leases = 0
	if out, e := stopped.PrepareArchive(t.Context(), in); e != nil || out.Phase != "settling" {
		t.Fatal("stopped partial round blocked final preparation", out, e)
	}
	retired := d.files[oldID]
	old.State = "failed"
	if !jsonEqual(encode(old), encode(retired)) || !jsonEqual(encode(chunks), encode(d.chunks[oldID])) {
		t.Fatal("retirement replaced the original file or acknowledged chunks")
	}
	if _, e := stopped.PutArchiveFile(t.Context(), "history", uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e != nil {
		t.Fatal("final history could not follow a retired active sync", e)
	}
	if _, e := stopped.SealArchive(t.Context()); e != nil {
		t.Fatal(e)
	}
}
