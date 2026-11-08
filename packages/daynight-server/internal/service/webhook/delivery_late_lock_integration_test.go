package webhook_test

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	webhookhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
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
			var received atomic.Int64
			receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				number := received.Add(1)
				arrived <- struct{}{}
				if number == 1 {
					<-release
					w.WriteHeader(http.StatusAccepted)
					return
				}
				w.WriteHeader(http.StatusServiceUnavailable)
			}))
			defer receiver.Close()
			defer releaseOnce.Do(func() { close(release) })
			f := newCaptureFixture(t, 1)
			var endpoint string
			var version int64
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
				t.Fatal(err)
			}
			svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true, DispatchEnabled: true}
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
			var call func(string, string, string) (int, []byte)
			var newerAttempt string
			var newerAdmitted time.Time
			if !closed {
				sessionToken := secret.Random("dnst_")
				if _, err := f.db.Pool.Exec(f.ctx, `UPDATE sessions SET token_hash=$1 WHERE id=$2`, secret.Hash(sessionToken), f.principal.CredentialID); err != nil {
					t.Fatal(err)
				}
				logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
				auth, e := authhttp.NewAuthentication(identityservice.New(f.db, nil, "https://daynight.example/auth/callback"), config.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
				if e != nil {
					t.Fatal(e)
				}
				mux := http.NewServeMux()
				webhookhttp.NewRoutes(svc, auth, logger).RegisterRoutes(mux)
				host := httptest.NewServer(mux)
				defer host.Close()
				call = func(method, path, body string) (int, []byte) {
					t.Helper()
					req, e := http.NewRequestWithContext(f.ctx, method, host.URL+path, strings.NewReader(body))
					if e != nil {
						t.Fatal(e)
					}
					req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: sessionToken})
					req.Header.Set("Origin", "https://daynight.example")
					req.Header.Set("Content-Type", "application/json")
					resp, e := host.Client().Do(req)
					if e != nil {
						t.Fatal(e)
					}
					defer resp.Body.Close()
					b, e := io.ReadAll(resp.Body)
					if e != nil {
						t.Fatal(e)
					}
					if resp.Header.Get("Daynight-User-ID") != f.principal.UserID || resp.Header.Get("Cache-Control") != "no-store" {
						t.Fatal(resp.Header)
					}
					return resp.StatusCode, b
				}
				var recoveredGen int64
				if e = f.db.Pool.QueryRow(f.ctx, `SELECT generation FROM webhook_deliveries WHERE id=$1`, id).Scan(&recoveredGen); e != nil {
					t.Fatal(e)
				}
				intent := fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"ifVersion":"2","ifGeneration":%q}`, uuid.NewString(), time.Now().UTC().Format(time.RFC3339Nano), f.principal.UserID, fmt.Sprint(recoveredGen))
				path := "/api/v1/me/webhooks/" + endpoint + "/deliveries/" + id
				if status, b := call("POST", path+"/redeliveries", intent); status != 202 {
					t.Fatalf("manual intent status=%d body=%s", status, b)
				}
				select {
				case <-arrived:
				case e := <-runner.Failures():
					t.Fatalf("manual request: %v", e)
				case <-time.After(5 * time.Second):
					t.Fatal("manual request did not reach TLS receiver")
				}
				until := time.Now().Add(5 * time.Second)
				for {
					var state string
					var outcome *string
					e = f.db.Pool.QueryRow(f.ctx, `SELECT d.state,a.id::text,a.admitted_at,a.outcome FROM webhook_deliveries d JOIN webhook_attempts a ON a.delivery_id=d.id AND a.sequence=2 WHERE d.id=$1`, id).Scan(&state, &newerAttempt, &newerAdmitted, &outcome)
					if e != nil {
						t.Fatal(e)
					}
					if state == "pending" && outcome != nil && *outcome == "http_error" {
						break
					}
					if time.Now().After(until) {
						t.Fatalf("manual failure not finalized: state=%s outcome=%v", state, outcome)
					}
					time.Sleep(10 * time.Millisecond)
				}
			}
			newToken := uuid.NewString()
			if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='leased',generation=generation+1,lease_token=$2,lease_claimed_at=now(),lease_until=now()+interval '45 seconds',lease_generation=generation+1 WHERE id=$1`, id, newToken); err != nil {
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
			if !closed {
				path := "/api/v1/me/webhooks/" + endpoint + "/deliveries/" + id
				status, b := call("GET", path, "")
				if status != 200 {
					t.Fatalf("delivery HTTP %d %s", status, b)
				}
				var delivery struct {
					State              string
					AttemptCount       int
					LastAcknowledgedAt *time.Time
					LastResult         *struct {
						Category   string
						HTTPStatus *int
					}
				}
				if e := json.Unmarshal(b, &delivery); e != nil || delivery.State != "leased" || delivery.AttemptCount != 2 || delivery.LastAcknowledgedAt == nil || late == nil || !delivery.LastAcknowledgedAt.Equal(*late) || delivery.LastResult == nil || delivery.LastResult.Category != "http_error" || delivery.LastResult.HTTPStatus == nil || *delivery.LastResult.HTTPStatus != 503 {
					t.Fatalf("delivery HTTP projection=%+v body=%s err=%v", delivery, b, e)
				}
				status, b = call("GET", path+"/attempts", "")
				if status != 200 {
					t.Fatalf("attempt HTTP %d %s", status, b)
				}
				var page struct {
					Items []struct {
						ID                 string
						Outcome            *string
						RecoveredUnknownAt *time.Time
						LateResult         *struct {
							Outcome    *string
							HTTPStatus *int
						}
						HTTPStatus *int
					}
				}
				if e := json.Unmarshal(b, &page); e != nil || len(page.Items) != 2 {
					t.Fatalf("attempt list=%s err=%v", b, e)
				}
				old, newer := page.Items[0], page.Items[1]
				if old.ID != attempt || old.Outcome == nil || *old.Outcome != "unknown" || old.RecoveredUnknownAt == nil || old.LateResult == nil || old.LateResult.Outcome == nil || *old.LateResult.Outcome != "acknowledged" || old.LateResult.HTTPStatus == nil || *old.LateResult.HTTPStatus != 202 || newer.ID != newerAttempt || newer.Outcome == nil || *newer.Outcome != "http_error" || newer.HTTPStatus == nil || *newer.HTTPStatus != 503 {
					t.Fatalf("attempt observations: %s", b)
				}
				status, b = call("GET", "/api/v1/me/webhooks", "")
				if status != 200 {
					t.Fatalf("summary HTTP %d %s", status, b)
				}
				var summaries struct {
					Items []struct {
						ID            string
						LastAttemptAt *time.Time
						LastResult    *struct {
							Category   string
							HTTPStatus *int
						}
					}
				}
				if e := json.Unmarshal(b, &summaries); e != nil || len(summaries.Items) != 1 {
					t.Fatalf("summaries=%s err=%v", b, e)
				}
				summary := summaries.Items[0]
				if summary.ID != endpoint || summary.LastAttemptAt == nil || !summary.LastAttemptAt.Equal(newerAdmitted) || summary.LastResult == nil || summary.LastResult.Category != "http_error" || summary.LastResult.HTTPStatus == nil || *summary.LastResult.HTTPStatus != 503 {
					t.Fatalf("summary not latest: %s", b)
				}
			}
			if err = tx.Commit(f.ctx); err != nil {
				t.Fatal(err)
			}
		})
	}
}
