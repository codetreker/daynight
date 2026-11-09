package session_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestArchiveFileInventoryAndImmutableWrites(t *testing.T) {
	database, _, id := sessionArchiveLockFixture(t)
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

func TestSourceAcknowledgementLedgerCountAndCanceledStorageCalls(t *testing.T) {
	database, _, id := sessionArchiveLockFixture(t)
	ctx := t.Context()
	epoch := uuid.NewString()
	if _, e := database.Pool.Exec(ctx, `INSERT INTO session_source_hashes(session_id,source_epoch,kind,identity,digest,source_seq) SELECT $1,$2,'event',n::text,decode(repeat('ab',32),'hex'),1 FROM generate_series(1,8192) n`, id, epoch); e != nil {
		t.Fatal(e)
	}
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		count, e := base.(store.SessionSourceDAO).SessionSourceHashCount(ctx, id)
		if e != nil || count != 8192 {
			t.Fatal("source ledger count is not actual persisted inventory", count, e)
		}
		return nil
	})
	for _, point := range []string{"read", "count", "prune"} {
		canceled, cancel := context.WithCancel(ctx)
		cancel()
		completion, e := database.WriteSession(ctx, func(scope store.SessionScope) error {
			dao := scope.SessionDAO().(store.SessionSourceDAO)
			switch point {
			case "read":
				_, e := dao.SessionSourceHash(canceled, store.SessionSourceHash{SessionID: id, SourceEpoch: epoch, Kind: "event", Identity: "1"})
				return e
			case "count":
				_, e := dao.SessionSourceHashCount(canceled, id)
				return e
			default:
				return dao.PruneSessionSourceHashes(canceled, id, epoch, 1)
			}
		})
		if !errors.Is(e, context.Canceled) || completion.Outcome != store.TransactionNotCommitted {
			t.Fatal("canceled source storage operation succeeded", point, completion, e)
		}
	}
	var count int
	if e := database.Pool.QueryRow(ctx, `SELECT count(*) FROM session_source_hashes WHERE session_id=$1`, id).Scan(&count); e != nil || count != 8192 {
		t.Fatal("canceled pruning changed persisted window", count, e)
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

func TestSourceAcknowledgementDoesNotAcceptFailedInsert(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
	}{
		{"declined", "BEGIN RETURN NULL; END"},
		{"error", "BEGIN RAISE EXCEPTION 'source acknowledgement storage failure'; END"},
	} {
		t.Run(test.name, func(t *testing.T) {
			database, _, id := sessionArchiveLockFixture(t)
			ctx := t.Context()
			// Each test owns its database. The trigger preserves real PostgreSQL
			// command and transaction outcomes while refusing acknowledgement storage.
			if _, e := database.Pool.Exec(ctx, `CREATE FUNCTION refuse_source_fixture() RETURNS trigger LANGUAGE plpgsql AS $$`+test.body+`$$; CREATE TRIGGER refuse_source_fixture BEFORE INSERT ON session_source_hashes FOR EACH ROW EXECUTE FUNCTION refuse_source_fixture()`); e != nil {
				t.Fatal(e)
			}
			h := store.SessionSourceHash{SessionID: id, SourceEpoch: uuid.NewString(), Kind: "event", Identity: "1", Through: 1, Digest: []byte(strings.Repeat("a", 32))}
			var insertError error
			_, e := database.WriteSession(ctx, func(scope store.SessionScope) error {
				insertError = scope.SessionDAO().(store.SessionSourceDAO).SaveSessionSourceHash(ctx, h)
				return insertError
			})
			if test.name == "declined" {
				var fault *model.Fault
				if !errors.As(e, &fault) || fault.Code != "resource_conflict" {
					t.Fatal("zero-written-row outcome became a source acknowledgement", e)
				}
			} else {
				var failure *pgconn.PgError
				var queryFailure *store.Error
				if !errors.As(e, &failure) || failure.Code != "P0001" || !errors.Is(e, insertError) || !errors.As(insertError, &queryFailure) || queryFailure.Phase != "persist original source hash" {
					t.Fatal("source acknowledgement lost its persistence failure chain", e)
				}
			}
			var count int
			if e := database.Pool.QueryRow(ctx, `SELECT count(*) FROM session_source_hashes WHERE session_id=$1`, id).Scan(&count); e != nil || count != 0 {
				t.Fatal("failed insertion persisted an acknowledgement", count, e)
			}
		})
	}
}
