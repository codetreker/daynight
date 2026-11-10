package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestPrivateTransferDueReportsCancellationAndScanFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC()
	record := transferRecord(uuid.NewString(), now.Add(-2*time.Hour))
	if _, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var err error
		record, _, err = transfer.Create(ctx, d, record)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	completion, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		_, err := d.Due(canceled, now, 10)
		return err
	})
	if !errors.Is(err, context.Canceled) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("canceled due query: completion=%+v error=%v", completion, err)
	}
	// An incompatible row simulates a database/schema problem after a query has
	// started returning data. The selection update must roll back on scan failure.
	if _, err := db.Pool.Exec(ctx, `ALTER TABLE private_transfers ALTER COLUMN path DROP NOT NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE private_transfers SET path=NULL WHERE id=$1`, record.ID); err != nil {
		t.Fatal(err)
	}
	completion, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		_, err := d.Due(ctx, now, 10)
		return err
	})
	var databaseErr *store.Error
	if err == nil || !errors.As(err, &databaseErr) || databaseErr.Phase != "read private transfer" || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("invalid due row: completion=%+v error=%v", completion, err)
	}
	var version int64
	var attempted *time.Time
	if err := db.Pool.QueryRow(ctx, `SELECT version,last_cleanup_attempt FROM private_transfers WHERE id=$1`, record.ID).Scan(&version, &attempted); err != nil || version != record.Version || attempted != nil {
		t.Fatalf("failed scan changed selection: version=%d attempted=%v error=%v", version, attempted, err)
	}
}

func TestPrivateTransferPrunePropagatesDeleteFailure(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC()
	record := transferRecord(uuid.NewString(), now.Add(-2*time.Hour))
	if _, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var err error
		record, _, err = transfer.Create(ctx, d, record)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		record.State = "cleanup_pending"
		var err error
		record, err = transfer.Update(ctx, d, record, record.Version)
		if err != nil {
			return err
		}
		record, err = transfer.Close(ctx, d, record.ID, record.Version, now.Add(-time.Minute))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `CREATE FUNCTION reject_transfer_prune() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1001', MESSAGE='prune rejected'; END $$;
		CREATE TRIGGER reject_transfer_prune BEFORE DELETE ON private_transfers FOR EACH ROW EXECUTE FUNCTION reject_transfer_prune()`); err != nil {
		t.Fatal(err)
	}
	completion, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		_, err := d.Prune(ctx, now, 10)
		return err
	})
	var databaseErr *store.Error
	var postgresErr *pgconn.PgError
	if err == nil || !errors.As(err, &databaseErr) || databaseErr.Phase != "prune private transfers" || !errors.As(err, &postgresErr) || postgresErr.Code != "P1001" || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("prune failure: completion=%+v error=%v", completion, err)
	}
	var state string
	if err := db.Pool.QueryRow(ctx, `SELECT state FROM private_transfers WHERE id=$1`, record.ID).Scan(&state); err != nil || state != "closed" {
		t.Fatalf("failed prune changed record: state=%q error=%v", state, err)
	}
}
