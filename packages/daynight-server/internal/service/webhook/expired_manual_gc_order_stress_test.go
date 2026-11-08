//go:build stress

package webhook_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/jackc/pgx/v5"
)

type expiredManualLockGate struct {
	store.WebhookTransactions
	locked, release chan struct{}
}
type expiredManualWriteScope struct {
	store.WebhookWriteScope
	gate *expiredManualLockGate
}
type expiredManualDeliveryScope struct {
	store.WebhookRedeliveryScope
	gate *expiredManualLockGate
}

func (g *expiredManualLockGate) WriteWebhook(ctx context.Context, owner wm.Owner, operation string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
	return g.WebhookTransactions.WriteWebhook(ctx, owner, operation, func(sc store.WebhookWriteScope) error {
		return fn(expiredManualWriteScope{WebhookWriteScope: sc, gate: g})
	})
}
func (s expiredManualWriteScope) RedeliveryWriter() store.WebhookRedeliveryScope {
	return expiredManualDeliveryScope{WebhookRedeliveryScope: s.WebhookWriteScope.RedeliveryWriter(), gate: s.gate}
}
func (s expiredManualDeliveryScope) LockDelivery(ctx context.Context, id string) (store.WebhookDelivery, error) {
	d, err := s.WebhookRedeliveryScope.LockDelivery(ctx, id)
	if err != nil {
		return d, err
	}
	close(s.gate.locked)
	select {
	case <-s.gate.release:
		return d, nil
	case <-ctx.Done():
		return d, ctx.Err()
	}
}

type expiredGCObservation struct {
	phase string
	found bool
}
type expiredGCBarrier struct {
	store.WebhookRetentionTransactions
	store.WebhookReceiptGC
	store.WebhookConfigGC
	observed          chan expiredGCObservation
	committed, resume chan struct{}
}
type expiredGCScope struct {
	store.WebhookRetentionScope
	observed chan expiredGCObservation
	closed   *bool
}

func (s expiredGCScope) LockRetentionCandidate(ctx context.Context, phase string, now time.Time) (store.WebhookDelivery, bool, error) {
	d, found, err := s.WebhookRetentionScope.LockRetentionCandidate(ctx, phase, now)
	if err == nil {
		s.observed <- expiredGCObservation{phase, found}
	}
	return d, found, err
}
func (s expiredGCScope) CloseRetention(ctx context.Context, id string, now time.Time) (int, error) {
	n, err := s.WebhookRetentionScope.CloseRetention(ctx, id, now)
	if err == nil && n > 0 {
		*s.closed = true
	}
	return n, err
}
func (g *expiredGCBarrier) WriteWebhookRetention(ctx context.Context, fn func(store.WebhookRetentionScope) error) (store.Completion, error) {
	closed := false
	completion, err := g.WebhookRetentionTransactions.WriteWebhookRetention(ctx, func(sc store.WebhookRetentionScope) error {
		return fn(expiredGCScope{WebhookRetentionScope: sc, observed: g.observed, closed: &closed})
	})
	if err == nil && completion.Outcome == store.TransactionCommitted && closed {
		close(g.committed)
		select {
		case <-g.resume:
		case <-ctx.Done():
			return completion, ctx.Err()
		}
	}
	return completion, err
}

// A historical source row creates the event with its original seven-day window.
// The capture's recorded time and last activity are shifted to the same period
// to represent a quiescent, already expired record; all decisions use PG time.
func TestExpiredManualLocksBeforeRealGCStress(t *testing.T) {
	f := newCaptureFixture(t, 1)
	if _, err := f.db.Pool.Exec(f.ctx, `CREATE FUNCTION t07_expired_manual_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.created_at=statement_timestamp()-interval '31 days'; NEW.updated_at=NEW.created_at; RETURN NEW; END $$; CREATE TRIGGER t07_expired_manual_source BEFORE INSERT ON tasks FOR EACH ROW EXECUTE FUNCTION t07_expired_manual_source()`); err != nil {
		t.Fatal(err)
	}
	created, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "expired manual lock order"})
	if err != nil {
		t.Fatal(err)
	}
	var endpoint, delivery, event string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT endpoint_id::text,id::text,event_id::text FROM webhook_deliveries`).Scan(&endpoint, &delivery, &event); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_events SET recorded_at=occurred_at+interval '1 second' WHERE id=$1`, event); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='failed',automatic_open=false,next_attempt_at=NULL,terminal_at=occurred_at+interval '1 second',last_activity_at=occurred_at+interval '1 second',metadata_expires_at=occurred_at+interval '30 days 1 second' WHERE id=$1`, delivery); err != nil {
		t.Fatal(err)
	}
	var sourceAt, eventAt, recordedAt, deliveryAt, payloadAt, metadataAt time.Time
	var body []byte
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT t.created_at,e.occurred_at,e.recorded_at,d.occurred_at,d.payload_expires_at,d.metadata_expires_at,d.body FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id JOIN tasks t ON t.id=e.task_id WHERE d.id=$1`, delivery).Scan(&sourceAt, &eventAt, &recordedAt, &deliveryAt, &payloadAt, &metadataAt, &body); err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Time string `json:"time"`
	}
	if err = json.Unmarshal(body, &wire); err != nil {
		t.Fatal(err)
	}
	wireAt, err := time.Parse(time.RFC3339Nano, wire.Time)
	if err != nil {
		t.Fatal(err)
	}
	if !sourceAt.Equal(created.CreatedAt) || !sourceAt.Equal(eventAt) || !eventAt.Equal(deliveryAt) || !eventAt.Equal(wireAt) || !recordedAt.Equal(eventAt.Add(time.Second)) || !payloadAt.Equal(eventAt.Add(7*24*time.Hour)) || !metadataAt.Equal(recordedAt.Add(30*24*time.Hour)) || !metadataAt.Before(time.Now()) {
		t.Fatal("historical source, wire and original deadlines do not agree")
	}
	setJointFixtureTime(t, f, endpoint, sourceAt.Add(-31*24*time.Hour))
	assertJointFixtureTime(t, f, endpoint, sourceAt)
	token := secret.Random("dnst_")
	if _, err = f.db.Pool.Exec(f.ctx, `UPDATE sessions SET token_hash=$1 WHERE id=$2`, secret.Hash(token), f.principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	manualDB, _ := singleBarrierStore(t, f, "expired_manual_first")
	manual := &expiredManualLockGate{WebhookTransactions: manualDB, locked: make(chan struct{}), release: make(chan struct{})}
	var manualRelease sync.Once
	t.Cleanup(func() { manualRelease.Do(func() { close(manual.release) }) })
	svc := &webhook.Service{DB: manual, ConfigurationExpansionAvailable: true, DispatchEnabled: true}
	r := jointRetentionHost(t, f, svc, token, endpoint, delivery)
	t.Cleanup(func() { manualRelease.Do(func() { close(manual.release) }) })
	result := r.call("POST", "/redeliveries", r.intent())
	select {
	case <-manual.locked:
	case x := <-result:
		t.Fatalf("HTTP ended before Delivery lock: %+v", x)
	case <-time.After(5 * time.Second):
		t.Fatal("HTTP did not lock Delivery")
	}
	// Verify the actual PG row lock, not only the wrapper signal.
	check, err := f.db.Pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	var id string
	err = check.QueryRow(f.ctx, `SELECT id::text FROM webhook_deliveries WHERE id=$1 FOR UPDATE SKIP LOCKED`, delivery).Scan(&id)
	if e := check.Rollback(f.ctx); e != nil {
		t.Fatal(e)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("locked Delivery was not skipped: id=%s err=%v", id, err)
	}
	gc := &expiredGCBarrier{WebhookRetentionTransactions: f.db, WebhookReceiptGC: f.db, WebhookConfigGC: f.db, observed: make(chan expiredGCObservation, 64), committed: make(chan struct{}), resume: make(chan struct{})}
	var gcRelease sync.Once
	t.Cleanup(func() { gcRelease.Do(func() { close(gc.resume) }) })
	if _, _, err = webhook.NewRetention(gc).Pass(f.ctx); err != nil {
		t.Fatal(err)
	}
	closeSkipped := false
	for len(gc.observed) > 0 {
		v := <-gc.observed
		if v.phase == "close" && !v.found {
			closeSkipped = true
		}
	}
	if !closeSkipped {
		t.Fatal("real GC did not skip locked expired Delivery")
	}
	var purging *time.Time
	var generation int64
	var manualCount, receipts, attempts int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT purging_at,generation,manual_operation_count,(SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver'),(SELECT count(*) FROM webhook_attempts) FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&purging, &generation, &manualCount, &receipts, &attempts); err != nil || purging != nil || generation != 1 || manualCount != 0 || receipts != 0 || attempts != 0 {
		t.Fatalf("during lock purge=%v generation=%d manual=%d receipts=%d attempts=%d err=%v", purging, generation, manualCount, receipts, attempts, err)
	}
	manualRelease.Do(func() { close(manual.release) })
	retentionReceive(t, r, result, http.StatusNotFound)
	done := make(chan error, 1)
	go func() { _, _, e := webhook.NewRetention(gc).Pass(f.ctx); done <- e }()
	select {
	case <-gc.committed:
	case e := <-done:
		t.Fatalf("GC ended before committed closure: %v", e)
	case <-time.After(5 * time.Second):
		t.Fatal("GC did not close expired history")
	}
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT purging_at,generation,manual_operation_count,(SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver'),(SELECT count(*) FROM webhook_attempts) FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&purging, &generation, &manualCount, &receipts, &attempts); err != nil || purging == nil || generation != 1 || manualCount != 0 || receipts != 0 || attempts != 0 {
		t.Fatalf("after close purge=%v generation=%d manual=%d receipts=%d attempts=%d err=%v", purging, generation, manualCount, receipts, attempts, err)
	}
	// The second request uses an ungated service; the committed close must be
	// visible to new HTTP snapshots while physical deletion is still paused.
	plain := jointRetentionHost(t, f, &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true, DispatchEnabled: true}, token, endpoint, delivery)
	t.Cleanup(func() { gcRelease.Do(func() { close(gc.resume) }) })
	retentionReceive(t, plain, plain.call("GET", "", ""), http.StatusNotFound)
	retentionReceive(t, plain, plain.call("POST", "/redeliveries", plain.intent()), http.StatusNotFound)
	gcRelease.Do(func() { close(gc.resume) })
	select {
	case err = <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("GC pass did not finish")
	}
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_deliveries WHERE id=$1),(SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver'),(SELECT count(*) FROM webhook_attempts)`, delivery).Scan(&manualCount, &receipts, &attempts); err != nil || manualCount != 0 || receipts != 0 || attempts != 0 {
		t.Fatalf("after purge deliveries=%d receipts=%d attempts=%d err=%v", manualCount, receipts, attempts, err)
	}
	t.Logf("event=%s delivery=%s source=%s payload_expiry=%s metadata_expiry=%s http_lock_first=true gc_skip_locked=true http_before_after=404,404 generation=1 intents=0 receipts=0 attempts=0 gc_close_then_purge=true", event, delivery, sourceAt.Format(time.RFC3339Nano), payloadAt.Format(time.RFC3339Nano), metadataAt.Format(time.RFC3339Nano))
}
