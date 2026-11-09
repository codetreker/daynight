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

func archiveResourceMigrationBoundaryFixture(t *testing.T, migration string) (*postgres.Store, store.SessionResourceRecord, store.SessionResourceRecord) {
	t.Helper()
	database, _, id := sessionArchiveLockFixture(t)
	length, digest, mediaType := "8", archiveHashOf("original"), "text/plain"
	previous := store.SessionResourceRecord{SessionID: id, MigrationID: migration, Resource: sp.Resource{ResourceID: uuid.NewString(), Name: "original", Status: "available", MediaType: &mediaType, ByteLength: &length, SHA256: &digest}}
	raw, err := json.Marshal(previous.Resource)
	if err != nil {
		t.Fatal(err)
	}
	var migrationValue any
	if migration != "" {
		migrationValue = migration
	}
	mustQueryExec(t, database, `INSERT INTO session_resources(session_id,resource_id,descriptor,content,migration_id) VALUES($1,$2,$3,$4,$5)`, id, previous.Resource.ResourceID, raw, []byte("original"), migrationValue)
	next := previous
	next.BlobID, next.BlobPath, next.MigrationID = uuid.NewString(), "immutable/original", uuid.NewString()
	return database, previous, next
}

func TestArchiveResourceMigrationRetainsDatabaseFailuresAndInlineOriginal(t *testing.T) {
	for _, kind := range []string{"update failure", "canceled query", "closed transaction"} {
		t.Run(kind, func(t *testing.T) {
			database, previous, next := archiveResourceMigrationBoundaryFixture(t, "")
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

func TestArchiveResourceMigrationMapsOriginalNullAndExplicitMigrationIdentity(t *testing.T) {
	for _, migration := range []string{"", uuid.NewString()} {
		t.Run(map[bool]string{true: "null migration", false: "existing migration"}[migration == ""], func(t *testing.T) {
			database, previous, next := archiveResourceMigrationBoundaryFixture(t, migration)
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
		})
	}
}
