package session_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestArchiveResourceMigrationRetainsDatabaseFailuresAndInlineOriginal(t *testing.T) {
	for _, kind := range []string{"update failure", "canceled query", "closed transaction"} {
		t.Run(kind, func(t *testing.T) {
			database := isolatedStore(t)
			previous, next := prepareInlineMigration(t, database, "")
			ctx := t.Context()
			var operationError error
			if kind == "closed transaction" {
				tx, err := database.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if err = tx.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				operationError = pgsession.New(tx).(store.SessionArchiveResourceMigrationDAO).MigrateSessionArchiveResource(ctx, previous, next)
				if !errors.Is(operationError, pgx.ErrTxClosed) {
					t.Fatal("closed transaction lost its original cause", operationError)
				}
			} else {
				queryContext := ctx
				if kind == "update failure" {
					// This test owns its database. PostgreSQL rejects the actual UPDATE before
					// publication, so the DAO must preserve the failure and the original row.
					mustQueryExec(t, database, `CREATE FUNCTION refuse_inline_migration_fixture() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'inline migration storage unavailable'; END$$; CREATE TRIGGER refuse_inline_migration_fixture BEFORE UPDATE ON session_resources FOR EACH ROW EXECUTE FUNCTION refuse_inline_migration_fixture()`)
				} else {
					canceled, cancel := context.WithCancel(ctx)
					cancel()
					queryContext = canceled
				}
				completion, err := database.WriteSession(ctx, func(scope store.SessionScope) error {
					operationError = scope.SessionDAO().(store.SessionArchiveResourceMigrationDAO).MigrateSessionArchiveResource(queryContext, previous, next)
					return operationError
				})
				if operationError == nil || !errors.Is(err, operationError) || completion.Outcome != store.TransactionNotCommitted {
					t.Fatal("migration storage refusal lost completion or cause", completion, operationError, err)
				}
				if kind == "canceled query" {
					if !errors.Is(operationError, context.Canceled) {
						t.Fatal("migration ignored canceled query", operationError)
					}
				} else {
					var databaseError *pgconn.PgError
					if !errors.As(operationError, &databaseError) || databaseError.Code != "P0001" {
						t.Fatal("migration storage failure was replaced by a business conflict", operationError)
					}
				}
			}
			var queryError *store.Error
			if !errors.As(operationError, &queryError) || queryError.Phase != "migrate inline archive resource" {
				t.Fatal("migration query failure lost its storage phase", operationError)
			}
			var raw, content []byte
			var blob, path, migration *string
			var reclaiming bool
			err := database.Pool.QueryRow(ctx, `SELECT descriptor,content,blob_id::text,blob_path,migration_id::text,gc_pending FROM session_resources WHERE session_id=$1 AND resource_id=$2`, previous.SessionID, previous.Resource.ResourceID).Scan(&raw, &content, &blob, &path, &migration, &reclaiming)
			var saved sp.Resource
			if err != nil || json.Unmarshal(raw, &saved) != nil || !reflect.DeepEqual(saved, previous.Resource) || string(content) != "original" || blob != nil || path != nil || migration != nil || reclaiming {
				t.Fatal("failed conversion changed the independently persisted inline original", string(raw), string(content), blob, path, migration, reclaiming, err)
			}
		})
	}
}

func testArchiveResourceMigrationMapsOriginalNullAndExplicitMigrationIdentity(t *testing.T, db *postgres.Store, migration string) {
	database := db
	previous, next := prepareInlineMigration(t, database, migration)
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		saved, err := base.(store.SessionResourceDAO).SavedSessionResource(t.Context(), previous.SessionID, previous.Resource.ResourceID)
		if err != nil || saved.MigrationID != previous.MigrationID || saved.BlobID != "" || saved.BlobPath != "" {
			t.Fatal("original optional storage identity mapping changed", saved, err)
		}
		return base.(store.SessionArchiveResourceMigrationDAO).MigrateSessionArchiveResource(t.Context(), saved, next)
	})
	var raw, content []byte
	var blob, path, observedMigration string
	err := database.Pool.QueryRow(t.Context(), `SELECT descriptor,content,blob_id::text,blob_path,migration_id::text FROM session_resources WHERE session_id=$1 AND resource_id=$2`, previous.SessionID, previous.Resource.ResourceID).Scan(&raw, &content, &blob, &path, &observedMigration)
	var saved sp.Resource
	if err != nil || json.Unmarshal(raw, &saved) != nil || !reflect.DeepEqual(saved, previous.Resource) || content != nil || blob != next.BlobID || path != next.BlobPath || observedMigration != next.MigrationID {
		t.Fatal("conversion did not atomically replace only the storage identity", string(raw), content, blob, path, observedMigration, err)
	}
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		err := base.(store.SessionArchiveResourceMigrationDAO).MigrateSessionArchiveResource(t.Context(), previous, next)
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "archive_conflict" {
			t.Fatal("old conversion identity replaced the committed external original", err)
		}
		return nil
	})
}

func testArchiveInlineMigrationComparesOriginalAndRemovesInlineCopy(t *testing.T, db *postgres.Store) {
	database := db
	_, id := prepareArchiveSession(t, database)
	ctx := t.Context()
	length, hash, mime := "8", archiveHashOf("original"), "text/plain"
	previous := store.SessionResourceRecord{SessionID: id, Resource: sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "original", ByteLength: &length, SHA256: &hash, MediaType: &mime}}
	raw, _ := json.Marshal(previous.Resource)
	mustQueryExec(t, database, `INSERT INTO session_resources(session_id,resource_id,descriptor,content) VALUES($1,$2,$3,$4)`, id, previous.Resource.ResourceID, raw, []byte("original"))
	next := previous
	next.BlobID, next.BlobPath, next.MigrationID = uuid.NewString(), "immutable/original", uuid.NewString()
	for _, kind := range []string{"descriptor", "migration", "blob-only", "path-only", "missing", "gc"} {
		t.Run(kind, func(t *testing.T) {
			stale := previous
			switch kind {
			case "descriptor":
				stale.Resource.Name = "replaced"
			case "migration":
				stale.MigrationID = uuid.NewString()
			case "blob-only":
				stale.BlobID = uuid.NewString()
			case "path-only":
				stale.BlobPath = "different/object"
			case "missing":
				stale.SessionID = uuid.NewString()
			case "gc":
				stale.GCPending = true
			}
			sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
				e := base.(store.SessionArchiveResourceMigrationDAO).MigrateSessionArchiveResource(ctx, stale, next)
				var fault *model.Fault
				if !errors.As(e, &fault) || fault.Code != "archive_conflict" {
					t.Fatal("changed conversion identity succeeded", kind, e)
				}
				return nil
			})
		})
	}
	for _, kind := range []string{"descriptor", "migration", "blob-only", "path-only", "external", "gc"} {
		t.Run("stored-"+kind, func(t *testing.T) {
			switch kind {
			case "descriptor":
				changed := previous.Resource
				changed.Name = "changed original"
				changedBytes, _ := json.Marshal(changed)
				mustQueryExec(t, database, `UPDATE session_resources SET descriptor=$3 WHERE session_id=$1 AND resource_id=$2`, id, previous.Resource.ResourceID, changedBytes)
			case "migration":
				mustQueryExec(t, database, `UPDATE session_resources SET migration_id=$3 WHERE session_id=$1 AND resource_id=$2`, id, previous.Resource.ResourceID, uuid.NewString())
			case "blob-only":
				mustQueryExec(t, database, `UPDATE session_resources SET blob_id=$3 WHERE session_id=$1 AND resource_id=$2`, id, previous.Resource.ResourceID, uuid.NewString())
			case "path-only":
				mustQueryExec(t, database, `UPDATE session_resources SET blob_path='changed/object' WHERE session_id=$1 AND resource_id=$2`, id, previous.Resource.ResourceID)
			case "external":
				mustQueryExec(t, database, `UPDATE session_resources SET blob_id=$3,blob_path='changed/object' WHERE session_id=$1 AND resource_id=$2`, id, previous.Resource.ResourceID, uuid.NewString())
			case "gc":
				mustQueryExec(t, database, `UPDATE session_resources SET gc_pending=true WHERE session_id=$1 AND resource_id=$2`, id, previous.Resource.ResourceID)
			}
			sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
				resources := base.(store.SessionResourceDAO)
				before, e := resources.SavedSessionResource(ctx, id, previous.Resource.ResourceID)
				if e != nil {
					return e
				}
				e = base.(store.SessionArchiveResourceMigrationDAO).MigrateSessionArchiveResource(ctx, previous, next)
				var fault *model.Fault
				if !errors.As(e, &fault) || fault.Code != "archive_conflict" {
					t.Fatal("changed stored original was converted", kind, e)
				}
				after, e := resources.SavedSessionResource(ctx, id, previous.Resource.ResourceID)
				if e == nil && !reflect.DeepEqual(before, after) {
					t.Fatal("refused conversion changed its stored original", kind, before, after)
				}
				return e
			})
			var content []byte
			if e := database.Pool.QueryRow(ctx, `SELECT content FROM session_resources WHERE session_id=$1 AND resource_id=$2`, id, previous.Resource.ResourceID).Scan(&content); e != nil || string(content) != "original" {
				t.Fatal("refused conversion lost inline original bytes", kind, content, e)
			}
			mustQueryExec(t, database, `UPDATE session_resources SET descriptor=$3,blob_id=NULL,blob_path=NULL,migration_id=NULL,gc_pending=false WHERE session_id=$1 AND resource_id=$2`, id, previous.Resource.ResourceID, raw)
		})
	}
	rejected := errors.New("reject conversion transaction")
	completion, e := database.WriteSession(ctx, func(scope store.SessionScope) error {
		if e := scope.SessionDAO().(store.SessionArchiveResourceMigrationDAO).MigrateSessionArchiveResource(ctx, previous, next); e != nil {
			return e
		}
		return rejected
	})
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(e, rejected) {
		t.Fatal("conversion rollback outcome", completion, e)
	}
	var retained []byte
	if e := database.Pool.QueryRow(ctx, `SELECT content FROM session_resources WHERE session_id=$1 AND resource_id=$2 AND blob_id IS NULL AND blob_path IS NULL`, id, previous.Resource.ResourceID).Scan(&retained); e != nil || string(retained) != "original" {
		t.Fatal("rolled back conversion lost its inline original", retained, e)
	}
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		return base.(store.SessionArchiveResourceMigrationDAO).MigrateSessionArchiveResource(ctx, previous, next)
	})
	sessionDAOTransaction(t, database, func(base store.SessionDAO) error {
		saved, e := base.(store.SessionResourceDAO).SavedSessionResource(ctx, id, previous.Resource.ResourceID)
		if e != nil || !reflect.DeepEqual(saved, next) {
			t.Fatal("external conversion did not preserve the resource", saved, e)
		}
		if e = base.(store.SessionArchiveResourceMigrationDAO).MigrateSessionArchiveResource(ctx, previous, next); e == nil {
			t.Fatal("stale conversion overwrote an external original")
		}
		return nil
	})
	var content []byte
	if e := database.Pool.QueryRow(ctx, `SELECT content FROM session_resources WHERE session_id=$1 AND resource_id=$2`, id, previous.Resource.ResourceID).Scan(&content); e != nil || content != nil {
		t.Fatal("conversion retained a second inline copy", content, e)
	}
}
