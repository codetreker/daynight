package session_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestArchiveBundleDurableIdentityChunksAndMigrationPhases(t *testing.T) {
	database, _, id := sessionArchiveLockFixture(t)
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
		value := store.ArchiveMigration{SessionID: id, MigrationID: migration, SourcePath: "original/schema1", SourceHash: archiveHashOf("source"), TargetPath: "original/manifest", TargetHash: archiveHashOf("target"), Phase: phase}
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
