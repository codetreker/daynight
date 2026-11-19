package github_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/jackc/pgx/v5/pgconn"
)

type appCatalogFault struct {
	name, ddl, restore, state, phase string
}

type appFaultCatalog struct {
	connection, pending, ownership, admins uint32
	hintColumn, accessColumn               int16
}

func readAppFaultCatalog(t *testing.T, ctx context.Context, db *postgres.Store) appFaultCatalog {
	t.Helper()
	var catalog appFaultCatalog
	var intact bool
	err := db.Pool.QueryRow(ctx, `SELECT 'project_github'::regclass::oid,'project_github_pending_prs'::regclass::oid,
 'project_ownership'::regclass::oid,'github_app_admins'::regclass::oid,
 (SELECT attnum FROM pg_attribute WHERE attrelid='project_github'::regclass AND attname='access_hint_id' AND NOT attisdropped),
 (SELECT attnum FROM pg_attribute WHERE attrelid='project_github'::regclass AND attname='access_state' AND NOT attisdropped),
 to_regclass('unavailable_ownership') IS NULL AND to_regclass('unavailable_pending') IS NULL
 AND to_regclass('broken_admins') IS NULL AND to_regclass('broken_pending') IS NULL
 AND NOT EXISTS(SELECT FROM pg_attribute WHERE attrelid='project_github'::regclass AND NOT attisdropped
 AND attname IN ('unavailable_hint','broken_access_state'))`).
		Scan(&catalog.connection, &catalog.pending, &catalog.ownership, &catalog.admins, &catalog.hintColumn, &catalog.accessColumn, &intact)
	if err != nil || !intact {
		t.Fatalf("App catalog before use: %v, %v", intact, err)
	}
	return catalog
}

func (fault appCatalogFault) run(t *testing.T, db *postgres.Store, write func(context.Context) (store.Completion, int, error), verifyRestored func(context.Context)) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	before := readAppFaultCatalog(t, ctx, db)
	if _, err := db.Pool.Exec(ctx, fault.ddl); err != nil {
		t.Fatalf("install App fault: %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := db.Pool.Exec(ctx, fault.restore); err != nil {
			t.Fatalf("restore App catalog: %v", err)
		}
		db.Pool.Reset()
		if after := readAppFaultCatalog(t, ctx, db); after != before {
			t.Fatalf("App catalog after restoration = %+v, want %+v", after, before)
		}
		verifyRestored(ctx)
	}()
	db.Pool.Reset()
	completion, calls, err := write(ctx)
	var transaction *store.TransactionError
	var cause *store.Error
	var pg *pgconn.PgError
	if calls != 1 || completion.Outcome != store.TransactionNotCommitted ||
		!errors.As(err, &transaction) || !errors.As(transaction.Cause, &cause) || !cause.DatabaseFailure ||
		cause.Phase != fault.phase || !errors.As(err, &pg) || pg.Code != fault.state {
		t.Fatalf("App fault: calls=%d completion=%+v error=%v, want SQLSTATE %s from %s", calls, completion, err, fault.state, fault.phase)
	}
}
