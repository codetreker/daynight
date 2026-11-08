package webhook_test

import (
	"context"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/google/uuid"
)

func setupDeliveryReceiver(t *testing.T, server *httptest.Server) (*captureFixture, *webhook.Service, string) {
	t.Helper()
	f := newCaptureFixture(t, 1)
	var id string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&id, &version); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true}
	m := webhook.Mutation{Kind: "endpoint.update", EndpointID: id, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: server.URL}}
	if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
		t.Fatal(err)
	}
	if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "delivery boundary"}); err != nil {
		t.Fatal(err)
	}
	return f, svc, id
}
func startDeliveryTestRunner(t *testing.T, f *captureFixture, svc *webhook.Service, s *httptest.Server) *webhook.Runner {
	t.Helper()
	roots := x509.NewCertPool()
	roots.AddCert(s.Certificate())
	runner := webhook.NewRunner(f.db, svc, true)
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := runner.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	return runner
}

func TestDeliveryRetryAfterHTTPDateAndFailures(t *testing.T) {
	for _, mode := range []string{"date", "invalid", "over_deadline"} {
		t.Run(mode, func(t *testing.T) {
			var requests atomic.Int32
			var header string
			switch mode {
			case "date":
				header = time.Now().UTC().Add(2 * time.Minute).Format(http.TimeFormat)
			case "invalid":
				header = "not-a-date"
			case "over_deadline":
				header = time.Now().UTC().Add(96 * time.Hour).Format(http.TimeFormat)
			}
			receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				w.Header().Set("Retry-After", header)
				w.WriteHeader(503)
			}))
			defer receiver.Close()
			f, svc, endpoint := setupDeliveryReceiver(t, receiver)
			runner := startDeliveryTestRunner(t, f, svc, receiver)
			deadline := time.After(5 * time.Second)
			for {
				var state string
				var outcome, diag *string
				var wait, attemptWait *time.Time
				err := f.db.Pool.QueryRow(f.ctx, `SELECT d.state,a.outcome,a.retry_after_diagnostic_code,a.retry_after_not_before,w.not_before FROM webhook_deliveries d LEFT JOIN webhook_attempts a ON a.delivery_id=d.id JOIN webhook_endpoint_waits w ON w.endpoint_id=d.endpoint_id AND w.destination_revision=d.destination_revision`).Scan(&state, &outcome, &diag, &attemptWait, &wait)
				if err != nil {
					t.Fatal(err)
				}
				if outcome != nil {
					if *outcome != "http_error" || requests.Load() != 1 {
						t.Fatalf("outcome=%v requests=%d", outcome, requests.Load())
					}
					switch mode {
					case "invalid":
						if diag == nil || *diag != "invalid_retry_after" || attemptWait != nil || wait != nil || state != "pending" {
							t.Fatalf("invalid state=%s diag=%v", state, diag)
						}
					case "date", "over_deadline":
						expected, err := http.ParseTime(header)
						if err != nil {
							t.Fatal(err)
						}
						if diag != nil || attemptWait == nil || wait == nil || !attemptWait.Equal(expected) || !wait.Equal(expected) {
							t.Fatalf("date attempt=%v wait=%v", attemptWait, wait)
						}
						if mode == "over_deadline" && state != "failed" {
							t.Fatalf("deadline state %s", state)
						}
						if mode == "date" && state != "pending" {
							t.Fatalf("date state %s", state)
						}
					}
					if mode == "date" {
						var version int64
						if err = f.db.Pool.QueryRow(f.ctx, `SELECT config_version FROM webhook_endpoints WHERE id=$1`, endpoint).Scan(&version); err != nil {
							t.Fatal(err)
						}
						m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL + "/new"}}
						if _, err = svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
							t.Fatal(err)
						}
						var newWait *time.Time
						if err = f.db.Pool.QueryRow(f.ctx, `SELECT w.not_before FROM webhook_endpoint_waits w JOIN webhook_endpoints e ON e.id=w.endpoint_id AND e.destination_revision=w.destination_revision WHERE e.id=$1`, endpoint).Scan(&newWait); err != nil || newWait != nil {
							t.Fatalf("new wait=%v err=%v", newWait, err)
						}
					}
					return
				}
				select {
				case e := <-runner.Failures():
					t.Fatalf("runner: %v", e)
				case <-deadline:
					t.Fatal("missing result")
				case <-time.After(20 * time.Millisecond):
				}
			}
		})
	}
}

func TestDeliveryUnavailableKeyNeverSends(t *testing.T) {
	for _, mode := range []string{"missing", "invalid_current"} {
		t.Run(mode, func(t *testing.T) {
			var requests atomic.Int32
			receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { requests.Add(1); w.WriteHeader(202) }))
			defer receiver.Close()
			f, svc, _ := setupDeliveryReceiver(t, receiver)
			query := `DELETE FROM webhook_signing_keys WHERE slot='current'`
			if mode == "invalid_current" {
				query = `UPDATE webhook_signing_keys SET id=gen_random_uuid() WHERE slot='current'`
			}
			if _, err := f.db.Pool.Exec(f.ctx, query); err != nil {
				t.Fatal(err)
			}
			runner := startDeliveryTestRunner(t, f, svc, receiver)
			select {
			case <-runner.Failures():
			case <-time.After(5 * time.Second):
				t.Fatal("key failure not reported")
			}
			var attempts, count int
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_attempts),automatic_attempt_count FROM webhook_deliveries`).Scan(&attempts, &count); err != nil {
				t.Fatal(err)
			}
			if attempts != 0 || count != 0 || requests.Load() != 0 {
				t.Fatalf("attempts=%d automatic=%d requests=%d", attempts, count, requests.Load())
			}
		})
	}
}
