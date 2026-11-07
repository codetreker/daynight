package task

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
)

// Freeze and proof tests use real PostgreSQL and capture transactions. When
// checking the post-barrier cleanup path, ignore XIDs held by parallel packages.
type passedTaskConfigBarrier struct{ *postgres.Store }

func (s passedTaskConfigBarrier) WebhookConfigGCBarrierPassed(context.Context, string) (bool, error) {
	return true, nil
}

func TestWebhookConfigGCWaitsForFrozenThreadCapture(t *testing.T) {
	f := newCaptureInterleavingFixture(t)
	var sub, binding string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT s.id::text,b.id::text FROM webhook_subscriptions s JOIN webhook_bindings b ON b.subscription_id=s.id WHERE s.endpoint_id=$1 AND b.event_type=$2`, f.endpoint, protocol.ThreadPosted).Scan(&sub, &binding); err != nil {
		t.Fatal(err)
	}
	gate := &frozenGate{inner: f.capture, frozen: make(chan struct{}), release: make(chan struct{})}
	done := make(chan error, 1)
	go func() {
		_, err := NewTaskThreads(f.db, gate).Post(f.ctx, f.principal, f.project, f.task.ID, CreateThreadMessage{Body: "snapshot"})
		done <- err
	}()
	waitGate(t, f.ctx, gate.frozen)
	var types []string
	for _, kind := range corewebhook.EventTypes {
		if kind != protocol.ThreadPosted {
			types = append(types, kind)
		}
	}
	m := webhook.Mutation{Kind: "endpoint.update", EndpointID: f.endpoint, IfVersion: 1, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, RequestSHA256: strings.Repeat("d", 64), HasSubscriptions: true, Subscriptions: []corewebhook.SubscriptionInput{{ID: &sub, ProjectID: f.project, EventTypes: types}}}
	if _, err := f.config.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
		close(gate.release)
		t.Fatal(err)
	}
	collector := &corewebhook.ConfigCollector{}
	n, err := collector.Pass(f.ctx, f.db, 500)
	if err != nil || n != 0 {
		close(gate.release)
		t.Fatalf("collection while capture open: %d %v", n, err)
	}
	var present bool
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM webhook_bindings WHERE id=$1)`, binding).Scan(&present); err != nil || !present {
		close(gate.release)
		t.Fatalf("binding while frozen: %v %v", present, err)
	}
	close(gate.release)
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	n, err = collector.Pass(f.ctx, passedTaskConfigBarrier{f.db}, 500)
	if err != nil || n != 0 {
		t.Fatalf("proof recheck after capture: %d %v", n, err)
	}
	var matches int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_delivery_matches WHERE binding_id=$1`, binding).Scan(&matches); err != nil || matches != 1 {
		t.Fatalf("matched proof=%d err=%v", matches, err)
	}
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM webhook_bindings WHERE id=$1)`, binding).Scan(&present); err != nil || !present {
		t.Fatalf("binding after capture: %v %v; removed=%d", present, err, n)
	}
}

func TestWebhookConfigGCRespectsReceiptAndReclaimsTombstone(t *testing.T) {
	f := newCaptureInterleavingFixture(t)
	m := webhook.Mutation{Kind: "endpoint.delete", EndpointID: f.endpoint, IfVersion: 1, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, RequestSHA256: strings.Repeat("e", 64)}
	if _, err := f.config.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
		t.Fatal(err)
	}
	collector := &corewebhook.ConfigCollector{}
	for i := 0; i < 8; i++ {
		if _, err := collector.Pass(f.ctx, passedTaskConfigBarrier{f.db}, 500); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	var present bool
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM webhook_endpoints WHERE id=$1)`, f.endpoint).Scan(&present); err != nil || !present {
		t.Fatalf("receipt did not retain tombstone: %v %v", present, err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_operations SET recorded_at=now()-interval '31 days',expires_at=now()-interval '1 day' WHERE endpoint_id=$1`, f.endpoint); err != nil {
		t.Fatal(err)
	}
	n, _, err := (&corewebhook.ReceiptCollector{}).Pass(f.ctx, f.db, 500)
	if err != nil || n != 2 {
		t.Fatalf("expired receipt count=%d err=%v", n, err)
	}
	for i := 0; i < 100; i++ {
		if _, err = collector.Pass(f.ctx, passedTaskConfigBarrier{f.db}, 500); err != nil {
			t.Fatal(err)
		}
		if err = f.db.Pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM webhook_endpoints WHERE id=$1)`, f.endpoint).Scan(&present); err != nil {
			t.Fatal(err)
		}
		if !present {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if present {
		t.Fatal("unreferenced endpoint tombstone not reclaimed")
	}
}
