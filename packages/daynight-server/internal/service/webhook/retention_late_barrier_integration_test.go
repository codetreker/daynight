package webhook_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type lateAttemptBarrier struct {
	base    store.WebhookDeliveryTransactions
	locked  chan struct{}
	release chan struct{}
	once    sync.Once
	at      time.Time
}
type lateAttemptBarrierScope struct {
	store.WebhookDeliveryScope
	barrier *lateAttemptBarrier
	late    bool
}

func (s *lateAttemptBarrierScope) LockOwnAttempt(ctx context.Context, id string) (store.WebhookAttempt, error) {
	s.late = true
	a, err := s.WebhookDeliveryScope.LockOwnAttempt(ctx, id)
	if err != nil {
		return a, err
	}
	s.barrier.once.Do(func() {
		close(s.barrier.locked)
		select {
		case <-s.barrier.release:
		case <-ctx.Done():
		}
	})
	return a, nil
}

// Only the late observation uses the controlled clock. Admission and recovery
// retain the real database timestamps that produced the attempt.
func (s *lateAttemptBarrierScope) ObservedAt(ctx context.Context) (time.Time, error) {
	if s.late {
		return s.barrier.at, nil
	}
	return s.WebhookDeliveryScope.ObservedAt(ctx)
}
func (b *lateAttemptBarrier) WriteWebhookDelivery(ctx context.Context, fn func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	return b.base.WriteWebhookDelivery(ctx, func(sc store.WebhookDeliveryScope) error {
		return fn(&lateAttemptBarrierScope{WebhookDeliveryScope: sc, barrier: b})
	})
}

type retentionAttemptBarrier struct {
	*postgres.Store
	locked       chan struct{}
	release      chan struct{}
	committed    chan struct{}
	continuePass chan struct{}
	once         sync.Once
	commitOnce   sync.Once
	at           time.Time
}
type retentionAttemptBarrierScope struct {
	store.WebhookRetentionScope
	barrier *retentionAttemptBarrier
	closed  bool
}

func (s *retentionAttemptBarrierScope) ObservedAt(context.Context) (time.Time, error) {
	return s.barrier.at, nil
}
func (s *retentionAttemptBarrierScope) LockAttempts(ctx context.Context, id string) ([]store.WebhookAttempt, error) {
	attempts, err := s.WebhookRetentionScope.LockAttempts(ctx, id)
	if err != nil {
		return nil, err
	}
	s.barrier.once.Do(func() {
		close(s.barrier.locked)
		select {
		case <-s.barrier.release:
		case <-ctx.Done():
		}
	})
	return attempts, nil
}
func (s *retentionAttemptBarrierScope) CloseRetention(ctx context.Context, id string, now time.Time) (int, error) {
	n, err := s.WebhookRetentionScope.CloseRetention(ctx, id, now)
	s.closed = err == nil
	return n, err
}
func (b *retentionAttemptBarrier) WriteWebhookRetention(ctx context.Context, fn func(store.WebhookRetentionScope) error) (store.Completion, error) {
	var closed bool
	completion, err := b.Store.WriteWebhookRetention(ctx, func(sc store.WebhookRetentionScope) error {
		wrapped := &retentionAttemptBarrierScope{WebhookRetentionScope: sc, barrier: b}
		e := fn(wrapped)
		closed = wrapped.closed
		return e
	})
	if closed && err == nil && completion.Outcome == store.TransactionCommitted {
		b.commitOnce.Do(func() {
			close(b.committed)
			select {
			case <-b.continuePass:
			case <-ctx.Done():
			}
		})
	}
	return completion, err
}

func singleBarrierStore(t *testing.T, f *captureFixture, name string) (*postgres.Store, int32) {
	t.Helper()
	u, err := url.Parse(f.db.Pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	q.Set("pool_max_conns", "1")
	q.Set("application_name", name)
	u.RawQuery = q.Encode()
	pool, err := pgxpool.New(f.ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var pid int32
	if err = pool.QueryRow(f.ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	return &postgres.Store{Pool: pool}, pid
}
func waitAttemptBlock(t *testing.T, f *captureFixture, waiter, blocker int32) {
	t.Helper()
	deadline := time.Now().Add(1500 * time.Millisecond)
	for {
		var blocked bool
		err := f.db.Pool.QueryRow(f.ctx, `SELECT $2::integer = ANY(pg_blocking_pids($1::integer))`, waiter, blocker).Scan(&blocked)
		if err != nil {
			t.Fatal(err)
		}
		if blocked {
			t.Logf("observed backend %d blocked by %d", waiter, blocker)
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("backend %d did not block on %d", waiter, blocker)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestRetentionLateAttemptLockBarriers(t *testing.T) {
	for _, lateFirst := range []bool{true, false} {
		name := "close_first"
		if lateFirst {
			name = "late_first"
		}
		t.Run(name, func(t *testing.T) { testRetentionLateAttemptLockBarriers(t, lateFirst) })
	}
}
func testRetentionLateAttemptLockBarriers(t *testing.T, lateFirst bool) {
	arrived, releaseHTTP := make(chan struct{}, 1), make(chan struct{})
	var releaseOnce sync.Once
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		arrived <- struct{}{}
		<-releaseHTTP
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(receiver.Close)
	f := newCaptureFixture(t, 1)
	var endpoint string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true}
	m := webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL}}
	if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
		t.Fatal(err)
	}
	created, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "late GC lock barrier"})
	if err != nil {
		t.Fatal(err)
	}
	runnerDB, runnerPID := singleBarrierStore(t, f, "t06_late_lock")
	gcDB, gcPID := singleBarrierStore(t, f, "t06_gc_lock")
	observer := &observeLateTransactions{base: runnerDB, committed: make(chan struct{}, 1)}
	controlledAt := created.CreatedAt.Add(40 * 24 * time.Hour)
	late := &lateAttemptBarrier{base: observer, locked: make(chan struct{}), release: make(chan struct{}), at: controlledAt}
	runner := webhook.NewRunner(late, svc, true)
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err := runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(releaseHTTP) })
		select {
		case <-late.release:
		default:
			close(late.release)
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
		t.Fatal("real TLS request absent")
	}
	var id, attempt string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,current_attempt_id::text FROM webhook_deliveries`).Scan(&id, &attempt); err != nil {
		t.Fatal(err)
	}
	var sourceAt, eventAt, deliveryAt, recordedAt, automatic, payload time.Time
	var sourceBody, fact, hash, factHash []byte
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT t.created_at,e.occurred_at,d.occurred_at,e.recorded_at,d.automatic_expires_at,d.payload_expires_at,d.body,e.fact_bytes,d.body_sha256,e.fact_sha256 FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id JOIN tasks t ON t.id=e.task_id WHERE d.id=$1`, id).Scan(&sourceAt, &eventAt, &deliveryAt, &recordedAt, &automatic, &payload, &sourceBody, &fact, &hash, &factHash); err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Time string `json:"time"`
	}
	if err = json.Unmarshal(sourceBody, &wire); err != nil {
		t.Fatal(err)
	}
	wireTime, err := time.Parse(time.RFC3339Nano, wire.Time)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(sourceBody)
	if !sourceAt.Equal(created.CreatedAt) || !sourceAt.Equal(eventAt) || !eventAt.Equal(deliveryAt) || !eventAt.Equal(wireTime) || !automatic.Equal(eventAt.Add(72*time.Hour)) || !payload.Equal(eventAt.Add(7*24*time.Hour)) || !bytes.Equal(sourceBody, fact) || !bytes.Equal(hash, digest[:]) || !bytes.Equal(hash, factHash) {
		t.Fatal("source, event, body, hash, and original deadlines disagree")
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET lease_claimed_at=clock_timestamp()-interval '46 seconds',lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	recovery := webhook.NewRunner(f.db, svc, false)
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
	var metadata, finished, recovered time.Time
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.metadata_expires_at,a.finished_at,a.recovered_unknown_at FROM webhook_deliveries d JOIN webhook_attempts a ON a.delivery_id=d.id WHERE a.id=$1`, attempt).Scan(&metadata, &finished, &recovered); err != nil {
		t.Fatal(err)
	}
	if !controlledAt.After(metadata) || !controlledAt.After(payload) || finished.Before(recordedAt) || recovered.Before(recordedAt) {
		t.Fatal("controlled observation or real recovery time invalid")
	}
	gate := &retentionAttemptBarrier{Store: gcDB, locked: make(chan struct{}), release: make(chan struct{}), committed: make(chan struct{}), continuePass: make(chan struct{}), at: controlledAt}
	t.Cleanup(func() {
		select {
		case <-gate.release:
		default:
			close(gate.release)
		}
		select {
		case <-gate.continuePass:
		default:
			close(gate.continuePass)
		}
	})
	assertCaptured := func() {
		t.Helper()
		var eventAfter, deliveryAfter, autoAfter, payloadAfter time.Time
		var bodyAfter, factAfter, hashAfter, factHashAfter []byte
		var payloadRemoved, factRemoved bool
		err := f.db.Pool.QueryRow(f.ctx, `SELECT e.occurred_at,d.occurred_at,d.automatic_expires_at,d.payload_expires_at,d.body,e.fact_bytes,d.body_sha256,e.fact_sha256,d.payload_removed_at IS NOT NULL,e.fact_removed_at IS NOT NULL FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.id=$1`, id).Scan(&eventAfter, &deliveryAfter, &autoAfter, &payloadAfter, &bodyAfter, &factAfter, &hashAfter, &factHashAfter, &payloadRemoved, &factRemoved)
		if err != nil || !eventAfter.Equal(eventAt) || !deliveryAfter.Equal(deliveryAt) || !autoAfter.Equal(automatic) || !payloadAfter.Equal(payload) || !bytes.Equal(hashAfter, hash) || !bytes.Equal(factHashAfter, factHash) || (!payloadRemoved && !bytes.Equal(bodyAfter, sourceBody)) || (payloadRemoved && bodyAfter != nil) || (!factRemoved && !bytes.Equal(factAfter, fact)) || (factRemoved && factAfter != nil) {
			t.Fatalf("captured evidence changed: %v", err)
		}
	}
	gcDone := make(chan error, 1)
	startGC := func() { go func() { _, _, e := webhook.NewRetention(gate).Pass(f.ctx); gcDone <- e }() }
	if lateFirst {
		releaseOnce.Do(func() { close(releaseHTTP) })
		select {
		case <-late.locked:
		case err := <-runner.Failures():
			t.Fatal(err)
		case <-time.After(5 * time.Second):
			t.Fatal("late writer did not lock Attempt")
		}
		close(gate.release)
		close(gate.continuePass)
		startGC()
		waitAttemptBlock(t, f, gcPID, runnerPID)
		close(late.release)
		select {
		case <-observer.committed:
		case err := <-runner.Failures():
			t.Fatal(err)
		case <-time.After(2 * time.Second):
			t.Fatal("late commit missing")
		}
		if err := <-gcDone; err != nil {
			t.Fatal(err)
		}
		var purging, observed *time.Time
		var expiry time.Time
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.purging_at,a.late_observed_at,d.metadata_expires_at FROM webhook_deliveries d JOIN webhook_attempts a ON a.delivery_id=d.id WHERE a.id=$1`, attempt).Scan(&purging, &observed, &expiry); err != nil || purging != nil || observed == nil || !observed.Equal(controlledAt) || !expiry.Equal(controlledAt.Add(30*24*time.Hour)) {
			t.Fatalf("late first retention state %v %v %v %v", purging, observed, expiry, err)
		}
		assertCaptured()
	} else {
		close(late.release)
		startGC()
		select {
		case <-gate.locked:
		case err := <-gcDone:
			t.Fatalf("GC ended before barrier: %v", err)
		case <-time.After(2 * time.Second):
			t.Fatal("GC did not lock Attempt")
		}
		releaseOnce.Do(func() { close(releaseHTTP) })
		waitAttemptBlock(t, f, runnerPID, gcPID)
		close(gate.release)
		select {
		case <-gate.committed:
		case err := <-gcDone:
			t.Fatalf("GC failed to close: %v", err)
		case <-time.After(2 * time.Second):
			t.Fatal("close commit missing")
		}
		select {
		case <-observer.committed:
		case err := <-runner.Failures():
			t.Fatal(err)
		case <-time.After(2 * time.Second):
			t.Fatal("late writer completion missing")
		}
		var closed bool
		var observed *time.Time
		var purgeAt, closedAt time.Time
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.purging_at IS NOT NULL AND a.retention_closed_at IS NOT NULL,a.late_observed_at,d.purging_at,a.retention_closed_at FROM webhook_deliveries d JOIN webhook_attempts a ON a.delivery_id=d.id WHERE a.id=$1`, attempt).Scan(&closed, &observed, &purgeAt, &closedAt); err != nil || !closed || observed != nil || !purgeAt.Equal(controlledAt) || !closedAt.Equal(controlledAt) {
			t.Fatalf("close first state %t %v %v", closed, observed, err)
		}
		assertCaptured()
		close(gate.continuePass)
		if err := <-gcDone; err != nil {
			t.Fatal(err)
		}
	}
}
