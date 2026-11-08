package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

func TestWebhookCredentialObservationAfterRowLockWait(t *testing.T) {
	for _, mode := range []string{"natural expiry", "revocation"} {
		t.Run(mode, func(t *testing.T) {
			s := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
			defer cancel()
			user, session := uuid.NewString(), uuid.NewString()
			mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, user)
			var expiry time.Time
			if err := s.Pool.QueryRow(ctx, `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,decode(repeat('ab',32),'hex'),now(),clock_timestamp()+CASE WHEN $3='natural expiry' THEN interval '2 seconds' ELSE interval '1 day' END) RETURNING expires_at`, session, user, mode).Scan(&expiry); err != nil {
				t.Fatal(err)
			}
			locked, err := s.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer locked.Rollback(context.Background())
			if _, err = locked.Exec(ctx, `SELECT id FROM sessions WHERE id=$1 FOR UPDATE`, session); err != nil {
				t.Fatal(err)
			}
			blocker := locked.Conn().PgConn().PID()
			started := make(chan uint32, 1)
			results := make(chan error, 1)
			principal := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: session}
			go func() {
				completion, err := s.WriteWebhook(ctx, wm.Owner{Kind: "personal", ID: user}, uuid.NewString(), func(sc store.WebhookWriteScope) error {
					started <- sc.(*webhookScope).tx.Conn().PgConn().PID()
					credential, err := sc.LockCredential(ctx, principal)
					if mode == "revocation" {
						if err == nil {
							return fmt.Errorf("revoked credential remained readable")
						}
						if !errors.Is(err, model.ErrNotFound) {
							return err
						}
						return nil
					}
					if err != nil {
						return err
					}
					observed, err := sc.ObservedAt(ctx)
					if err != nil {
						return err
					}
					if credential.ExpiresAt == nil || !credential.ExpiresAt.Equal(expiry) || observed.Before(expiry) {
						return fmt.Errorf("lock wait did not expose current credential time: expiry=%v observed=%v", credential.ExpiresAt, observed)
					}
					return nil
				})
				if err == nil && completion.Outcome != store.TransactionCommitted {
					err = fmt.Errorf("observation transaction: %v", completion)
				}
				results <- err
			}()
			var reader uint32
			select {
			case reader = <-started:
			case err := <-results:
				t.Fatalf("credential read failed before lock: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			for {
				var blocked bool
				if err = s.Pool.QueryRow(ctx, `SELECT $1::integer = ANY(pg_blocking_pids($2))`, blocker, reader).Scan(&blocked); err != nil {
					t.Fatal(err)
				}
				if blocked {
					break
				}
				select {
				case err := <-results:
					t.Fatalf("credential read did not wait: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-time.After(5 * time.Millisecond):
				}
			}
			if mode == "revocation" {
				if _, err = locked.Exec(ctx, `DELETE FROM sessions WHERE id=$1`, session); err != nil {
					t.Fatal(err)
				}
			} else {
				for {
					var expired bool
					if err = s.Pool.QueryRow(ctx, `SELECT clock_timestamp() >= $1`, expiry).Scan(&expired); err != nil {
						t.Fatal(err)
					}
					if expired {
						break
					}
					select {
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					case <-time.After(5 * time.Millisecond):
					}
				}
			}
			if err = locked.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-results:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		})
	}
}

func TestWebhookTransactionEntryLostCommitReplyIsUnknown(t *testing.T) {
	for _, kind := range []string{"delivery", "retention"} {
		t.Run(kind, func(t *testing.T) {
			base, _, _, _, delivery, _ := webhookBoundaryStore(t)
			fault := &maintenanceReplyFault{command: "commit", reached: make(chan struct{})}
			pool := maintenanceFaultPool(t, base, fault)
			s := &Store{Pool: pool}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			var completion store.Completion
			var err error
			if kind == "delivery" {
				completion, err = s.WriteWebhookDelivery(ctx, func(sc store.WebhookDeliveryScope) error {
					row, err := sc.LockDelivery(ctx, delivery.ID)
					if err != nil {
						return err
					}
					code := "commit reply was lost"
					row.PreparationErrorCode = &code
					return sc.UpdateDelivery(ctx, row)
				})
			} else {
				completion, err = s.WriteWebhookRetention(ctx, func(sc store.WebhookRetentionScope) error {
					_, err := sc.RemoveExpiredPayload(ctx, delivery.ID, time.Now())
					return err
				})
			}
			var failure *store.TransactionError
			if completion.Outcome != store.TransactionUnknown || !errors.As(err, &failure) || !failure.CommitAttempted || !fault.observed.Load() {
				t.Fatalf("entry completion: %v failure=%+v error=%v", completion, failure, err)
			}
			var applied bool
			query := `SELECT preparation_error_code='commit reply was lost' FROM webhook_deliveries WHERE id=$1`
			if kind == "retention" {
				query = `SELECT body IS NULL AND payload_removed_at IS NOT NULL FROM webhook_deliveries WHERE id=$1`
			}
			if err = base.Pool.QueryRow(ctx, query, delivery.ID).Scan(&applied); err != nil || !applied {
				t.Fatalf("independent committed state: %v %v", applied, err)
			}
			if kind == "retention" {
				if err = s.ObserveWebhookRetention(ctx, "delivery", delivery.ID); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}
