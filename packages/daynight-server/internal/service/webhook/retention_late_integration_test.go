package webhook_test

import (
	"context"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/google/uuid"
)

type retentionCloseGate struct {
	*postgres.Store
	closed  chan struct{}
	release chan struct{}
}
type retentionCloseScope struct {
	store.WebhookRetentionScope
	closed bool
}

func (s *retentionCloseScope) CloseRetention(ctx context.Context, id string, at time.Time) (int, error) {
	n, e := s.WebhookRetentionScope.CloseRetention(ctx, id, at)
	s.closed = e == nil
	return n, e
}
func (g *retentionCloseGate) WriteWebhookRetention(ctx context.Context, fn func(store.WebhookRetentionScope) error) (store.Completion, error) {
	closed := false
	c, e := g.Store.WriteWebhookRetention(ctx, func(sc store.WebhookRetentionScope) error {
		s := &retentionCloseScope{WebhookRetentionScope: sc}
		err := fn(s)
		closed = s.closed
		return err
	})
	if closed && e == nil && c.Outcome == store.TransactionCommitted {
		close(g.closed)
		select {
		case <-g.release:
		case <-ctx.Done():
		}
	}
	return c, e
}

func TestRetentionAndRealLateWriter(t *testing.T) {
	for _, lateFirst := range []bool{false, true} {
		name := "close_first"
		if lateFirst {
			name = "late_first"
		}
		t.Run(name, func(t *testing.T) { retentionAndRealLateWriter(t, lateFirst) })
	}
}

func retentionAndRealLateWriter(t *testing.T, lateFirst bool) {
	arrived, releaseHTTP := make(chan struct{}, 1), make(chan struct{})
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		arrived <- struct{}{}
		<-releaseHTTP
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
	if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "late retention"}); err != nil {
		t.Fatal(err)
	}
	observer := &observeLateTransactions{base: f.db, committed: make(chan struct{}, 1)}
	runner := newTestRunner(observer, svc, true)
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	httpOpen := true
	t.Cleanup(func() {
		if httpOpen {
			close(releaseHTTP)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := runner.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	select {
	case <-arrived:
	case err := <-runner.Failures():
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("request absent")
	}
	var id, attempt string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,current_attempt_id::text FROM webhook_deliveries`).Scan(&id, &attempt); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET lease_claimed_at=clock_timestamp()-interval '46 seconds',lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	recovery := newTestRunner(f.db, svc, false)
	if err := recovery.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		var state string
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT state FROM webhook_deliveries WHERE id=$1`, id).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state != "leased" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("lease recovery timed out")
		}
		time.Sleep(20 * time.Millisecond)
	}
	stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := recovery.Stop(stop); err != nil {
		t.Fatal(err)
	}
	cancel()
	ageRetention(t, f, id, 40*24*time.Hour)
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_attempts SET finished_at=clock_timestamp()-interval '40 days',recovered_unknown_at=clock_timestamp()-interval '40 days' WHERE id=$1`, attempt); err != nil {
		t.Fatal(err)
	}
	if lateFirst {
		close(releaseHTTP)
		httpOpen = false
		select {
		case <-observer.committed:
		case err := <-runner.Failures():
			t.Fatal(err)
		case <-time.After(time.Second):
			t.Fatal("late writer did not finish")
		}
		if _, _, err := webhook.NewRetention(f.db).Pass(f.ctx); err != nil {
			t.Fatal(err)
		}
		var purging, late *time.Time
		var expiry time.Time
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.purging_at,a.late_observed_at,d.metadata_expires_at FROM webhook_deliveries d JOIN webhook_attempts a ON a.delivery_id=d.id WHERE a.id=$1`, attempt).Scan(&purging, &late, &expiry); err != nil || purging != nil || late == nil || !expiry.After(time.Now().Add(29*24*time.Hour)) {
			t.Fatalf("late activity did not extend retention: %v", err)
		}
		return
	}
	gate := &retentionCloseGate{Store: f.db, closed: make(chan struct{}), release: make(chan struct{})}
	gc := webhook.NewRetention(gate)
	done := make(chan error, 1)
	go func() { _, _, err := gc.Pass(f.ctx); done <- err }()
	select {
	case <-gate.closed:
	case err := <-done:
		t.Fatalf("close failed: %v", err)
	case <-time.After(3 * time.Second):
		t.Fatal("retention close timed out")
	}
	var closed bool
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.purging_at IS NOT NULL AND a.retention_closed_at IS NOT NULL FROM webhook_deliveries d JOIN webhook_attempts a ON a.delivery_id=d.id WHERE a.id=$1`, attempt).Scan(&closed); err != nil || !closed {
		t.Fatalf("not atomically closed: %v", err)
	}
	close(releaseHTTP)
	httpOpen = false
	select {
	case <-observer.committed:
	case err := <-runner.Failures():
		t.Fatal(err)
	case <-time.After(time.Second):
		t.Fatal("late writer did not finish")
	}
	var late *time.Time
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT late_observed_at FROM webhook_attempts WHERE id=$1`, attempt).Scan(&late); err != nil || late != nil {
		t.Fatalf("closed attempt gained late result: %v", err)
	}
	close(gate.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
