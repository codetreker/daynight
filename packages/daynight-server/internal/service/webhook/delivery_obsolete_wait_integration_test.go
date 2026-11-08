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

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/google/uuid"
)

// A revision may have no remaining wait leaf after its destination is replaced.
// A real admitted request and its unknown/late outcome must survive that change.
func TestDeliveryOldWaitRemovedAfterAdmission(t *testing.T) {
	for _, recoverLease := range []bool{false, true} {
		name := "finalize"
		if recoverLease {
			name = "recover"
		}
		t.Run(name, func(t *testing.T) {
			arrived := make(chan struct{}, 1)
			release := make(chan struct{})
			var once sync.Once
			receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				arrived <- struct{}{}
				<-release
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
			mutate := func(url string, v int64) {
				m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: v, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: url}}
				if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
					t.Fatal(err)
				}
			}
			mutate(receiver.URL, version)
			if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "old wait"}); err != nil {
				t.Fatal(err)
			}
			roots := x509.NewCertPool()
			roots.AddCert(receiver.Certificate())
			runner := webhook.NewRunner(f.db, svc, true)
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
			var delivery, attempt string
			var oldRevision int64
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,current_attempt_id::text,destination_revision FROM webhook_deliveries`).Scan(&delivery, &attempt, &oldRevision); err != nil {
				t.Fatal(err)
			}
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT config_version FROM webhook_endpoints WHERE id=$1`, endpoint).Scan(&version); err != nil {
				t.Fatal(err)
			}
			mutate("https://example.com/new-target", version)
			if _, err := f.db.Pool.Exec(f.ctx, `DELETE FROM webhook_endpoint_waits WHERE endpoint_id=$1 AND destination_revision=$2`, endpoint, oldRevision); err != nil {
				t.Fatal(err)
			}
			var recovery *webhook.Runner
			if recoverLease {
				if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET lease_claimed_at=now()-interval '46 seconds',lease_until=now()-interval '1 second' WHERE id=$1`, delivery); err != nil {
					t.Fatal(err)
				}
				recovery = webhook.NewRunner(f.db, svc, false)
				if err := recovery.Start(context.Background()); err != nil {
					t.Fatal(err)
				}
				defer func() {
					c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					if err := recovery.Stop(c); err != nil {
						t.Error(err)
					}
				}()
				deadline := time.After(5 * time.Second)
				for {
					var state string
					if err := f.db.Pool.QueryRow(f.ctx, `SELECT state FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&state); err != nil {
						t.Fatal(err)
					}
					if state == "suppressed" {
						break
					}
					select {
					case err := <-recovery.Failures():
						t.Fatal(err)
					case <-deadline:
						t.Fatal("old destination did not stop")
					case <-time.After(20 * time.Millisecond):
					}
				}
			}
			once.Do(func() { close(release) })
			deadline := time.After(5 * time.Second)
			for {
				var state string
				var outcome, late *string
				var recovered *time.Time
				if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.state,a.outcome,a.late_outcome,a.recovered_unknown_at FROM webhook_deliveries d JOIN webhook_attempts a ON a.id=$2 WHERE d.id=$1`, delivery, attempt).Scan(&state, &outcome, &late, &recovered); err != nil {
					t.Fatal(err)
				}
				if recoverLease && recovered != nil && outcome != nil && *outcome == "unknown" && late != nil && *late == "acknowledged" && state == "suppressed" {
					break
				}
				if !recoverLease && outcome != nil && *outcome == "acknowledged" && state == "delivered" {
					break
				}
				select {
				case err := <-runner.Failures():
					t.Fatal(err)
				case <-deadline:
					t.Fatalf("observation missing: state=%s outcome=%v late=%v", state, outcome, late)
				case <-time.After(20 * time.Millisecond):
				}
			}
		})
	}
}
