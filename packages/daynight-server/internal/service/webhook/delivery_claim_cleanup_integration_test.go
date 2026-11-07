package webhook_test

import (
	"context"
	"crypto/x509"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/google/uuid"
)

type claimCleanupGate struct {
	base             store.WebhookDeliveryTransactions
	claimed          atomic.Bool
	entered, release chan struct{}
	forceExpired     bool
}
type claimCleanupScope struct {
	store.WebhookDeliveryScope
	claimed      bool
	forceExpired bool
}

func (s *claimCleanupScope) Claim(ctx context.Context, n int, now time.Time, tokens []string) ([]store.WebhookDelivery, error) {
	d, err := s.WebhookDeliveryScope.Claim(ctx, n, now, tokens)
	if err == nil && len(d) > 0 && s.forceExpired {
		// Advance this isolated lease to its post-pause state without making the
		// routine suite wait 45 seconds. Both persisted and returned times agree.
		claimed, until := now.Add(-46*time.Second), now.Add(-time.Second)
		d[0].LeaseClaimedAt, d[0].LeaseUntil = &claimed, &until
		err = s.WebhookDeliveryScope.UpdateDelivery(ctx, d[0])
	}
	s.claimed = err == nil && len(d) > 0
	return d, err
}
func (g *claimCleanupGate) WriteWebhookDelivery(ctx context.Context, fn func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	claimed := false
	completion, err := g.base.WriteWebhookDelivery(ctx, func(sc store.WebhookDeliveryScope) error {
		wrapped := &claimCleanupScope{WebhookDeliveryScope: sc, forceExpired: g.forceExpired && !g.claimed.Load()}
		e := fn(wrapped)
		claimed = wrapped.claimed
		return e
	})
	if err == nil && completion.Outcome == store.TransactionCommitted && claimed && g.claimed.CompareAndSwap(false, true) {
		close(g.entered)
		select {
		case <-g.release:
		case <-ctx.Done():
			return completion, ctx.Err()
		}
	}
	return completion, err
}

// A claimant is suspended after its real claim commit, then an isolated database
// transaction removes expired history before the admission transaction starts.
func TestAdmissionAfterClaimedHistoryCleanup(t *testing.T) {
	for _, mode := range []string{"deleted", "purging", "replaced", "active_missing_event", "active_missing_delivery"} {
		t.Run(mode, func(t *testing.T) {
			requests := make(chan struct{}, 2)
			receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests <- struct{}{}
				w.WriteHeader(http.StatusAccepted)
			}))
			defer receiver.Close()
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
			tasks := taskservice.NewTasks(f.db, f.capture)
			if _, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "suspended claimant"}); err != nil {
				t.Fatal(err)
			}
			gate := &claimCleanupGate{base: f.db, entered: make(chan struct{}), release: make(chan struct{}), forceExpired: mode == "deleted"}
			var releaseOnce sync.Once
			defer releaseOnce.Do(func() { close(gate.release) })
			runner := webhook.NewRunner(gate, svc, true)
			roots := x509.NewCertPool()
			roots.AddCert(receiver.Certificate())
			runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
			if err := runner.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			defer func() {
				c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if err := runner.Stop(c); err != nil {
					t.Error(err)
				}
			}()
			select {
			case <-gate.entered:
			case err := <-runner.Failures():
				t.Fatal(err)
			case <-time.After(5 * time.Second):
				t.Fatal("claim was not committed")
			}
			var delivery, event string
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,event_id::text FROM webhook_deliveries`).Scan(&delivery, &event); err != nil {
				t.Fatal(err)
			}
			tx, err := f.db.Pool.Begin(f.ctx)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "deleted", "purging":
				_, err = tx.Exec(f.ctx, `UPDATE webhook_deliveries SET state='failed',automatic_open=false,next_attempt_at=NULL,terminal_at=now(),purging_at=now(),lease_token=NULL,lease_claimed_at=NULL,lease_until=NULL,lease_generation=NULL,lease_plan_slot=NULL,current_attempt_id=NULL WHERE id=$1`, delivery)
			case "replaced":
				_, err = tx.Exec(f.ctx, `UPDATE webhook_deliveries SET state='failed',generation=generation+1,automatic_open=false,next_attempt_at=NULL,terminal_at=now(),lease_token=NULL,lease_claimed_at=NULL,lease_until=NULL,lease_generation=NULL,lease_plan_slot=NULL,current_attempt_id=NULL WHERE id=$1`, delivery)
			}
			if err != nil {
				t.Fatal(err)
			}
			if mode == "deleted" || mode == "purging" || mode == "active_missing_delivery" {
				if _, err = tx.Exec(f.ctx, `DELETE FROM webhook_delivery_matches WHERE delivery_id=$1`, delivery); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "deleted" || mode == "active_missing_delivery" {
				if _, err = tx.Exec(f.ctx, `DELETE FROM webhook_deliveries WHERE id=$1`, delivery); err != nil {
					t.Fatal(err)
				}
			}
			if _, err = tx.Exec(f.ctx, `DELETE FROM webhook_events WHERE id=$1`, event); err != nil {
				t.Fatal(err)
			}
			if err = tx.Commit(f.ctx); err != nil {
				t.Fatal(err)
			}
			releaseOnce.Do(func() { close(gate.release) })
			if mode == "active_missing_event" || mode == "active_missing_delivery" {
				select {
				case err := <-runner.Failures():
					if !errors.Is(err, model.ErrNotFound) {
						t.Fatalf("wrong error: %v", err)
					}
				case <-requests:
					t.Fatal("missing current Event sent a request")
				case <-time.After(5 * time.Second):
					t.Fatal("missing current Event did not fail")
				}
			} else {
				// Waiting for an observed later delivery proves the worker pool survived.
				if _, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "later valid event"}); err != nil {
					t.Fatal(err)
				}
				select {
				case <-requests:
				case err := <-runner.Failures():
					t.Fatalf("cleanup killed worker: %v", err)
				case <-time.After(5 * time.Second):
					t.Fatal("later valid event was not sent")
				}
			}
			var count int
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_attempts WHERE delivery_id=$1`, delivery).Scan(&count); err != nil || count != 0 {
				t.Fatalf("old Attempt created: %d %v", count, err)
			}
		})
	}
}
