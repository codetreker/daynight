package webhook

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func testDeliveryDAOFailureAndBoundaryPaths(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	ctx := context.Background()
	now := time.Now().UTC()
	t.Run("cancelled clock", func(t *testing.T) {
		tx, err := f.conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		_, err = New(tx).ObservedAt(cancelled)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("clock cancellation: %v", err)
		}
	})
	t.Run("expiry batch bounds and query failure", func(t *testing.T) {
		tx, err := f.conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		d := New(tx)
		for _, limit := range []int{0, 9} {
			if _, err = d.LockExpired(ctx, limit, now); err == nil {
				t.Fatalf("accepted batch size %d", limit)
			}
		}
		if _, err = tx.Exec(ctx, `ALTER TABLE webhook_deliveries RENAME TO inaccessible_deliveries`); err != nil {
			t.Fatal(err)
		}
		_, err = d.LockExpired(ctx, 1, now)
		assertMissingRelation(t, err)
	})
	t.Run("select expired work", func(t *testing.T) {
		tx, err := f.conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		original, err := New(tx).LockDelivery(ctx, f.delivery)
		if err != nil {
			t.Fatal(err)
		}
		if original.Generation != 1 || original.State != "pending" || original.AutomaticAttemptCount != 0 || original.AttemptSequence != 0 {
			t.Fatalf("initial delivery control: %+v", original)
		}
		if _, err = tx.Exec(ctx, `UPDATE webhook_deliveries SET state='leased',lease_token=gen_random_uuid(),lease_claimed_at=clock_timestamp()-interval '60 seconds',lease_until=clock_timestamp()-interval '15 seconds',lease_generation=generation WHERE id=$1`, f.delivery); err != nil {
			t.Fatal(err)
		}
		rows, err := New(tx).LockExpired(ctx, 1, time.Now())
		if err != nil || len(rows) != 1 || rows[0].ID != f.delivery {
			t.Fatalf("expired lease rows=%+v err=%v", rows, err)
		}
		recovered := rows[0]
		recovered.Generation++
		recovered.State = "pending"
		recovered.LeaseToken, recovered.LeaseClaimedAt, recovered.LeaseUntil = nil, nil, nil
		recovered.LeaseGeneration, recovered.LeasePlanSlot, recovered.CurrentAttemptID = nil, nil, nil
		if err = New(tx).UpdateDelivery(ctx, recovered); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		tx, err = f.conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		persisted, err := New(tx).LockDelivery(ctx, f.delivery)
		expected := original
		expected.Generation = 2
		if err != nil || !reflect.DeepEqual(persisted, expected) {
			t.Fatalf("committed lease recovery changed capture or retry budget: expected=%+v actual=%+v err=%v", expected, persisted, err)
		}
		attempts, err := New(tx).LockAttempts(ctx, f.delivery)
		if err != nil || len(attempts) != 0 {
			t.Fatalf("unadmitted recovery created attempts: %+v %v", attempts, err)
		}
		if _, err = tx.Exec(ctx, `UPDATE webhook_deliveries SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, f.delivery); err != nil {
			t.Fatal(err)
		}
		rows, err = New(tx).LockDueExpiry(ctx, 1, time.Now())
		if err != nil || len(rows) != 1 || rows[0].ID != f.delivery {
			t.Fatalf("expired pending rows=%+v err=%v", rows, err)
		}
	})
	t.Run("invalid selected id", func(t *testing.T) {
		tx, err := f.conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		_, err = New(tx).lockDeliveryIDs(ctx, `SELECT NULL::text WHERE $1::timestamptz IS NOT NULL LIMIT $2`, 1, now)
		if err == nil {
			t.Fatal("null selected identity accepted")
		}
	})
	t.Run("wait missing and storage failure", func(t *testing.T) {
		tx, err := f.conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		d := New(tx)
		if err = d.RaiseWait(ctx, uuid.NewString(), 1, now.Add(time.Minute), now); err == nil {
			t.Fatal("missing wait accepted")
		}
		if _, err = tx.Exec(ctx, `ALTER TABLE webhook_endpoint_waits RENAME TO inaccessible_waits`); err != nil {
			t.Fatal(err)
		}
		assertMissingRelation(t, d.RaiseWait(ctx, f.endpoint, 1, now.Add(time.Minute), now))
	})
	t.Run("purging and invalid delivery state", func(t *testing.T) {
		tx, err := f.conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		d := New(tx)
		v, err := d.LockDelivery(ctx, f.delivery)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = tx.Exec(ctx, `UPDATE webhook_deliveries SET purging_at=clock_timestamp() WHERE id=$1`, f.delivery); err != nil {
			t.Fatal(err)
		}
		if err = d.UpdateDelivery(ctx, v); err == nil {
			t.Fatal("purging delivery accepted update")
		}
		if _, err = tx.Exec(ctx, `UPDATE webhook_deliveries SET purging_at=NULL WHERE id=$1`, f.delivery); err != nil {
			t.Fatal(err)
		}
		v.State = "invalid"
		err = d.UpdateDelivery(ctx, v)
		var failure *pgconn.PgError
		if !errors.As(err, &failure) || failure.Code != "23514" {
			t.Fatalf("invalid state error %v", err)
		}
	})
}

func assertMissingRelation(t *testing.T, err error) {
	t.Helper()
	var failure *pgconn.PgError
	if !errors.As(err, &failure) || failure.Code != "42P01" {
		t.Fatalf("expected database missing-relation failure, got %v", err)
	}
}

func testAdmissionSourcesDatabaseFailures(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	ctx := context.Background()
	now := time.Now()
	// Each savepoint hides one actual PostgreSQL relation. An internal read
	// failure must propagate, not be interpreted as revoked authorization.
	for _, table := range []string{"webhook_deliveries", "tasks", "project_ownership", "teams", "team_members", "project_grants", "users", "projects", "webhook_endpoints", "webhook_signing_keys", "webhook_delivery_matches", "webhook_subscriptions", "webhook_bindings"} {
		t.Run(table, func(t *testing.T) {
			tx, err := f.conn.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			if _, err = tx.Exec(ctx, `ALTER TABLE `+pgx.Identifier{table}.Sanitize()+` RENAME TO hidden_relation`); err != nil {
				t.Fatal(err)
			}
			_, err = New(tx).AdmissionSources(ctx, f.delivery, now)
			assertMissingRelation(t, err)
		})
	}
}
