package session_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func testSourceAcknowledgementLedgerCountAndCanceledStorageCalls(t *testing.T, db *postgres.Store) {
	database := db
	_, id := prepareArchiveSession(t, db)
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

func TestSourceAcknowledgementDoesNotAcceptFailedInsert(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
	}{
		{"declined", "BEGIN RETURN NULL; END"},
		{"error", "BEGIN RAISE EXCEPTION 'source acknowledgement storage failure'; END"},
	} {
		t.Run(test.name, func(t *testing.T) {
			database := isolatedStore(t)
			_, id := prepareArchiveSession(t, database)
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

func testExternalSourceHashPrunesExplicitBoundaryAndOldEpoch(t *testing.T, db *postgres.Store) {
	id, _ := prepareImageSession(t, db)
	epoch := uuid.NewString()
	digest := bytes.Repeat([]byte{7}, 32)
	h := store.SessionSourceHash{SessionID: id, SourceEpoch: epoch, Kind: "event", Digest: digest}
	for _, item := range []struct {
		id      string
		through int64
	}{{"1", 1}, {"2", 2}, {"2049", 2049}} {
		h.Identity, h.Through = item.id, item.through
		sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
			return base.(store.SessionSourceDAO).SaveSessionSourceHash(t.Context(), h)
		})
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		dao := base.(store.SessionSourceDAO)
		if e := dao.PruneSessionSourceHashes(t.Context(), id, epoch, 1); e != nil {
			return e
		}
		query := h
		query.Identity = "1"
		if _, e := dao.SessionSourceHash(t.Context(), query); !errors.Is(e, model.ErrNotFound) {
			t.Fatal("explicit cutoff retained its boundary", e)
		}
		query.Identity = "2"
		if _, e := dao.SessionSourceHash(t.Context(), query); e != nil {
			return e
		}
		count, e := dao.SessionSourceHashCount(t.Context(), id)
		if e != nil || count != 2 {
			t.Fatal("explicit prune removed a newer identity", count, e)
		}
		return nil
	})
	old := h
	h.SourceEpoch = uuid.NewString()
	h.Identity, h.Through = "1", 1
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		dao := base.(store.SessionSourceDAO)
		if e := dao.SaveSessionSourceHash(t.Context(), h); e != nil {
			return e
		}
		return dao.PruneSessionSourceHashes(t.Context(), id, h.SourceEpoch, -1)
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		dao := base.(store.SessionSourceDAO)
		if _, e := dao.SessionSourceHash(t.Context(), old); !errors.Is(e, model.ErrNotFound) {
			t.Fatal("old epoch hashes retained", e)
		}
		count, e := dao.SessionSourceHashCount(t.Context(), id)
		if e != nil || count != 1 {
			t.Fatal("negative cutoff removed a current nonnegative sequence", count, e)
		}
		_, e = dao.SessionSourceHash(t.Context(), h)
		return e
	})
}
