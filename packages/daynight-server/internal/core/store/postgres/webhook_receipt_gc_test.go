package postgres

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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
	locked, release, holderDone := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	releaseHolder := func() { releaseOnce.Do(func() { close(release) }) }
	holderCtx, cancelHolder := context.WithTimeout(context.Background(), 10*time.Second)
	var holderCompletion store.Completion
	var holderErr error
	t.Cleanup(func() {
		defer cancelHolder()
		releaseHolder()
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		select {
		case <-holderDone:
		case <-cleanup.Done():
			t.Error("receipt fence holder did not finish after release")
			cancelHolder()
			drain, stopDrain := context.WithTimeout(context.Background(), 5*time.Second)
			defer stopDrain()
			select {
			case <-holderDone:
			case <-drain.Done():
				t.Error("receipt fence holder did not drain after cancellation")
				return
			}
		}
		if holderErr != nil || holderCompletion.Outcome != store.TransactionCommitted {
			t.Errorf("receipt fence holder completion: %+v %v", holderCompletion, holderErr)
		}
	})
	go func() {
		holderCompletion, holderErr = s.WriteWebhook(holderCtx, owner, expired.ID, func(store.WebhookWriteScope) error {
			close(locked)
			select {
			case <-release:
				return nil
			case <-holderCtx.Done():
				return holderCtx.Err()
			}
		})
		close(holderDone)
	}()
	select {
	case <-locked:
	case <-holderDone:
		t.Fatalf("holder ended before taking the receipt fence: %+v %v", holderCompletion, holderErr)
	case <-ctx.Done():
		t.Fatal("receipt fence holder did not start")
	}
	first := store.WebhookReceiptIdentity{Owner: owner, OperationID: expired.ID}
	second := store.WebhookReceiptIdentity{Owner: owner, OperationID: other.ID}
	scan := func(after *store.WebhookReceiptIdentity, want []store.WebhookReceiptIdentity) {
		t.Helper()
		ids, err := s.ExpiredWebhookReceipts(ctx, after, 1)
		if err != nil || len(ids) != len(want) || (len(want) != 0 && !reflect.DeepEqual(ids, want)) {
			t.Fatalf("expired receipt scan after=%+v: got=%+v want=%+v err=%v", after, ids, want, err)
		}
	}
	scan(nil, []store.WebhookReceiptIdentity{first})
	entered := false
	completion, err := s.WriteWebhookReceiptGC(ctx, first, func(store.WebhookReceiptGCScope) error {
		entered = true
		return nil
	})
	if entered || completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, store.ErrWebhookReceiptFenceBusy) {
		t.Fatalf("busy fence entered=%v completion=%+v err=%v", entered, completion, err)
	}
	deleteExpired := func(id store.WebhookReceiptIdentity, expectedExpiry time.Time) {
		t.Helper()
		removed := false
		completion, err := s.WriteWebhookReceiptGC(ctx, id, func(sc store.WebhookReceiptGCScope) error {
			expiry, observedAt, present, err := sc.ReceiptExpiry(ctx, id)
			if err != nil {
				return err
			}
			if !present || !expiry.Equal(expectedExpiry.Truncate(time.Microsecond)) || !observedAt.After(expiry) {
				return fmt.Errorf("locked expired receipt identity=%+v expiry=%v observed=%v present=%v", id, expiry, observedAt, present)
			}
			removed, err = sc.DeleteReceipt(ctx, id)
			return err
		})
		if err != nil || completion.Outcome != store.TransactionCommitted || !removed {
			t.Fatalf("expired receipt deletion identity=%+v removed=%v completion=%+v err=%v", id, removed, completion, err)
		}
	}
	scan(&first, []store.WebhookReceiptIdentity{second})
	deleteExpired(second, other.ExpiresAt)
	var busyPresent, otherPresent bool
	if err = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_operations WHERE operation_id=$1),EXISTS(SELECT 1 FROM webhook_operations WHERE operation_id=$2)`, expired.ID, other.ID).Scan(&busyPresent, &otherPresent); err != nil || !busyPresent || otherPresent {
		t.Fatalf("busy=%v other=%v err=%v", busyPresent, otherPresent, err)
	}
	releaseHolder()
	select {
	case <-holderDone:
	case <-ctx.Done():
		t.Fatal("receipt fence holder did not finish")
	}
	if holderErr != nil || holderCompletion.Outcome != store.TransactionCommitted {
		t.Fatalf("receipt fence holder completion: %+v %v", holderCompletion, holderErr)
	}
	scan(&second, nil)
	scan(nil, []store.WebhookReceiptIdentity{first})
	deleteExpired(first, expired.ExpiresAt)
	var count int
	var remaining string
	if err = s.Pool.QueryRow(ctx, `SELECT count(*),coalesce(min(operation_id::text),'') FROM webhook_operations`).Scan(&count, &remaining); err != nil || count != 1 || remaining != recent.ID {
		t.Fatalf("remaining count=%d identity=%s err=%v", count, remaining, err)
	}
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
	id := store.WebhookReceiptIdentity{Owner: owner, OperationID: op.ID}
	ids, err := s.ExpiredWebhookReceipts(ctx, nil, 10)
	if err != nil || !reflect.DeepEqual(ids, []store.WebhookReceiptIdentity{id}) {
		t.Fatalf("stale receipt scan: %+v %v", ids, err)
	}
	// This controlled change tests the stale candidate boundary, not a supported
	// production update to immutable receipts.
	var updatedExpiry time.Time
	if err := s.Pool.QueryRow(ctx, `UPDATE webhook_operations SET expires_at=clock_timestamp()+interval '1 day' WHERE owner_kind=$1 AND owner_id=$2 AND operation_id=$3 RETURNING expires_at`, id.Owner.Kind, id.Owner.ID, id.OperationID).Scan(&updatedExpiry); err != nil {
		t.Fatal(err)
	}
	checked := false
	completion, err := s.WriteWebhookReceiptGC(ctx, ids[0], func(sc store.WebhookReceiptGCScope) error {
		expiry, observedAt, present, err := sc.ReceiptExpiry(ctx, ids[0])
		if err != nil {
			return err
		}
		if !present || !expiry.Equal(updatedExpiry) || !observedAt.Before(expiry) {
			return fmt.Errorf("locked fresh receipt identity=%+v expiry=%v expected=%v observed=%v present=%v", ids[0], expiry, updatedExpiry, observedAt, present)
		}
		checked = true
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted || !checked {
		t.Fatalf("stale candidate recheck completion=%+v checked=%v err=%v", completion, checked, err)
	}
	var count int
	if err = s.Pool.QueryRow(ctx, `SELECT count(*) FROM webhook_operations`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("count=%d err=%v", count, err)
	}
	var persistedExpiry time.Time
	if err = s.Pool.QueryRow(ctx, `SELECT expires_at FROM webhook_operations WHERE owner_kind=$1 AND owner_id=$2 AND operation_id=$3`, id.Owner.Kind, id.Owner.ID, id.OperationID).Scan(&persistedExpiry); err != nil || !persistedExpiry.Equal(updatedExpiry) {
		t.Fatalf("stale receipt expiry changed: got=%v want=%v err=%v", persistedExpiry, updatedExpiry, err)
	}
}
