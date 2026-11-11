package session_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
)

func TestSessionArchiveStore(t *testing.T) {
	suite := newSessionStoreSuite(t)
	suite.run(t, "ActiveArchiveWriterHandoffComparesOriginalOwnerAndRetainsFileReceipts", testActiveArchiveWriterHandoffComparesOriginalOwnerAndRetainsFileReceipts)
	suite.run(t, "ArchiveBundleDurableIdentityChunksAndMigrationPhases", testArchiveBundleDurableIdentityChunksAndMigrationPhases)
	suite.run(t, "SessionTerminalHistoryRetainsMixedBackendsAndOriginalArchive", testSessionTerminalHistoryRetainsMixedBackendsAndOriginalArchive)
	suite.run(t, "ArchiveFileInventoryAndImmutableWrites", testArchiveFileInventoryAndImmutableWrites)
	suite.run(t, "SourceAcknowledgementLedgerCountAndCanceledStorageCalls", testSourceAcknowledgementLedgerCountAndCanceledStorageCalls)
	suite.run(t, "UnifiedArchiveNativeIdentityAndReadyCommitTogether", testUnifiedArchiveNativeIdentityAndReadyCommitTogether)
	suite.run(t, "StoppedSourceNativeCheckpointPreservesUnknownOperation", testStoppedSourceNativeCheckpointPreservesUnknownOperation)
	suite.run(t, "ArchiveResourceMigrationMapsOriginalNullAndExplicitMigrationIdentity/null_migration", func(t *testing.T, db *postgres.Store) {
		testArchiveResourceMigrationMapsOriginalNullAndExplicitMigrationIdentity(t, db, "")
	})
	suite.run(t, "ArchiveResourceMigrationMapsOriginalNullAndExplicitMigrationIdentity/existing_migration", func(t *testing.T, db *postgres.Store) {
		testArchiveResourceMigrationMapsOriginalNullAndExplicitMigrationIdentity(t, db, uuid.NewString())
	})
	suite.run(t, "ArchiveInlineMigrationComparesOriginalAndRemovesInlineCopy", testArchiveInlineMigrationComparesOriginalAndRemovesInlineCopy)
	suite.run(t, "ArchiveConnectionEpochAndConsumedGrantCommitTogether", testArchiveConnectionEpochAndConsumedGrantCommitTogether)
	suite.run(t, "ArchiveResetRetainsUnavailableResourceAndReusesItsUniqueRow", testArchiveResetRetainsUnavailableResourceAndReusesItsUniqueRow)
	suite.run(t, "ArchiveUnavailableInlinePresenceIsMetadataOnly", testArchiveUnavailableInlinePresenceIsMetadataOnly)
	suite.run(t, "SessionDAOTerminalLedgerEvidenceAndHistory", testSessionDAOTerminalLedgerEvidenceAndHistory)
}

func testActiveArchiveWriterHandoffComparesOriginalOwnerAndRetainsFileReceipts(t *testing.T, db *postgres.Store) {
	database := db
	_, id := prepareArchiveSession(t, database)
	ctx := t.Context()
	previous, next := json.RawMessage(`{"controller":"generation-one"}`), json.RawMessage(`{"controller":"generation-two"}`)
	fileID := uuid.NewString()
	bundle := store.ArchiveBundle{SessionID: id, PrepareID: uuid.NewString(), Phase: "active", Revision: 7, Identity: previous, Resources: json.RawMessage(`[]`), Ledger: json.RawMessage(`{"sourceThrough":"19"}`), HistoryID: fileID}
	file := store.ArchiveBundleFile{SessionID: id, FileID: fileID, Purpose: "history", SHA256: archiveHashOf("original"), ByteLength: 8, AcceptedOffset: 4, State: "failed", Path: "original/history"}
	chunk := store.ArchiveBundleChunk{SessionID: id, FileID: fileID, Offset: 0, ByteLength: 4, SHA256: archiveHashOf("orig"), Path: "original/chunk"}
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		dao := base.(store.SessionArchiveDAO)
		if e := dao.SaveSessionArchiveBundle(ctx, bundle); e != nil {
			return e
		}
		if e := dao.SaveSessionArchiveFile(ctx, file); e != nil {
			return e
		}
		return dao.InsertSessionArchiveChunk(ctx, chunk)
	})
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		rebind := base.(store.SessionArchiveHandoffDAO)
		if e := rebind.RebindSessionArchiveBundle(ctx, id, previous, next); e != nil {
			return e
		}
		e := rebind.RebindSessionArchiveBundle(ctx, id, previous, json.RawMessage(`{"controller":"replacement"}`))
		var fault *model.Fault
		if !errors.As(e, &fault) || fault.Code != "archive_conflict" {
			t.Fatal("stale owner replaced the handoff", e)
		}
		return nil
	})
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, e := database.WriteSession(ctx, func(scope store.SessionScope) error {
		return scope.SessionDAO().(store.SessionArchiveHandoffDAO).RebindSessionArchiveBundle(canceled, id, next, previous)
	}); !errors.Is(e, context.Canceled) {
		t.Fatal("handoff lost canceled query", e)
	}
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		dao := base.(store.SessionArchiveDAO)
		saved, e := dao.SessionArchiveBundle(ctx, id)
		if e != nil {
			return e
		}
		if saved.PrepareID != bundle.PrepareID || saved.Revision != bundle.Revision || saved.HistoryID != fileID || string(saved.Identity) != `{"controller": "generation-two"}` || string(saved.Ledger) != `{"sourceThrough": "19"}` {
			t.Fatal("handoff replaced prior archive identities", saved)
		}
		stored, e := dao.SessionArchiveFile(ctx, id, fileID)
		if e != nil {
			return e
		}
		chunks, e := dao.SessionArchiveChunks(ctx, id, fileID)
		if e != nil {
			return e
		}
		if stored.State != "failed" || stored.AcceptedOffset != 4 || len(chunks) != 1 || chunks[0] != chunk {
			t.Fatal("handoff lost acknowledged file data", stored, chunks)
		}
		saved.Phase = "sealed"
		if e = dao.SaveSessionArchiveBundle(ctx, saved); e != nil {
			return e
		}
		if e = base.(store.SessionArchiveHandoffDAO).RebindSessionArchiveBundle(ctx, id, next, previous); e == nil {
			t.Fatal("sealed archive changed writer")
		}
		return nil
	})
}

func testArchiveBundleDurableIdentityChunksAndMigrationPhases(t *testing.T, db *postgres.Store) {
	database := db
	_, id := prepareArchiveSession(t, database)
	ctx := t.Context()
	prepare, fileID, migration := uuid.NewString(), uuid.NewString(), uuid.NewString()
	bundle := store.ArchiveBundle{SessionID: id, PrepareID: prepare, Phase: "settling", Revision: 1, Identity: json.RawMessage(`{"controller":"original"}`), Resources: json.RawMessage(`[]`), Ledger: json.RawMessage(`{"sourceThrough":"7"}`)}
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		return base.(store.SessionArchiveDAO).SaveSessionArchiveBundle(ctx, bundle)
	})
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		dao := base.(store.SessionArchiveDAO)
		saved, e := dao.SessionArchiveBundle(ctx, id)
		if e != nil {
			return e
		}
		if saved.PrepareID != prepare || saved.Phase != "settling" || saved.Revision != 1 || string(saved.Ledger) != `{"sourceThrough": "7"}` {
			t.Fatalf("unexpected persisted bundle: %+v", saved)
		}
		return nil
	})
	// A rejected immutable identity is not reported as a successful no-op.
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		changed := bundle
		changed.PrepareID = uuid.NewString()
		if e := base.(store.SessionArchiveDAO).SaveSessionArchiveBundle(ctx, changed); e == nil {
			t.Fatal("replacement prepare accepted")
		}
		return nil
	})
	file := store.ArchiveBundleFile{SessionID: id, FileID: fileID, Purpose: "timeline", SHA256: archiveHashOf("original"), ByteLength: 8, State: "receiving", Path: "original/file"}
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		return base.(store.SessionArchiveDAO).SaveSessionArchiveFile(ctx, file)
	})
	chunk := store.ArchiveBundleChunk{SessionID: id, FileID: fileID, Offset: 0, ByteLength: 8, SHA256: archiveHashOf("original"), Path: "original/chunk"}
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		dao := base.(store.SessionArchiveDAO)
		if e := dao.InsertSessionArchiveChunk(ctx, chunk); e != nil {
			return e
		}
		if e := dao.InsertSessionArchiveChunk(ctx, chunk); e != nil {
			return e
		}
		file.AcceptedOffset = 8
		file.State = "complete"
		return dao.SaveSessionArchiveFile(ctx, file)
	})
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		dao := base.(store.SessionArchiveDAO)
		chunks, e := dao.SessionArchiveChunks(ctx, id, fileID)
		if e != nil {
			return e
		}
		saved, e := dao.SessionArchiveFile(ctx, id, fileID)
		if e != nil {
			return e
		}
		if len(chunks) != 1 || chunks[0] != chunk || saved.State != "complete" || saved.AcceptedOffset != 8 {
			t.Fatalf("original file receipt lost: %+v %+v", chunks, saved)
		}
		changed := chunk
		changed.SHA256 = archiveHashOf("changed!")
		if e = dao.InsertSessionArchiveChunk(ctx, changed); e == nil {
			t.Fatal("different chunk accepted")
		}
		return nil
	})
	for _, phase := range []string{"prepared", "files_durable", "committed", "verified"} {
		value := store.ArchiveMigration{SessionID: id, MigrationID: migration, SourcePath: "original/schema1", SourceHash: archiveHashOf("source"), SourceLength: 6, TargetPath: "original/manifest", TargetHash: archiveHashOf("target"), Phase: phase}
		sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
			return base.(store.SessionArchiveDAO).SaveSessionArchiveMigration(ctx, value)
		})
		sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
			saved, e := base.(store.SessionArchiveDAO).SessionArchiveMigration(ctx, id)
			if e != nil {
				return e
			}
			if saved != value {
				t.Fatalf("migration phase readback differs: %+v", saved)
			}
			return nil
		})
	}
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		dao := base.(store.SessionArchiveDAO)
		if e := dao.SetUnifiedSessionArchiveReady(ctx, id, archiveHashOf("manifest"), 8, "original/manifest", "complete"); e != nil {
			return e
		}
		status, path, e := base.SessionArchive(ctx, id)
		if e != nil {
			return e
		}
		if status.State != "ready" || status.SchemaVersion != 3 || status.Completeness == nil || *status.Completeness != "complete" || path != "original/manifest" {
			t.Fatalf("unified ready receipt: %+v %s", status, path)
		}
		return nil
	})
}

func archiveHashOf(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func testArchiveFileInventoryAndImmutableWrites(t *testing.T, db *postgres.Store) {
	database := db
	_, id := prepareArchiveSession(t, database)
	ctx := t.Context()
	first, second := uuid.NewString(), uuid.NewString()
	if first > second {
		first, second = second, first
	}
	file := store.ArchiveBundleFile{SessionID: id, FileID: first, Purpose: "timeline", SHA256: archiveHashOf("original"), ByteLength: 8, State: "receiving", Path: "original/timeline"}
	migration := store.ArchiveMigration{SessionID: id, MigrationID: uuid.NewString(), SourcePath: "original/source", SourceHash: archiveHashOf("source"), SourceLength: 6, TargetPath: "original/target", TargetHash: archiveHashOf("target"), Phase: "prepared"}
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		dao := base.(store.SessionArchiveDAO)
		if e := dao.SaveSessionArchiveFile(ctx, file); e != nil {
			return e
		}
		other := file
		other.FileID = second
		other.Path = "original/second"
		other.State = "failed"
		if e := dao.SaveSessionArchiveFile(ctx, other); e != nil {
			return e
		}
		changed := file
		changed.SHA256 = archiveHashOf("changed!")
		if e := dao.SaveSessionArchiveFile(ctx, changed); e == nil {
			t.Fatal("same file identity accepted changed original")
		}
		if e := dao.SaveSessionArchiveMigration(ctx, migration); e != nil {
			return e
		}
		changedMigration := migration
		changedMigration.SourceHash = archiveHashOf("another source")
		if e := dao.SaveSessionArchiveMigration(ctx, changedMigration); e == nil {
			t.Fatal("migration accepted replacement original")
		}
		changedMigration = migration
		changedMigration.SourceLength++
		if e := dao.SaveSessionArchiveMigration(ctx, changedMigration); e == nil {
			t.Fatal("migration accepted changed original byte length")
		}
		return nil
	})
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		dao := base.(store.SessionArchiveDAO)
		files, e := dao.SessionArchiveFiles(ctx, id)
		if e != nil {
			return e
		}
		if len(files) != 2 || files[0].FileID != first || files[1].FileID != second || files[0].SHA256 != file.SHA256 {
			t.Fatal("inventory lost canonical file order or immutable content", files)
		}
		saved, e := dao.SessionArchiveMigration(ctx, id)
		if e != nil {
			return e
		}
		if saved != migration {
			t.Fatal("rejected replacement changed the saved migration", saved)
		}
		return nil
	})
}

func TestArchiveReadyDoesNotReportSuccessWhenStorageDeclinesWrite(t *testing.T) {
	database := isolatedStore(t)
	_, id := prepareArchiveSession(t, database)
	ctx := t.Context()
	// This database belongs to the test. A declining trigger supplies PostgreSQL's
	// successful-command/zero-written-row outcome without replacing the real DAO.
	if _, e := database.Pool.Exec(ctx, `CREATE FUNCTION refuse_ready_fixture() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NULL; END'; CREATE TRIGGER refuse_ready_fixture BEFORE INSERT ON session_archives FOR EACH ROW EXECUTE FUNCTION refuse_ready_fixture()`); e != nil {
		t.Fatal(e)
	}
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		if e := base.(store.SessionArchiveDAO).SetUnifiedSessionArchiveReady(ctx, id, archiveHashOf("manifest"), 8, "original/manifest", "complete"); e == nil {
			t.Fatal("zero-written-row outcome became a ready receipt")
		}
		return nil
	})
	var count int
	if e := database.Pool.QueryRow(ctx, `SELECT count(*) FROM session_archives WHERE session_id=$1`, id).Scan(&count); e != nil || count != 0 {
		t.Fatal(count, e)
	}
}

func testUnifiedArchiveNativeIdentityAndReadyCommitTogether(t *testing.T, db *postgres.Store) {
	database := db
	_, id := prepareArchiveSession(t, database)
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

func testStoppedSourceNativeCheckpointPreservesUnknownOperation(t *testing.T, db *postgres.Store) {
	database := db
	_, id := prepareArchiveSession(t, database)
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

func testArchiveConnectionEpochAndConsumedGrantCommitTogether(t *testing.T, db *postgres.Store) {
	database := db
	_, id := prepareArchiveSession(t, database)
	ctx := t.Context()
	fileID := uuid.NewString()
	bundle := store.ArchiveBundle{SessionID: id, PrepareID: uuid.NewString(), Phase: "active", Revision: 9, Identity: json.RawMessage(`{"controller":"original"}`), Resources: json.RawMessage(`[]`), Ledger: json.RawMessage(`{"HistoryEpoch":"original","HistoryID":"` + fileID + `","Entries":[]}`), HistoryID: fileID}
	file := store.ArchiveBundleFile{SessionID: id, FileID: fileID, Purpose: "history", SHA256: archiveHashOf("original"), ByteLength: 8, AcceptedOffset: 4, State: "receiving", Path: "original/round"}
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		if e := base.(store.SessionArchiveDAO).SaveSessionArchiveBundle(ctx, bundle); e != nil {
			return e
		}
		return base.(store.SessionArchiveDAO).SaveSessionArchiveFile(ctx, file)
	})
	for _, commit := range []bool{false, true} {
		tx, e := database.Pool.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		func() {
			defer rollbackSessionTestTransaction(t, tx)
			dao := pgsession.New(tx)
			r, e := dao.LockSession(ctx, id)
			if e != nil {
				t.Fatal(e)
			}
			changed := bundle
			changed.Ledger = json.RawMessage(`{"HistoryEpoch":"original","FinalHistoryEpoch":"connected","HistoryID":"` + fileID + `","Entries":[]}`)
			if e = dao.(store.SessionArchiveDAO).SaveSessionArchiveBundle(ctx, changed); e != nil {
				t.Fatal(e)
			}
			r.Snapshot.HistoryEpoch = "connected"
			if e = dao.ConnectSession(ctx, id, uuid.NewString(), time.Now(), nil); e != nil {
				t.Fatal(e)
			}
			if e = dao.SaveSession(ctx, r); e != nil {
				t.Fatal(e)
			}
			if commit {
				if e = tx.Commit(ctx); e != nil {
					t.Fatal(e)
				}
			}
		}()
		sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
			r, e := base.LockSession(ctx, id)
			if e != nil {
				return e
			}
			saved, e := base.(store.SessionArchiveDAO).SessionArchiveBundle(ctx, id)
			if e != nil {
				return e
			}
			var ledger map[string]any
			_ = json.Unmarshal(saved.Ledger, &ledger)
			if commit != r.Consumed || commit != (r.Snapshot.HistoryEpoch == "connected") || commit != (ledger["FinalHistoryEpoch"] == "connected") || saved.HistoryID != fileID || saved.Revision != bundle.Revision {
				t.Fatal("connection partially published its archive handoff", commit, r.Consumed, r.Snapshot.HistoryEpoch, saved)
			}
			storedFile, e := base.(store.SessionArchiveDAO).SessionArchiveFile(ctx, id, fileID)
			if e != nil || storedFile.State != file.State || storedFile.AcceptedOffset != file.AcceptedOffset {
				t.Fatal("epoch handoff replaced the partial file receipt", storedFile, e)
			}
			return nil
		})
	}
}

func testArchiveResetRetainsUnavailableResourceAndReusesItsUniqueRow(t *testing.T, db *postgres.Store) {
	database := db
	_, id := prepareArchiveSession(t, database)
	ctx := t.Context()
	reason := "Original bytes were never captured."
	descriptor := sp.Resource{ResourceID: uuid.NewString(), Status: "unavailable", Name: "legacy-missing", Error: &reason}
	raw, e := json.Marshal(descriptor)
	if e != nil {
		t.Fatal(e)
	}
	refs, e := json.Marshal([]sp.ArchiveResourceReference{{Resource: descriptor}})
	if e != nil {
		t.Fatal(e)
	}
	ledger, e := json.Marshal(map[string]any{"HistoryEpoch": "original-history", "SourceThrough": "7", "Sealable": true, "Resources": []sp.Resource{descriptor}, "Entries": []any{}})
	if e != nil {
		t.Fatal(e)
	}
	fileID := uuid.NewString()
	bundle := store.ArchiveBundle{SessionID: id, PrepareID: uuid.NewString(), Phase: "failed", Revision: 1, Identity: json.RawMessage(`{"controller":"original"}`), Resources: refs, Ledger: ledger, TimelineID: fileID}
	original := store.SessionResourceRecord{SessionID: id, Resource: descriptor}
	reference := store.SessionResourceReference{SessionID: id, ResourceID: descriptor.ResourceID, Kind: "archive", ReferenceID: bundle.PrepareID}
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		archive, media := base.(store.SessionArchiveDAO), base.(store.SessionResourceDAO)
		if e := media.InsertSessionResource(ctx, original); e != nil {
			return e
		}
		if e := media.AddSessionResourceReference(ctx, reference); e != nil {
			return e
		}
		if e := archive.SaveSessionArchiveBundle(ctx, bundle); e != nil {
			return e
		}
		return archive.SaveSessionArchiveFile(ctx, store.ArchiveBundleFile{SessionID: id, FileID: fileID, Purpose: "timeline", SHA256: archiveHashOf("invalid timeline"), ByteLength: 16, AcceptedOffset: 16, State: "failed", Path: "original/timeline", TimelineRevision: 1})
	})
	reset := bundle
	reset.Revision, reset.Phase, reset.TimelineID, reset.Resources = 2, "settling", "", json.RawMessage(`[]`)
	rejected := errors.New("reject reset transaction")
	for _, attempt := range []string{"rollback", "commit"} {
		completion, e := database.WriteSession(ctx, func(scope store.SessionScope) error {
			base := scope.SessionDAO()
			if _, e := base.LockSession(ctx, id); e != nil {
				return e
			}
			archive, media := base.(store.SessionArchiveDAO), base.(store.SessionResourceDAO)
			if _, e := archive.SessionArchiveBundle(ctx, id); e != nil {
				return e
			}
			if e := media.RemoveSessionResourceReference(ctx, reference); e != nil {
				return e
			}
			if e := archive.SaveSessionArchiveBundle(ctx, reset); e != nil {
				return e
			}
			if attempt == "rollback" {
				return rejected
			}
			return nil
		})
		if attempt == "rollback" {
			if completion.Outcome != store.TransactionNotCommitted || !errors.Is(e, rejected) {
				t.Fatal(completion, e)
			}
		} else if completion.Outcome != store.TransactionCommitted || e != nil {
			t.Fatal(completion, e)
		}
		sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
			archive, media := base.(store.SessionArchiveDAO), base.(store.SessionResourceDAO)
			saved, e := media.SavedSessionResource(ctx, id, descriptor.ResourceID)
			if e != nil {
				return e
			}
			if !reflect.DeepEqual(saved, original) {
				t.Fatal("reset changed retained unavailable identity", saved)
			}
			stored, e := archive.SessionArchiveBundle(ctx, id)
			if e != nil {
				return e
			}
			var storedLedger any
			if json.Unmarshal(stored.Ledger, &storedLedger) != nil {
				t.Fatal("nonempty ledger lost")
			}
			var expectedLedger any
			_ = json.Unmarshal(ledger, &expectedLedger)
			if !reflect.DeepEqual(storedLedger, expectedLedger) {
				t.Fatal("reset changed unavailable ledger", storedLedger)
			}
			pins, e := media.SessionResourceReferenceCount(ctx, id, descriptor.ResourceID)
			if e != nil {
				return e
			}
			if attempt == "rollback" {
				if stored.Phase != "failed" || stored.Revision != 1 || pins != 1 {
					t.Fatal("reset partially committed", stored, pins)
				}
			} else if stored.Phase != "settling" || stored.Revision != 2 || pins != 0 {
				t.Fatal("reset candidate not durable", stored, pins)
			}
			return nil
		})
	}
	// A reset removes its pin, not the original row: an accidental second INSERT
	// must still fail through PostgreSQL's real primary key.
	completion, e := database.WriteSession(ctx, func(scope store.SessionScope) error {
		return scope.SessionDAO().(store.SessionResourceDAO).InsertSessionResource(ctx, original)
	})
	var conflict *model.Fault
	if e == nil || completion.Outcome != store.TransactionNotCommitted || !errors.As(e, &conflict) || conflict.Code != "resource_conflict" {
		t.Fatal("duplicate original row did not retain real uniqueness", completion, e)
	}
	resealed := reset
	resealed.Phase, resealed.Resources = "sealed", refs
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		media, archive := base.(store.SessionResourceDAO), base.(store.SessionArchiveDAO)
		saved, e := media.SavedSessionResource(ctx, id, descriptor.ResourceID)
		if e != nil {
			return e
		}
		if !reflect.DeepEqual(saved, original) {
			t.Fatal("reused unavailable resource changed")
		}
		if e = media.AddSessionResourceReference(ctx, reference); e != nil {
			return e
		}
		return archive.SaveSessionArchiveBundle(ctx, resealed)
	})
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		media, archive := base.(store.SessionResourceDAO), base.(store.SessionArchiveDAO)
		saved, e := media.SavedSessionResource(ctx, id, descriptor.ResourceID)
		if e != nil {
			return e
		}
		stored, e := archive.SessionArchiveBundle(ctx, id)
		if e != nil {
			return e
		}
		pins, e := media.SessionResourceReferenceCount(ctx, id, descriptor.ResourceID)
		if e != nil {
			return e
		}
		if !reflect.DeepEqual(saved, original) || stored.Phase != "sealed" || stored.Revision != 2 || pins != 1 {
			t.Fatal("reseal candidate failed persisted readback", saved, stored, pins)
		}
		var persisted []sp.ArchiveResourceReference
		if json.Unmarshal(stored.Resources, &persisted) != nil || len(persisted) != 1 || !reflect.DeepEqual(persisted[0].Resource, descriptor) || persisted[0].BlobID != nil {
			t.Fatal("unavailable closure changed", persisted)
		}
		return nil
	})
	var count int
	if e = database.Pool.QueryRow(ctx, `SELECT count(*) FROM session_resources WHERE session_id=$1 AND resource_id=$2 AND descriptor=$3::jsonb AND content IS NULL AND blob_id IS NULL AND blob_path IS NULL`, id, descriptor.ResourceID, raw).Scan(&count); e != nil || count != 1 {
		t.Fatal("unique unavailable row was not retained", count, e)
	}
}

func testArchiveUnavailableInlinePresenceIsMetadataOnly(t *testing.T, db *postgres.Store) {
	database := db
	_, id := prepareArchiveSession(t, database)
	ctx := t.Context()
	descriptor := sp.Resource{ResourceID: uuid.NewString(), Status: "unavailable", Name: "legacy-missing"}
	raw, e := json.Marshal(descriptor)
	if e != nil {
		t.Fatal(e)
	}
	mustQueryExec(t, database, `INSERT INTO session_resources(session_id,resource_id,descriptor) VALUES($1,$2,$3)`, id, descriptor.ResourceID, raw)
	for _, content := range []struct {
		name string
		data []byte
	}{{name: "null"}, {name: "empty", data: []byte{}}, {name: "nonempty", data: []byte("conflicting original")}} {
		t.Run(content.name, func(t *testing.T) {
			mustQueryExec(t, database, `UPDATE session_resources SET content=$3 WHERE session_id=$1 AND resource_id=$2`, id, descriptor.ResourceID, content.data)
			sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
				saved, e := base.(store.SessionResourceDAO).SavedSessionResource(ctx, id, descriptor.ResourceID)
				if e != nil {
					return e
				}
				expected := store.SessionResourceRecord{SessionID: id, Resource: descriptor, HasInlineContent: content.data != nil}
				if !reflect.DeepEqual(saved, expected) {
					t.Fatal("saved resource did not report inline presence without interpreting its descriptor", saved, expected)
				}
				return nil
			})
		})
	}
}
