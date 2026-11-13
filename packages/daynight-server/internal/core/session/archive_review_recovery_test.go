package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type archiveReconnectDAO struct{ *archiveFlowDAO }

func (d *archiveReconnectDAO) ConnectSession(context.Context, string, string, time.Time, *time.Time) error {
	return nil
}
func (d *archiveReconnectDAO) SaveSession(context.Context, store.SessionRecord) error { return nil }

func reconnectArchiveFixture(t *testing.T, op *ArchiveOperation, base *archiveFlowDAO, r *record, writer ActiveHistoryWriter) {
	t.Helper()
	d := &archiveReconnectDAO{base}
	op.execution.grantRun = func(ctx context.Context, hash []byte, work func(*Access) error) error {
		want := sha256.Sum256([]byte(writer.Credential))
		if !bytes.Equal(hash, want[:]) {
			t.Fatal("wrong original grant")
		}
		operation, e := op.execution.BeginOperation()
		if e != nil {
			return e
		}
		defer operation.Finish(store.TransactionNotCommitted)
		e = work(&Access{tx: &operationTx{dao: d, op: operation}, record: r})
		if e == nil {
			operation.Finish(store.TransactionCommitted)
		}
		return e
	}
	expiry := time.Now().Add(time.Hour)
	r.GrantExpiry = &expiry
	hello := sp.ControllerMessage{ControllerFence: r.Snapshot.ControllerFence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID, Provider: r.Snapshot.Identity.Provider, SchemaVersion: 1, ProjectionVersion: 1, ContentRevision: 2, SourceEpoch: uuid.NewString(), LastAckedSourceSeq: decimal(r.SourceSeq)}
	if r.SourceEpoch != nil {
		hello.SourceEpoch = *r.SourceEpoch
	}
	if _, e := op.execution.Connect(t.Context(), writer.Credential, hello, uuid.NewString()); e != nil {
		t.Fatal("legitimate original writer could not reconnect", e)
	}
}

func TestArchiveReconnectThenStopRetainsAcknowledgedHistory(t *testing.T) {
	for _, tailFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "prepare-first", true: "source-tail-first"}[tailFirst], func(t *testing.T) {
			op, base, r, writer := activeHistoryFixture(t)
			entry := localEntry(t, "1")
			body, oldID := activeHistoryBytes(r, entry), uuid.NewString()
			if _, e := op.PutHistoryLedger(t.Context(), writer, oldID, 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e != nil {
				t.Fatal(e)
			}
			oldLedger, oldFile := append([]byte(nil), base.bundle.Ledger...), base.files[oldID]
			reconnectArchiveFixture(t, op, base, r, writer)
			reconnectArchiveFixture(t, op, base, r, writer)
			if imageHistoryCurrent(*base.bundle, r) {
				t.Fatal("reconnect admitted old history before a fresh complete sync")
			}
			stopped := stoppedHistoryOperation(op, r)
			d := &archiveSourceRecoveryDAO{archiveFlowDAO: base, hashes: &sourceCheckpointDAO{hashes: map[string][]byte{}}}
			op.execution.archiveRun = func(_ context.Context, _ model.Principal, _, _, _ string, _ bool, work func(*Access) error) error {
				return work(&Access{tx: &operationTx{dao: d}, record: r})
			}
			if tailFirst {
				in := sp.ArchiveSourceTailRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID, SourceEpoch: *r.SourceEpoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "8", Kind: "state", Payload: encode(sp.State{InitialInputState: "confirmed", Activity: "idle"})}}}
				for range 2 {
					if out, e := stopped.AppendArchiveSourceTail(t.Context(), in); e != nil || out.LastAckedSourceSeq != "8" {
						t.Fatal("reconnected stopped tail could not reconcile", out, e)
					}
				}
			}
			prepared, e := stopped.PrepareArchive(t.Context(), sp.ArchivePrepareRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID})
			if e != nil || prepared.HistoryEpoch != r.Snapshot.HistoryEpoch || prepared.SourceThrough != decimal(r.SourceSeq) {
				t.Fatal("reconnected stopped history cannot reach its final sync", prepared, e)
			}
			var before, after archiveLedger
			if json.Unmarshal(oldLedger, &before) != nil || json.Unmarshal(base.bundle.Ledger, &after) != nil || !jsonEqual(encode(before.Entries), encode(after.Entries)) || before.HistoryID != after.HistoryID || !jsonEqual(encode(oldFile), encode(base.files[oldID])) {
				t.Fatal("connection handoff changed the acknowledged prefix or original round")
			}
			body = activeHistoryBytes(r, entry)
			if _, e = stopped.PutArchiveFile(t.Context(), "history", uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e != nil {
				t.Fatal("verified connection handoff rejected its final history", e)
			}
			if _, e = stopped.SealArchive(t.Context()); e != nil {
				t.Fatal(e)
			}
		})
	}
}

func TestArchiveReconnectRejectsCheckpointLosingAcceptedEntries(t *testing.T) {
	op, d, r, writer := activeHistoryFixture(t)
	entry := localEntry(t, "1")
	body := activeHistoryBytes(r, entry)
	if _, err := op.PutHistoryLedger(t.Context(), writer, uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); err != nil {
		t.Fatal(err)
	}
	reconnectArchiveFixture(t, op, d, r, writer)
	before := append([]byte(nil), d.bundle.Ledger...)
	old := activeHistoryBytes(r)
	if _, err := op.PutHistoryLedger(t.Context(), writer, uuid.NewString(), 0, int64(len(old)), archiveDigest(old), archiveDigest(old), old); err == nil {
		t.Fatal("reconnected checkpoint discarded accepted content")
	}
	if !jsonEqual(before, d.bundle.Ledger) {
		t.Fatal("rejected checkpoint changed accepted ledger")
	}
}

func TestArchiveReconnectRetainsIncompleteRoundUntilStoppedSettlement(t *testing.T) {
	op, d, r, writer := activeHistoryFixture(t)
	entry := localEntry(t, "1")
	body, completeID := activeHistoryBytes(r, entry), uuid.NewString()
	if _, e := op.PutHistoryLedger(t.Context(), writer, completeID, 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e != nil {
		t.Fatal(e)
	}
	partialID, half := uuid.NewString(), len(body)/2
	if _, e := op.PutHistoryLedger(t.Context(), writer, partialID, 0, int64(len(body)), archiveDigest(body), archiveDigest(body[:half]), body[:half]); e != nil {
		t.Fatal(e)
	}
	partial, chunks := d.files[partialID], append([]store.ArchiveBundleChunk(nil), d.chunks[partialID]...)
	reconnectArchiveFixture(t, op, d, r, writer)
	if !jsonEqual(encode(partial), encode(d.files[partialID])) || !jsonEqual(encode(chunks), encode(d.chunks[partialID])) {
		t.Fatal("connection replaced an incomplete round")
	}
	stopped := stoppedHistoryOperation(op, r)
	if _, e := stopped.PrepareArchive(t.Context(), sp.ArchivePrepareRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID}); e != nil {
		t.Fatal(e)
	}
	if d.files[partialID].State != "failed" || d.files[partialID].AcceptedOffset != partial.AcceptedOffset || !jsonEqual(encode(chunks), encode(d.chunks[partialID])) {
		t.Fatal("stopped retirement lost the acknowledged partial round")
	}
	body = activeHistoryBytes(r, entry)
	if _, e := stopped.PutArchiveFile(t.Context(), "history", uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e != nil {
		t.Fatal(e)
	}
}

func TestArchiveReconnectCompleteSyncReplacesHandoffTarget(t *testing.T) {
	op, d, r, writer := activeHistoryFixture(t)
	entry := localEntry(t, "1")
	body := activeHistoryBytes(r, entry)
	if _, e := op.PutHistoryLedger(t.Context(), writer, uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e != nil {
		t.Fatal(e)
	}
	reconnectArchiveFixture(t, op, d, r, writer)
	writer.Fence = r.Snapshot.ControllerFence
	body = activeHistoryBytes(r, entry)
	if _, e := op.PutHistoryLedger(t.Context(), writer, uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e != nil {
		t.Fatal(e)
	}
	var ledger archiveLedger
	if json.Unmarshal(d.bundle.Ledger, &ledger) != nil || ledger.FinalHistoryEpoch != "" || ledger.HistoryEpoch != r.Snapshot.HistoryEpoch || !imageHistoryCurrent(*d.bundle, r) {
		t.Fatal("complete current sync retained a stale handoff target", ledger)
	}
}

type archiveSettlementAuditDAO struct {
	*archiveFlowDAO
	calls int
	err   error
}

func (d *archiveSettlementAuditDAO) ListSessionUploadsForSettlement(context.Context, string, time.Time) ([]store.SessionUploadRecord, error) {
	d.calls++
	return nil, d.err
}

func TestArchivePrepareAndSealRequireUploadSettlement(t *testing.T) {
	for _, seal := range []bool{false, true} {
		t.Run(map[bool]string{false: "prepare", true: "seal"}[seal], func(t *testing.T) {
			op, base, r := archiveFlowFixture(t)
			d := &archiveSettlementAuditDAO{archiveFlowDAO: base, err: errors.New("upload settlement unavailable")}
			op.execution.archiveRun = func(_ context.Context, _ model.Principal, _, _, _ string, _ bool, work func(*Access) error) error {
				return work(&Access{tx: &operationTx{dao: d}, record: r})
			}
			before := *base.bundle
			var e error
			if seal {
				_, e = op.SealArchive(t.Context())
			} else {
				_, e = op.PrepareArchive(t.Context(), sp.ArchivePrepareRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID})
			}
			if !errors.Is(e, d.err) || d.calls != 1 || !reflect.DeepEqual(before, *base.bundle) {
				t.Fatal("archive bypassed unsuccessful upload settlement", d.calls, e)
			}
		})
	}
}

func TestArchiveConnectionHandoffRejectsForeignOrRegressedEpochAndBundle(t *testing.T) {
	for _, kind := range []string{"foreign-epoch", "regressed-epoch", "identity", "settling", "timeline", "manifest", "invalid-ledger", "save-error"} {
		t.Run(kind, func(t *testing.T) {
			op, d, r, writer := activeHistoryFixture(t)
			body := activeHistoryBytes(r, localEntry(t, "1"))
			if _, e := op.PutHistoryLedger(t.Context(), writer, uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e != nil {
				t.Fatal(e)
			}
			var ledger archiveLedger
			_ = json.Unmarshal(d.bundle.Ledger, &ledger)
			switch kind {
			case "foreign-epoch":
				r.Snapshot.HistoryEpoch = uuid.NewString()
			case "regressed-epoch":
				ledger.FinalHistoryEpoch = uuid.NewString()
				d.bundle.Ledger = encode(ledger)
			case "identity":
				r.Snapshot.Identity.ControllerInstanceID = uuid.NewString()
			case "settling":
				d.bundle.Phase = "settling"
			case "timeline":
				d.bundle.TimelineID = uuid.NewString()
			case "manifest":
				d.bundle.ManifestPath = "committed/manifest"
			case "invalid-ledger":
				d.bundle.Ledger = []byte(`{`)
			}
			before := *d.bundle
			var dao store.SessionDAO = d
			if kind == "save-error" {
				dao = &archiveFailureDAO{archiveFlowDAO: d, fail: "save-bundle", seen: map[string]int{}}
			}
			if e := handoffConnectedHistory(t.Context(), &operationTx{dao: dao}, r, uuid.NewString()); e == nil {
				t.Fatal("unverified connection changed archive target", kind)
			}
			if !reflect.DeepEqual(before, *d.bundle) {
				t.Fatal("rejected connection mutated the durable archive")
			}
		})
	}
}

type archiveMigrationIdentityDAO struct {
	*archiveFlowDAO
	inserts, conversions int
}

type archiveMigrationCommitChangeDAO struct {
	*archiveMigrationIdentityDAO
	reads  int
	change func(*store.SessionResourceRecord)
}

func (d *archiveMigrationCommitChangeDAO) SavedSessionResource(ctx context.Context, session, id string) (store.SessionResourceRecord, error) {
	d.reads++
	if d.reads == 2 {
		changed := d.resources[id]
		d.change(&changed)
		d.resources[id] = changed
	}
	return d.archiveFlowDAO.SavedSessionResource(ctx, session, id)
}

func TestArchiveMigrationRechecksOriginalIdentityBeforeCommit(t *testing.T) {
	for _, kind := range []string{"descriptor", "blob", "path", "migration", "gc"} {
		t.Run(kind, func(t *testing.T) {
			op, base, r, source, path, resource := legacyArchiveReviewFixture(t)
			saved := store.SessionResourceRecord{SessionID: op.id, Resource: resource, BlobID: uuid.NewString()}
			saved.BlobPath, _ = BlobAddress("", r.Owner, op.id, saved.BlobID)
			if _, e := op.execution.files.Put(t.Context(), "session-resources", saved.BlobPath, bytes.NewReader([]byte("retained legacy original"))); e != nil {
				t.Fatal(e)
			}
			base.resources[resource.ResourceID] = saved
			d := &archiveMigrationCommitChangeDAO{archiveMigrationIdentityDAO: &archiveMigrationIdentityDAO{archiveFlowDAO: base}, change: func(value *store.SessionResourceRecord) {
				switch kind {
				case "descriptor":
					value.Resource.Name = "changed original"
				case "blob":
					value.BlobID = uuid.NewString()
				case "path":
					value.BlobPath += "/changed"
				case "migration":
					value.MigrationID = uuid.NewString()
				case "gc":
					value.GCPending = true
				}
			}}
			op.execution.archiveRun = func(_ context.Context, _ model.Principal, _, _, _ string, _ bool, work func(*Access) error) error {
				return work(&Access{tx: &operationTx{dao: d}, record: r})
			}
			if _, e := op.execution.migrateLegacyArchive(t.Context(), op, source, path); e == nil || d.status.SchemaVersion == 3 || d.inserts != 0 || d.conversions != 0 || d.leases != 0 {
				t.Fatal("changed original identity was committed", kind, e)
			}
		})
	}
}

func (d *archiveMigrationIdentityDAO) InsertSessionResource(ctx context.Context, record store.SessionResourceRecord) error {
	if _, exists := d.resources[record.Resource.ResourceID]; exists {
		return fault("resource_conflict", "Duplicate saved resource identity.")
	}
	d.inserts++
	return d.archiveFlowDAO.InsertSessionResource(ctx, record)
}
func (d *archiveMigrationIdentityDAO) MigrateSessionArchiveResource(_ context.Context, previous, record store.SessionResourceRecord) error {
	old, exists := d.resources[record.Resource.ResourceID]
	if !exists || old.BlobID != "" || old.BlobPath != "" || !jsonEqual(encode(old), encode(previous)) || !jsonEqual(encode(old.Resource), encode(record.Resource)) {
		return archiveConflict()
	}
	d.conversions++
	d.resources[record.Resource.ResourceID] = record
	return nil
}

func legacyArchiveReviewFixture(t *testing.T) (*ArchiveOperation, *archiveFlowDAO, *record, []byte, string, sp.Resource) {
	t.Helper()
	op, d, r := archiveFlowFixture(t)
	d.bundle = nil
	original := []byte("retained legacy original")
	length, digest, mime := decimal(int64(len(original))), archiveDigest(original), "text/plain"
	resource := sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "retained", ByteLength: &length, SHA256: &digest, MediaType: &mime}
	encoded := base64.StdEncoding.EncodeToString(original)
	entry, e := sp.DecodeTimeline(encode(map[string]any{"entryId": uuid.NewString(), "entrySeq": "1", "revision": "1", "kind": "assistant_message", "content": []any{map[string]any{"type": "resource", "resourceId": resource.ResourceID, "label": "retained"}}}))
	if e != nil {
		t.Fatal(e)
	}
	source := encode(sp.ArchiveDocument{SchemaVersion: 1, Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID, Provider: "codex", Entries: []sp.TimelineEntry{entry}, Resources: []sp.ArchiveResource{{Resource: resource, Data: &encoded}}})
	sourceHash, size := archiveDigest(source), decimal(int64(len(source)))
	sourcePath, e := archiveObjectPath("", r.Owner, op.id, sourceHash)
	if e != nil {
		t.Fatal(e)
	}
	d.status, d.archivePath = sp.ArchiveStatus{State: "ready", SHA256: &sourceHash, ByteLength: &size}, sourcePath
	if _, e = op.execution.files.Put(t.Context(), archiveBucket, sourcePath, bytes.NewReader(source)); e != nil {
		t.Fatal(e)
	}
	return op, d, r, source, sourcePath, resource
}

func TestArchiveMigrationDoesNotInsertVerifiedExistingResourceIdentity(t *testing.T) {
	for _, kind := range []string{"inline", "external", "new", "unavailable"} {
		t.Run(kind, func(t *testing.T) {
			op, base, r, source, path, resource := legacyArchiveReviewFixture(t)
			if kind == "unavailable" {
				doc, e := sp.DecodeArchive(source)
				if e != nil {
					t.Fatal(e)
				}
				resource.Status, resource.MediaType, resource.ByteLength, resource.SHA256 = "unavailable", nil, nil, nil
				doc.Resources = []sp.ArchiveResource{{Resource: resource}}
				source = encode(doc)
				hash, size := archiveDigest(source), decimal(int64(len(source)))
				path, _ = archiveObjectPath("", r.Owner, op.id, hash)
				if _, e = op.execution.files.Put(t.Context(), archiveBucket, path, bytes.NewReader(source)); e != nil {
					t.Fatal(e)
				}
				base.status, base.archivePath = sp.ArchiveStatus{State: "ready", SHA256: &hash, ByteLength: &size}, path
			}
			d := &archiveMigrationIdentityDAO{archiveFlowDAO: base}
			saved := store.SessionResourceRecord{SessionID: op.id, Resource: resource}
			if kind == "external" {
				saved.BlobID = uuid.NewString()
				saved.BlobPath, _ = BlobAddress("", r.Owner, op.id, saved.BlobID)
				if _, e := op.execution.files.Put(t.Context(), "session-resources", saved.BlobPath, bytes.NewReader([]byte("retained legacy original"))); e != nil {
					t.Fatal(e)
				}
			}
			if kind != "new" {
				d.resources[resource.ResourceID] = saved
			}
			op.execution.archiveRun = func(_ context.Context, _ model.Principal, _, _, _ string, _ bool, work func(*Access) error) error {
				return work(&Access{tx: &operationTx{dao: d}, record: r})
			}
			manifest, e := op.execution.migrateLegacyArchive(t.Context(), op, source, path)
			if e != nil || len(manifest) == 0 || d.status.SchemaVersion != 3 || d.migration == nil || d.migration.Phase != "verified" {
				t.Fatal("legacy resource identity could not migrate", kind, e)
			}
			if kind != "new" && d.inserts != 0 || kind == "inline" && d.conversions != 1 || kind == "external" && d.resources[resource.ResourceID] != saved {
				t.Fatal("migration replaced an existing original", kind, d.inserts, d.conversions)
			}
			if retry, e := op.execution.migrateLegacyArchive(t.Context(), op, source, path); e != nil || !bytes.Equal(retry, manifest) || kind != "new" && d.inserts != 0 || kind == "new" && d.inserts != 1 || kind == "inline" && d.conversions != 1 {
				t.Fatal("migration retry changed an existing identity", kind, e, d.inserts, d.conversions)
			}
		})
	}
}

func TestArchiveStatusMigratesDeletedTaskOnlyWithinOwnerFinalization(t *testing.T) {
	op, d, r, _, _, _ := legacyArchiveReviewFixture(t)
	preflightModes := []ArchiveMode{}
	op.execution.archivePreflightRun = func(_ context.Context, p model.Principal, _, _, _ string, mode ArchiveMode) (string, error) {
		preflightModes = append(preflightModes, mode)
		if mode != ArchiveV1Upload || p != op.principal {
			return "", fault("not_found", "Task was deleted.")
		}
		return r.Owner, nil
	}
	op.execution.archiveRun = func(_ context.Context, p model.Principal, _, _, _ string, finalize bool, work func(*Access) error) error {
		if !finalize || p != op.principal {
			return fault("not_found", "Task was deleted.")
		}
		return work(&Access{tx: &operationTx{dao: d}, record: r})
	}
	status, e := op.execution.ArchiveStatus(t.Context(), op.principal, "", "", op.id)
	if e != nil || status.SchemaVersion != 3 || status.Migration == nil || status.Migration.SourceSHA256 == "" {
		t.Fatal("owner could not reconcile the legacy receipt after task deletion", status, e, preflightModes)
	}
	if retained, e := op.execution.ArchiveContent(t.Context(), op.principal, "", "", op.id); e == nil || retained != nil {
		t.Fatal("deleted task content became visible to an ordinary reader", retained, e)
	}
	if len(preflightModes) != 2 || preflightModes[0] != ArchiveV1Upload || preflightModes[1] != ArchiveV1Read {
		t.Fatal("status migration changed the public content preflight", preflightModes)
	}
	if d.leases != 0 || len(op.execution.archiveSlots) != 0 {
		t.Fatal("receipt reconciliation leaked its permits")
	}
}
