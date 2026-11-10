package session_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestUnifiedArchiveNativeIdentityAndReadyCommitTogether(t *testing.T) {
	database, _, id := sessionArchiveLockFixture(t)
	ctx := t.Context()
	native, digest, path := "native-created-after-last-ack", archiveHashOf("manifest"), "original/manifest"
	bundle := store.ArchiveBundle{SessionID: id, PrepareID: uuid.NewString(), Phase: "sealed", Revision: 7, Identity: json.RawMessage(`{"controller":"original"}`), Resources: json.RawMessage(`[]`), Ledger: json.RawMessage(`{}`), ManifestHash: digest, ManifestPath: path, ManifestLength: "8"}
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		return dao.(store.SessionArchiveDAO).SaveSessionArchiveBundle(ctx, bundle)
	})
	rejected := errors.New("reject archive adoption transaction")
	for _, phase := range []string{"rollback", "commit", "retry"} {
		t.Run(phase, func(t *testing.T) {
			completion, e := database.WriteSession(ctx, func(scope store.SessionScope) error {
				dao := scope.SessionDAO()
				record, e := dao.LockSession(ctx, id)
				if e != nil {
					return e
				}
				archive := dao.(store.SessionArchiveDAO)
				if e = archive.SetUnifiedSessionArchiveReady(ctx, id, digest, 8, path, "complete"); e != nil {
					return e
				}
				record.Snapshot.Identity.NativeSessionID = &native
				if e = dao.SaveSession(ctx, record); e != nil {
					return e
				}
				candidate := bundle
				candidate.Phase = "committed"
				if e = archive.SaveSessionArchiveBundle(ctx, candidate); e != nil {
					return e
				}
				if phase == "rollback" {
					return rejected
				}
				return nil
			})
			if phase == "rollback" {
				if completion.Outcome != store.TransactionNotCommitted || !errors.Is(e, rejected) {
					t.Fatal("archive adoption rollback outcome", completion, e)
				}
			} else if e != nil || completion.Outcome != store.TransactionCommitted {
				t.Fatal("archive adoption commit outcome", completion, e)
			}
			sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
				record, e := dao.LockSession(ctx, id)
				if e != nil {
					return e
				}
				status, storedPath, e := dao.SessionArchive(ctx, id)
				if e != nil {
					return e
				}
				saved, e := dao.(store.SessionArchiveDAO).SessionArchiveBundle(ctx, id)
				if e != nil {
					return e
				}
				if record.Snapshot.ExecutionGeneration != "1" || saved.PrepareID != bundle.PrepareID || saved.Revision != bundle.Revision {
					t.Fatal("adoption replaced original generation or preparation", record.Snapshot, saved)
				}
				if phase == "rollback" {
					if record.Snapshot.Identity.NativeSessionID != nil || status.State != "unavailable" || saved.Phase != "sealed" {
						t.Fatal("native identity, ready status or bundle partially committed", record.Snapshot, status, saved)
					}
				} else if record.Snapshot.Identity.NativeSessionID == nil || *record.Snapshot.Identity.NativeSessionID != native || status.State != "ready" || status.SchemaVersion != 3 || status.SHA256 == nil || *status.SHA256 != digest || status.ByteLength == nil || *status.ByteLength != "8" || storedPath != path || saved.Phase != "committed" {
					t.Fatal("original archive adoption did not survive readback", record.Snapshot, status, saved)
				}
				return nil
			})
		})
	}
}

func TestStoppedSourceNativeCheckpointPreservesUnknownOperation(t *testing.T) {
	database, _, id := sessionArchiveLockFixture(t)
	ctx := t.Context()
	epoch, operationID, batchID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	native := "native-created-after-last-ack"
	var original store.SessionOperation
	sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
		record, e := dao.LockSession(ctx, id)
		if e != nil {
			return e
		}
		original = store.SessionOperation{SessionID: id, OperationID: operationID, Seq: 1, Hash: []byte("original"), Actor: model.Principal{Kind: model.PATCredential, UserID: record.Owner, CredentialID: uuid.NewString()}, Command: sp.Command{Fence: record.Snapshot.Fence, Protocol: sp.Protocol, OperationID: operationID, Kind: "send_message", Payload: json.RawMessage(`{}`)}, Receipt: sp.Operation{Fence: record.Snapshot.Fence, Protocol: sp.Protocol, OperationID: operationID, Kind: "send_message", State: "unknown"}}
		if e = dao.InsertSessionOperation(ctx, original); e != nil {
			return e
		}
		record.SourceEpoch, record.SourceEpochs, record.OperationSeq = &epoch, []string{epoch}, 1
		if e = dao.SaveSession(ctx, record); e != nil {
			return e
		}
		original, e = dao.SessionOperation(ctx, id, operationID)
		return e
	})
	var originalReceipt []byte
	if e := database.Pool.QueryRow(ctx, `SELECT receipt FROM session_operations WHERE session_id=$1 AND operation_id=$2`, id, operationID).Scan(&originalReceipt); e != nil {
		t.Fatal(e)
	}
	initial, _ := json.Marshal(sp.State{InitialInputState: "not_submitted", Activity: "initializing"})
	final, _ := json.Marshal(sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Activity: "working", Synchronized: true})
	events := []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: initial}, {SourceSeq: "2", Kind: "state", Payload: final}}
	hashes := []store.SessionSourceHash{}
	for _, event := range events {
		encoded, _ := json.Marshal(event)
		hash := sha256.Sum256(encoded)
		hashes = append(hashes, store.SessionSourceHash{SessionID: id, SourceEpoch: epoch, Kind: "event", Identity: event.SourceSeq, Through: int64(len(hashes) + 1), Digest: hash[:]})
	}
	encoded, _ := json.Marshal(events)
	batchHash := sha256.Sum256(encoded)
	hashes = append(hashes, store.SessionSourceHash{SessionID: id, SourceEpoch: epoch, Kind: "batch", Identity: batchID, Through: 2, Digest: batchHash[:]})
	rejected := errors.New("reject stopped source transaction")
	for _, phase := range []string{"rollback", "commit", "retry"} {
		t.Run(phase, func(t *testing.T) {
			completion, e := database.WriteSession(ctx, func(scope store.SessionScope) error {
				dao := scope.SessionDAO()
				record, e := dao.LockSession(ctx, id)
				if e != nil {
					return e
				}
				for _, hash := range hashes {
					if e = dao.(store.SessionSourceDAO).SaveSessionSourceHash(ctx, hash); e != nil {
						return e
					}
				}
				record.Snapshot.Identity.NativeSessionID, record.SourceSeq = &native, 2
				if e = dao.SaveSession(ctx, record); e != nil {
					return e
				}
				if phase == "rollback" {
					return rejected
				}
				return nil
			})
			if phase == "rollback" {
				if completion.Outcome != store.TransactionNotCommitted || !errors.Is(e, rejected) {
					t.Fatal("source checkpoint rollback outcome", completion, e)
				}
			} else if e != nil || completion.Outcome != store.TransactionCommitted {
				t.Fatal("source checkpoint commit outcome", completion, e)
			}
			sessionDAOTransaction(t, database, func(dao store.SessionDAO) error {
				record, e := dao.LockSession(ctx, id)
				if e != nil {
					return e
				}
				operation, e := dao.SessionOperation(ctx, id, operationID)
				if e != nil {
					return e
				}
				if !reflect.DeepEqual(operation, original) || record.OperationSeq != 1 || record.Snapshot.Fence != original.Receipt.Fence || record.Snapshot.Lifecycle != "archived" {
					t.Fatal("source checkpoint changed the original unknown operation", operation, record)
				}
				if phase == "rollback" {
					if record.SourceSeq != 0 || record.Snapshot.Identity.NativeSessionID != nil {
						t.Fatal("rolled back native checkpoint survived", record)
					}
				} else if record.SourceSeq != 2 || record.Snapshot.Identity.NativeSessionID == nil || *record.Snapshot.Identity.NativeSessionID != native {
					t.Fatal("native checkpoint did not survive readback", record)
				}
				return nil
			})
			var receipt []byte
			var operations, sourceHashes int
			if e := database.Pool.QueryRow(ctx, `SELECT receipt,(SELECT count(*) FROM session_operations WHERE session_id=$1),(SELECT count(*) FROM session_source_hashes WHERE session_id=$1) FROM session_operations WHERE session_id=$1 AND operation_id=$2`, id, operationID).Scan(&receipt, &operations, &sourceHashes); e != nil || !bytes.Equal(receipt, originalReceipt) || operations != 1 || phase == "rollback" && sourceHashes != 0 || phase != "rollback" && sourceHashes != 3 {
				t.Fatal("original operation receipt or source ACK identities changed", phase, string(receipt), operations, sourceHashes, e)
			}
		})
	}
}
