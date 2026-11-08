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

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/google/uuid"
)

func TestDeliveryLateResultAfterAttemptPurged(t *testing.T) {
	for _, mode := range []string{"purged_stale", "purged_same_lease", "current_missing"} {
		t.Run(mode, func(t *testing.T) {
			arrived, release := make(chan struct{}, 2), make(chan struct{})
			var once sync.Once
			var requests atomic.Int32
			receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				first := requests.Add(1) == 1
				arrived <- struct{}{}
				if first {
					<-release
				}
				w.WriteHeader(http.StatusAccepted)
			}))
			defer receiver.Close()
			defer once.Do(func() { close(release) })
			f := newCaptureFixture(t, 1)
			var endpoint string
			var version int64
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
				t.Fatal(err)
			}
			svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true}
			mutation := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL}}
			if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, mutation); err != nil {
				t.Fatal(err)
			}
			tasks := taskservice.NewTasks(f.db, f.capture)
			if _, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "late purge"}); err != nil {
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
				c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if err := runner.Stop(c); err != nil {
					t.Error(err)
				}
			}()
			select {
			case <-arrived:
			case err := <-runner.Failures():
				t.Fatal(err)
			case <-time.After(5 * time.Second):
				t.Fatal("request not admitted")
			}
			var delivery, attempt, token string
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,current_attempt_id::text,lease_token::text FROM webhook_deliveries`).Scan(&delivery, &attempt, &token); err != nil {
				t.Fatal(err)
			}
			tx, err := f.db.Pool.Begin(f.ctx)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "purged_stale" {
				_, err = tx.Exec(f.ctx, `UPDATE webhook_deliveries SET state='failed',automatic_open=false,next_attempt_at=NULL,terminal_at=now(),purging_at=now(),lease_token=NULL,lease_claimed_at=NULL,lease_until=NULL,lease_generation=NULL,lease_plan_slot=NULL,current_attempt_id=NULL WHERE id=$1`, delivery)
			} else if mode == "purged_same_lease" {
				_, err = tx.Exec(f.ctx, `UPDATE webhook_deliveries SET purging_at=now() WHERE id=$1`, delivery)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = tx.Exec(f.ctx, `DELETE FROM webhook_attempts WHERE id=$1`, attempt); err != nil {
				t.Fatal(err)
			}
			if err = tx.Commit(f.ctx); err != nil {
				t.Fatal(err)
			}
			once.Do(func() { close(release) })
			if mode == "current_missing" {
				select {
				case err := <-runner.Failures():
					found := false
					for cause := err; cause != nil; cause = errors.Unwrap(cause) {
						if strings.Contains(cause.Error(), "admitted attempt missing") {
							found = true
							break
						}
					}
					if !found {
						t.Fatalf("unexpected failure: %v", err)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("current missing Attempt did not fail")
				}
			} else {
				select {
				case <-observer.committed:
				case err := <-runner.Failures():
					t.Fatalf("purged history failed runner: %v", err)
				case <-time.After(5 * time.Second):
					t.Fatal("late result did not finish")
				}
				if _, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "runner remains available"}); err != nil {
					t.Fatal(err)
				}
				select {
				case <-arrived:
				case err := <-runner.Failures():
					t.Fatalf("runner stopped: %v", err)
				case <-time.After(5 * time.Second):
					t.Fatal("runner did not send next event")
				}
			}
			var count int
			var state string
			var purging *time.Time
			var actualToken *string
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT state,purging_at,lease_token::text,(SELECT count(*) FROM webhook_attempts WHERE id=$2) FROM webhook_deliveries WHERE id=$1`, delivery, attempt).Scan(&state, &purging, &actualToken, &count); err != nil {
				t.Fatal(err)
			}
			if count != 0 {
				t.Fatal("deleted Attempt was recreated")
			}
			if mode == "purged_stale" && (state != "failed" || purging == nil || actualToken != nil) {
				t.Fatalf("purged Delivery changed: %s %v", state, actualToken)
			}
			if mode == "purged_same_lease" && (state != "leased" || purging == nil || actualToken == nil || *actualToken != token) {
				t.Fatalf("purged lease changed: %s %v", state, actualToken)
			}
			if mode == "current_missing" && (state != "leased" || purging != nil || actualToken == nil || *actualToken != token) {
				t.Fatalf("current lease changed: %s %v", state, actualToken)
			}
		})
	}
}
