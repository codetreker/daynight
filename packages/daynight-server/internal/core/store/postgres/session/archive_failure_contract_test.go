package session_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestArchiveFileInventoryAndImmutableWrites(t *testing.T) {
	database, _, id := sessionArchiveLockFixture(t)
	ctx := t.Context()
	first, second := uuid.NewString(), uuid.NewString()
	if first > second {
		first, second = second, first
	}
	file := store.ArchiveBundleFile{SessionID: id, FileID: first, Purpose: "timeline", SHA256: archiveHashOf("original"), ByteLength: 8, State: "receiving", Path: "original/timeline"}
	migration := store.ArchiveMigration{SessionID: id, MigrationID: uuid.NewString(), SourcePath: "original/source", SourceHash: archiveHashOf("source"), TargetPath: "original/target", TargetHash: archiveHashOf("target"), Phase: "prepared"}
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

func TestSourceAcknowledgementLedgerCapacityAndReadFailures(t *testing.T) {
	database, _, id := sessionArchiveLockFixture(t)
	ctx := t.Context()
	epoch := uuid.NewString()
	if _, e := database.Pool.Exec(ctx, `INSERT INTO session_source_hashes(session_id,source_epoch,kind,identity,digest,source_seq) SELECT $1,$2,'event',n::text,decode(repeat('ab',32),'hex'),1 FROM generate_series(1,8192) n`, id, epoch); e != nil {
		t.Fatal(e)
	}
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		dao := base.(store.SessionSourceDAO)
		h := store.SessionSourceHash{SessionID: id, SourceEpoch: epoch, Kind: "event", Identity: "8193", Through: 1, Digest: []byte(strings.Repeat("a", 32))}
		e := dao.SaveSessionSourceHash(ctx, h)
		var fault *model.Fault
		if !errors.As(e, &fault) || fault.Code != "quota_exceeded" {
			t.Fatal("full acknowledgement ledger silently accepted another identity", e)
		}
		canceled, cancel := context.WithCancel(ctx)
		cancel()
		if e = dao.SaveSessionSourceHash(canceled, h); e == nil {
			t.Fatal("canceled source hash read accepted a write")
		}
		return nil
	})
	var count int
	if e := database.Pool.QueryRow(ctx, `SELECT count(*) FROM session_source_hashes WHERE session_id=$1`, id).Scan(&count); e != nil || count != 8192 {
		t.Fatal("failed admission changed original acknowledgement window", count, e)
	}
}

func TestArchiveReadyDoesNotReportSuccessWhenStorageDeclinesWrite(t *testing.T) {
	database, _, id := sessionArchiveLockFixture(t)
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
