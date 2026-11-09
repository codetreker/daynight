package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhookcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
)

func TestWebhookReceiptGCFenceAndExpiry(t *testing.T) {
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	owner, _, _, expired := webhookStoredFixture(t)
	expired.ID = "00000000-0000-4000-8000-000000000001"
	expired.RecordedAt = time.Now().UTC().Add(-32 * 24 * time.Hour)
	expired.ExpiresAt = expired.RecordedAt.Add(30 * 24 * time.Hour)
	other := expired
	other.ID = "00000000-0000-4000-8000-000000000002"
	other.RecordedAt = time.Now().UTC().Add(-31 * 24 * time.Hour)
	other.ExpiresAt = other.RecordedAt.Add(30 * 24 * time.Hour)
	recent := expired
	recent.ID = "00000000-0000-4000-8000-000000000003"
	recent.RecordedAt = time.Now().UTC().Add(-29 * 24 * time.Hour)
	recent.ExpiresAt = recent.RecordedAt.Add(30 * 24 * time.Hour)
	for _, op := range []struct {
		id  string
		put func(store.WebhookWriter) error
	}{
		{expired.ID, func(w store.WebhookWriter) error { return w.PutOperation(ctx, expired) }},
		{other.ID, func(w store.WebhookWriter) error { return w.PutOperation(ctx, other) }},
		{recent.ID, func(w store.WebhookWriter) error { return w.PutOperation(ctx, recent) }},
	} {
		completion, err := s.WriteWebhook(ctx, owner, op.id, func(sc store.WebhookWriteScope) error { return op.put(sc.WebhookWriter()) })
		if err != nil || completion.Outcome != store.TransactionCommitted {
			t.Fatalf("insert %v %v", completion, err)
		}
	}
	locked, release := make(chan struct{}), make(chan struct{})
	holder := make(chan error, 1)
	go func() {
		_, err := s.WriteWebhook(ctx, owner, expired.ID, func(store.WebhookWriteScope) error { close(locked); <-release; return nil })
		holder <- err
	}()
	<-locked
	id := store.WebhookReceiptIdentity{Owner: owner, OperationID: expired.ID}
	completion, err := s.WriteWebhookReceiptGC(ctx, id, func(store.WebhookReceiptGCScope) error { t.Error("entered busy fence"); return nil })
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, store.ErrWebhookReceiptFenceBusy) {
		close(release)
		t.Fatalf("busy fence %v %v", completion, err)
	}
	collector := &webhookcore.ReceiptCollector{}
	n, _, err := collector.Pass(ctx, s, 1)
	if err != nil || n != 0 {
		close(release)
		t.Fatalf("skip busy: %d %v", n, err)
	}
	n, _, err = collector.Pass(ctx, s, 1)
	if err != nil || n != 1 {
		close(release)
		t.Fatalf("collect other: %d %v", n, err)
	}
	var busyPresent, otherPresent bool
	if err = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_operations WHERE operation_id=$1),EXISTS(SELECT 1 FROM webhook_operations WHERE operation_id=$2)`, expired.ID, other.ID).Scan(&busyPresent, &otherPresent); err != nil || !busyPresent || otherPresent {
		close(release)
		t.Fatalf("busy=%v other=%v err=%v", busyPresent, otherPresent, err)
	}
	close(release)
	if err = <-holder; err != nil {
		t.Fatal(err)
	}
	_, _, err = collector.Pass(ctx, s, 1)
	if err != nil {
		t.Fatal(err)
	}
	n, completion, err = collector.Pass(ctx, s, 1)
	if err != nil || n != 1 || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("collect released: %d %v %v", n, completion, err)
	}
	var remaining string
	if err = s.Pool.QueryRow(ctx, `SELECT operation_id::text FROM webhook_operations`).Scan(&remaining); err != nil || remaining != recent.ID {
		t.Fatalf("remaining=%s err=%v", remaining, err)
	}
}

type changedReceiptAfterScan struct{ *Store }

func (s changedReceiptAfterScan) ExpiredWebhookReceipts(ctx context.Context, after *store.WebhookReceiptIdentity, limit int) ([]store.WebhookReceiptIdentity, error) {
	ids, err := s.Store.ExpiredWebhookReceipts(ctx, after, limit)
	if err != nil || len(ids) == 0 {
		return ids, err
	}
	_, err = s.Pool.Exec(ctx, `UPDATE webhook_operations SET expires_at=clock_timestamp()+interval '1 day' WHERE owner_kind=$1 AND owner_id=$2 AND operation_id=$3`, ids[0].Owner.Kind, ids[0].Owner.ID, ids[0].OperationID)
	return ids, err
}

func TestWebhookReceiptGCRechecksAfterFence(t *testing.T) {
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	owner, _, _, op := webhookStoredFixture(t)
	op.RecordedAt = time.Now().UTC().Add(-31 * 24 * time.Hour)
	op.ExpiresAt = op.RecordedAt.Add(30 * 24 * time.Hour)
	if _, err := s.WriteWebhook(ctx, owner, op.ID, func(sc store.WebhookWriteScope) error { return sc.WebhookWriter().PutOperation(ctx, op) }); err != nil {
		t.Fatal(err)
	}
	// This controlled change tests the stale candidate boundary, not a supported
	// production update to immutable receipts.
	removed, completion, err := (&webhookcore.ReceiptCollector{}).Pass(ctx, changedReceiptAfterScan{s}, 10)
	if err != nil || completion.Outcome != store.TransactionCommitted || removed != 0 {
		t.Fatalf("completion=%v err=%v removed=%v", completion, err, removed)
	}
	var count int
	if err = s.Pool.QueryRow(ctx, `SELECT count(*) FROM webhook_operations`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("count=%d err=%v", count, err)
	}
}
