package webhook_test

import (
	"context"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/google/uuid"
)

type observeLateTransactions struct {
	base      store.WebhookDeliveryTransactions
	committed chan struct{}
}
type observeLateScope struct {
	store.WebhookDeliveryScope
	seen bool
}

func (s *observeLateScope) LockOwnAttempt(ctx context.Context, id string) (store.WebhookAttempt, error) {
	s.seen = true
	return s.WebhookDeliveryScope.LockOwnAttempt(ctx, id)
}
func (o *observeLateTransactions) WriteWebhookDelivery(ctx context.Context, fn func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	seen := false
	result, err := o.base.WriteWebhookDelivery(ctx, func(sc store.WebhookDeliveryScope) error {
		wrapped := &observeLateScope{WebhookDeliveryScope: sc}
		e := fn(wrapped)
		seen = wrapped.seen
		return e
	})
	if seen && err == nil && result.Outcome == store.TransactionCommitted {
		select {
		case o.committed <- struct{}{}:
		default:
		}
	}
	return result, err
}

// A real old request receives 202 while a replacement lease holds the Delivery
// lock. Late observation must only touch its own Attempt, including the retention
// closed case; neither may wait for or alter the replacement lease.
func TestDeliveryLateObservationWithNewLeaseLocked(t *testing.T) {
	for _, closed := range []bool{false, true} {
		name := "retained"
		if closed {
			name = "closed"
		}
		t.Run(name, func(t *testing.T) {
			arrived := make(chan struct{}, 1)
			release := make(chan struct{})
			var releaseOnce sync.Once
			receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				arrived <- struct{}{}
				<-release
				w.WriteHeader(http.StatusAccepted)
			}))
			defer receiver.Close()
			defer releaseOnce.Do(func() { close(release) })
			f := newCaptureFixture(t, 1)
			var endpoint string
			var version int64
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
				t.Fatal(err)
			}
			svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true}
			m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL}}
			if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
				t.Fatal(err)
			}
			if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "late observation"}); err != nil {
				t.Fatal(err)
			}
			observer := &observeLateTransactions{base: f.db, committed: make(chan struct{}, 1)}
			runner := webhook.NewRunner(observer, svc, true)
			roots := x509.NewCertPool()
			roots.AddCert(receiver.Certificate())
			runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
			if err := runner.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			defer func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if e := runner.Stop(ctx); e != nil {
					t.Error(e)
				}
			}()
			select {
			case <-arrived:
			case e := <-runner.Failures():
				t.Fatalf("old request: %v", e)
			case <-time.After(5 * time.Second):
				t.Fatal("no old request")
			}
			var id, attempt string
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.id::text,d.current_attempt_id::text FROM webhook_deliveries d`).Scan(&id, &attempt); err != nil {
				t.Fatal(err)
			}
			if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET lease_claimed_at=now()-interval '46 seconds',lease_until=now()-interval '1 second' WHERE id=$1`, id); err != nil {
				t.Fatal(err)
			}
			recovery := webhook.NewRunner(f.db, svc, false)
			if err := recovery.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			deadline := time.After(5 * time.Second)
			for {
				var state string
				if err := f.db.Pool.QueryRow(f.ctx, `SELECT state FROM webhook_deliveries WHERE id=$1`, id).Scan(&state); err != nil {
					t.Fatal(err)
				}
				if state == "pending" {
					break
				}
				select {
				case e := <-recovery.Failures():
					t.Fatal(e)
				case <-deadline:
					t.Fatal("lease did not recover")
				case <-time.After(20 * time.Millisecond):
				}
			}
			stopctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := recovery.Stop(stopctx); err != nil {
				t.Fatal(err)
			}
			cancel()
			newToken := uuid.NewString()
			if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='leased',lease_token=$2,lease_claimed_at=now(),lease_until=now()+interval '45 seconds',lease_generation=generation WHERE id=$1`, id, newToken); err != nil {
				t.Fatal(err)
			}
			if closed {
				if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_attempts SET retention_closed_at=now() WHERE id=$1`, attempt); err != nil {
					t.Fatal(err)
				}
			}
			tx, err := f.db.Pool.Begin(f.ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			var locked string
			if err = tx.QueryRow(f.ctx, `SELECT id::text FROM webhook_deliveries WHERE id=$1 FOR UPDATE`, id).Scan(&locked); err != nil {
				t.Fatal(err)
			}
			releaseOnce.Do(func() { close(release) })
			select {
			case <-observer.committed:
			case e := <-runner.Failures():
				t.Fatalf("late write: %v", e)
			case <-time.After(4 * time.Second):
				t.Fatal("late write blocked on replacement Delivery lock")
			}
			var late, recovered *time.Time
			var outcome string
			var lateOutcome *string
			if err = f.db.Pool.QueryRow(f.ctx, `SELECT recovered_unknown_at,outcome,late_observed_at,late_outcome FROM webhook_attempts WHERE id=$1`, attempt).Scan(&recovered, &outcome, &late, &lateOutcome); err != nil {
				t.Fatal(err)
			}
			if recovered == nil || outcome != "unknown" {
				t.Fatal("recovery observation lost")
			}
			if closed {
				if late != nil || lateOutcome != nil {
					t.Fatal("retention-closed attempt changed")
				}
			} else if late == nil || lateOutcome == nil || *lateOutcome != "acknowledged" {
				t.Fatal("late 202 not recorded")
			}
			var token, state string
			var gen, leaseGen int64
			if err = tx.QueryRow(f.ctx, `SELECT state,lease_token::text,generation,lease_generation FROM webhook_deliveries WHERE id=$1`, id).Scan(&state, &token, &gen, &leaseGen); err != nil {
				t.Fatal(err)
			}
			if state != "leased" || token != newToken || gen != leaseGen || gen <= 1 {
				t.Fatal("late writer changed replacement lease")
			}
			if err = tx.Commit(f.ctx); err != nil {
				t.Fatal(err)
			}
		})
	}
}
