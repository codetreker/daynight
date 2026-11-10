package webhook

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// The query and rows remain PostgreSQL-backed. Only the selected row scan or
// terminal iteration result is faulted to test propagation of partial reads.
type historyFaultTx struct {
	pgx.Tx
	scanFailure, iterationFailure error
}

func (tx historyFaultTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	rows, err := tx.Tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return &historyFaultRows{Rows: rows, scanFailure: tx.scanFailure, iterationFailure: tx.iterationFailure}, nil
}

type historyFaultRows struct {
	pgx.Rows
	scanFailure, iterationFailure error
}

func (r *historyFaultRows) Scan(dest ...any) error {
	if r.scanFailure != nil {
		return r.scanFailure
	}
	return r.Rows.Scan(dest...)
}
func (r *historyFaultRows) Err() error {
	if err := r.Rows.Err(); err != nil {
		return err
	}
	return r.iterationFailure
}

func testHistoryReadersPropagateDatabaseAndPartialReadFailures(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	ctx := context.Background()
	owner := wm.Owner{Kind: "personal", ID: f.user}
	if _, err := f.conn.Exec(ctx, `INSERT INTO webhook_attempts(id,delivery_id,endpoint_id,generation,sequence,trigger,lease_token,destination_revision,signing_key_ids,automatic_plan_slot,claimed_at,admitted_at) SELECT gen_random_uuid(),d.id,d.endpoint_id,d.generation,1,'automatic',gen_random_uuid(),d.destination_revision,ARRAY[e.active_key_id],1,now(),now() FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1`, f.delivery); err != nil {
		t.Fatal(err)
	}
	for _, reader := range []struct {
		name, relation string
		read           func(*DAO) error
	}{
		{"deliveries", "webhook_deliveries", func(d *DAO) error { _, e := d.HistoryDeliveries(ctx, owner, f.endpoint, time.Time{}, "", 10); return e }},
		{"attempts", "webhook_attempts", func(d *DAO) error { _, e := d.HistoryAttempts(ctx, f.delivery); return e }},
		{"disclosure", "projects", func(d *DAO) error {
			_, e := d.HistoryDisclosure(ctx, owner, f.endpoint, f.user, time.Now().Add(time.Hour))
			return e
		}},
	} {
		t.Run(reader.name, func(t *testing.T) {
			t.Run("relation unavailable", func(t *testing.T) {
				tx, err := f.conn.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(ctx)
				if _, err = tx.Exec(ctx, `ALTER TABLE `+pgx.Identifier{reader.relation}.Sanitize()+` RENAME TO hidden_relation`); err != nil {
					t.Fatal(err)
				}
				assertMissingRelation(t, reader.read(New(tx)))
			})
			for _, phase := range []string{"scan", "iteration"} {
				t.Run(phase, func(t *testing.T) {
					tx, err := f.conn.Begin(ctx)
					if err != nil {
						t.Fatal(err)
					}
					defer tx.Rollback(ctx)
					failure := errors.New("injected partial result failure")
					wrapped := historyFaultTx{Tx: tx}
					if phase == "scan" {
						wrapped.scanFailure = failure
					} else {
						wrapped.iterationFailure = failure
					}
					if err = reader.read(New(wrapped)); !errors.Is(err, failure) {
						t.Fatalf("%s failure was hidden: %v", phase, err)
					}
				})
			}
		})
	}
}

type missingEventClockFaultTx struct {
	pgx.Tx
	cause error
}

func (tx missingEventClockFaultTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if strings.Contains(sql, "clock_timestamp()") {
		return rowFunc(func(...any) error { return tx.cause })
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}

func testMissingAdmissionEventRetentionAndStorageFailures(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	ctx := context.Background()
	for _, scenario := range []string{"runner", "missing delivery", "purging", "expired metadata", "expired payload", "open corruption", "attempt storage", "clock"} {
		t.Run(scenario, func(t *testing.T) {
			tx, err := f.conn.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			id := f.delivery
			if scenario == "missing delivery" {
				id = uuid.NewString()
			}
			if scenario == "purging" {
				if _, err = tx.Exec(ctx, `UPDATE webhook_deliveries SET purging_at=clock_timestamp() WHERE id=$1`, id); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "expired metadata" {
				if _, err = tx.Exec(ctx, `UPDATE webhook_deliveries SET state='failed',automatic_open=false,next_attempt_at=NULL,metadata_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, id); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "expired payload" {
				if _, err = tx.Exec(ctx, `UPDATE webhook_deliveries SET occurred_at=occurred_at-interval '8 days',automatic_schedule_at=ARRAY(SELECT x-interval '8 days' FROM unnest(automatic_schedule_at) x),automatic_expires_at=automatic_expires_at-interval '8 days',payload_expires_at=payload_expires_at-interval '8 days',expires_at=expires_at-interval '8 days',state='failed',automatic_open=false,next_attempt_at=NULL WHERE id=$1`, id); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "attempt storage" {
				if _, err = tx.Exec(ctx, `ALTER TABLE webhook_attempts RENAME TO hidden_attempts`); err != nil {
					t.Fatal(err)
				}
			}
			var dao *DAO
			clockFailure := errors.New("injected database clock failure")
			if scenario == "clock" {
				dao = New(missingEventClockFaultTx{Tx: tx, cause: clockFailure})
			} else {
				dao = New(tx)
			}
			err = dao.missingAdmissionEvent(ctx, id, scenario != "runner")
			switch scenario {
			case "runner", "missing delivery", "purging", "expired metadata":
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("expected absence: %v", err)
				}
			case "expired payload":
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "payload_expired" {
					t.Fatalf("expected expired payload: %v", err)
				}
			case "open corruption":
				var marked *store.WebhookAdmissionEventError
				if !errors.As(err, &marked) || errors.Is(err, model.ErrNotFound) {
					t.Fatalf("open missing Event not classified as corruption: %v", err)
				}
			case "attempt storage":
				assertMissingRelation(t, err)
			case "clock":
				if !errors.Is(err, clockFailure) {
					t.Fatalf("clock failure hidden: %v", err)
				}
			}
		})
	}
}
