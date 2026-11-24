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
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func configGCTransactionCleanup(t *testing.T, tx pgx.Tx) {
	t.Helper()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tx.Rollback(ctx); err != nil && err != pgx.ErrTxClosed {
			t.Errorf("rollback configuration GC transaction: %v", err)
		}
	})
}

func TestWebhookConfigGCKeyExpiryWithoutOwner(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	owner, ep, key, op := webhookStoredFixture(t)
	old := key
	old.ID = uuid.NewString()
	old.Slot = "overlap"
	start := time.Now().UTC().Add(-48 * time.Hour)
	expired := time.Now().UTC().Add(-24 * time.Hour)
	old.OverlapStartedAt = &start
	old.OverlapUntil = &expired
	completion, err := s.WriteWebhook(ctx, owner, op.ID, func(sc store.WebhookWriteScope) error {
		w := sc.WebhookWriter()
		if err := w.PutEndpoint(ctx, ep); err != nil {
			return err
		}
		if err := w.PutSigningKey(ctx, key); err != nil {
			return err
		}
		return w.PutSigningKey(ctx, old)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("fixture %v %v", completion, err)
	}
	want := store.WebhookConfigGCCandidate{Order: 1, Kind: "key", ID: old.ID, EndpointID: ep.ID, Owner: webhook.Owner{Kind: "personal", ID: owner.ID}}
	scan, err := s.ScanWebhookConfigGC(ctx, nil, 1)
	if err != nil || scan.Barrier == "" || !reflect.DeepEqual(scan.Candidates, []store.WebhookConfigGCCandidate{want}) {
		t.Fatalf("overlap key scan: %+v %v", scan, err)
	}
	removed := false
	completion, err = s.WriteWebhookConfigGC(ctx, scan.Candidates[0], func(sc store.WebhookConfigGCScope) error {
		facts, err := sc.LockConfigCandidate(ctx, scan.Candidates[0])
		if err != nil {
			return err
		}
		if !facts.Present || !facts.Retired || facts.Referenced || !facts.Expiry.Equal(expired.Truncate(time.Microsecond)) || !facts.ObservedAt.After(facts.Expiry) {
			return fmt.Errorf("locked expired key facts: %+v", facts)
		}
		removed, err = sc.DeleteConfigCandidate(ctx, scan.Candidates[0])
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted || !removed {
		t.Fatalf("expired key deletion: removed=%v completion=%+v err=%v", removed, completion, err)
	}
	var currents, overlaps int
	if err = s.Pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE slot='current'),count(*) FILTER (WHERE slot='overlap') FROM webhook_signing_keys WHERE endpoint_id=$1`, ep.ID).Scan(&currents, &overlaps); err != nil || currents != 1 || overlaps != 0 {
		t.Fatalf("current=%d overlap=%d err=%v", currents, overlaps, err)
	}
	var users int
	if err = s.Pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE id=$1`, owner.ID).Scan(&users); err != nil || users != 0 {
		t.Fatalf("owner fixture count=%d err=%v", users, err)
	}
}

func TestWebhookConfigGCWaitsForUnrelatedTransaction(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	owner, ep, _, op := webhookStoredFixture(t)
	now := time.Now().UTC()
	sub := webhook.Subscription{ID: uuid.NewString(), EndpointID: ep.ID, ProjectID: uuid.NewString(), Owner: owner, AuthorizationState: "active", AuthorizationEpoch: 1, CreatedAt: now, UpdatedAt: now}
	binding := webhook.Binding{ID: uuid.NewString(), SubscriptionID: sub.ID, EventType: "task.created", CreatedAt: now, DeletedAt: &now}
	_, err := s.WriteWebhook(ctx, owner, op.ID, func(sc store.WebhookWriteScope) error {
		w := sc.WebhookWriter()
		if err := w.PutEndpoint(ctx, ep); err != nil {
			return err
		}
		if err := w.PutSubscription(ctx, sub); err != nil {
			return err
		}
		return w.PutBinding(ctx, binding)
	})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	configGCTransactionCleanup(t, tx)
	if _, err = tx.Exec(ctx, `SELECT pg_current_xact_id()`); err != nil {
		t.Fatal(err)
	}
	want := store.WebhookConfigGCCandidate{Order: 2, Kind: "binding", ID: binding.ID, EndpointID: ep.ID, ProjectID: sub.ProjectID, Owner: webhook.Owner{Kind: "personal", ID: owner.ID}}
	scan, err := s.ScanWebhookConfigGC(ctx, nil, 1)
	if err != nil || scan.Barrier == "" || !reflect.DeepEqual(scan.Candidates, []store.WebhookConfigGCCandidate{want}) {
		t.Fatalf("retired binding scan: %+v %v", scan, err)
	}
	passed, err := s.WebhookConfigGCBarrierPassed(ctx, scan.Barrier)
	if err != nil || passed {
		t.Fatalf("barrier passed while the earlier transaction remained active: %v %v", passed, err)
	}
	var present bool
	if err = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_bindings WHERE id=$1)`, binding.ID).Scan(&present); err != nil || !present {
		t.Fatalf("retired binding: %v %v", present, err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	// Other packages may retain older XIDs; this write proves the locked
	// recheck. The prepared-transaction stress test owns global convergence.
	removed := false
	completion, err := s.WriteWebhookConfigGC(ctx, scan.Candidates[0], func(sc store.WebhookConfigGCScope) error {
		facts, err := sc.LockConfigCandidate(ctx, scan.Candidates[0])
		if err != nil {
			return err
		}
		if !facts.Present || !facts.Retired || facts.Referenced {
			return fmt.Errorf("locked retired binding facts: %+v", facts)
		}
		removed, err = sc.DeleteConfigCandidate(ctx, scan.Candidates[0])
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted || !removed {
		t.Fatalf("retired binding deletion: removed=%v completion=%+v err=%v", removed, completion, err)
	}
	if err = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_bindings WHERE id=$1)`, binding.ID).Scan(&present); err != nil || present {
		t.Fatalf("retired binding was not reclaimed: present=%v err=%v", present, err)
	}
}

func TestWebhookConfigGCBusyCandidateDoesNotBlockBatch(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, lockKind := range []string{"endpoint", "project"} {
		t.Run(lockKind, func(t *testing.T) {
			s := isolatedStore(t)
			ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
			defer cancel()
			team := uuid.NewString()
			if _, err := s.Pool.Exec(ctx, `INSERT INTO teams(id,name) VALUES($1,'gc')`, team); err != nil {
				t.Fatal(err)
			}
			var candidates []store.WebhookConfigGCCandidate
			for i := 1; i <= 2; i++ {
				owner, ep, _, op := webhookStoredFixture(t)
				project := uuid.NewString()
				if _, err := s.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'gc','gc')`, project); err != nil {
					t.Fatal(err)
				}
				if _, err := s.Pool.Exec(ctx, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, project, team); err != nil {
					t.Fatal(err)
				}
				now := time.Now().UTC()
				sub := webhook.Subscription{ID: uuid.NewString(), EndpointID: ep.ID, ProjectID: project, Owner: owner, AuthorizationState: "active", AuthorizationEpoch: 1, CreatedAt: now, UpdatedAt: now}
				binding := webhook.Binding{ID: fmt.Sprintf("00000000-0000-4000-8000-%012d", i), SubscriptionID: sub.ID, EventType: "task.created", CreatedAt: now, DeletedAt: &now}
				_, err := s.WriteWebhook(ctx, owner, op.ID, func(sc store.WebhookWriteScope) error {
					w := sc.WebhookWriter()
					if err := w.PutEndpoint(ctx, ep); err != nil {
						return err
					}
					if err := w.PutSubscription(ctx, sub); err != nil {
						return err
					}
					return w.PutBinding(ctx, binding)
				})
				if err != nil {
					t.Fatal(err)
				}
				candidates = append(candidates, store.WebhookConfigGCCandidate{Order: 2, Kind: "binding", ID: binding.ID, EndpointID: ep.ID, ProjectID: project, Owner: webhook.Owner{Kind: "personal", ID: owner.ID}})
			}
			scan, err := s.ScanWebhookConfigGC(ctx, nil, 2)
			if err != nil || scan.Barrier == "" || !reflect.DeepEqual(scan.Candidates, candidates) {
				t.Fatalf("ordered binding scan: %+v %v", scan, err)
			}
			lock, err := s.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			configGCTransactionCleanup(t, lock)
			if lockKind == "project" {
				_, err = lock.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, candidates[0].ProjectID)
			} else {
				_, err = lock.Exec(ctx, `SELECT id FROM webhook_endpoints WHERE id=$1 FOR UPDATE`, candidates[0].EndpointID)
			}
			if err != nil {
				t.Fatal(err)
			}
			called := false
			completion, err := s.WriteWebhookConfigGC(ctx, scan.Candidates[0], func(sc store.WebhookConfigGCScope) error {
				called = true
				_, err := sc.LockConfigCandidate(ctx, scan.Candidates[0])
				return err
			})
			var cause *pgconn.PgError
			if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &cause) || cause.Code != "55P03" || called != (lockKind == "endpoint") {
				t.Fatalf("busy %s completion=%+v callback=%v err=%v", lockKind, completion, called, err)
			}
			removed := false
			completion, err = s.WriteWebhookConfigGC(ctx, scan.Candidates[1], func(sc store.WebhookConfigGCScope) error {
				facts, err := sc.LockConfigCandidate(ctx, scan.Candidates[1])
				if err != nil {
					return err
				}
				if !facts.Present || !facts.Retired || facts.Referenced {
					return fmt.Errorf("locked second binding facts: %+v", facts)
				}
				removed, err = sc.DeleteConfigCandidate(ctx, scan.Candidates[1])
				return err
			})
			if err != nil || completion.Outcome != store.TransactionCommitted || !removed {
				t.Fatalf("second binding deletion: removed=%v completion=%+v err=%v", removed, completion, err)
			}
			var first, second bool
			if err = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM webhook_bindings WHERE id='00000000-0000-4000-8000-000000000001'),EXISTS(SELECT 1 FROM webhook_bindings WHERE id='00000000-0000-4000-8000-000000000002')`).Scan(&first, &second); err != nil || !first || second {
				t.Fatalf("first=%v second=%v err=%v", first, second, err)
			}
		})
	}
}

func TestWebhookReceiptGCFenceAndExpiry(t *testing.T) {
	parallelRootDatabaseTest(t)
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
	completion, err = s.WriteWebhookReceiptGC(ctx, first, func(sc store.WebhookReceiptGCScope) error {
		_, _, present, err := sc.ReceiptExpiry(ctx, first)
		if err != nil || present {
			return fmt.Errorf("missing receipt expiry: present=%v err=%v", present, err)
		}
		deleted, err := sc.DeleteReceipt(ctx, first)
		if err != nil || deleted {
			return fmt.Errorf("missing receipt deletion: deleted=%v err=%v", deleted, err)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("missing receipt recheck: %+v %v", completion, err)
	}
	invalid := store.WebhookReceiptIdentity{Owner: owner, OperationID: "invalid"}
	for _, tc := range []struct {
		name string
		fn   func(store.WebhookReceiptGCScope) error
	}{
		{"invalid lock", func(sc store.WebhookReceiptGCScope) error { _, _, _, err := sc.ReceiptExpiry(ctx, invalid); return err }},
		{"invalid delete", func(sc store.WebhookReceiptGCScope) error { _, err := sc.DeleteReceipt(ctx, invalid); return err }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			completion, err := s.WriteWebhookReceiptGC(ctx, first, tc.fn)
			if err == nil || completion.Outcome != store.TransactionNotCommitted {
				t.Fatalf("invalid receipt operation: %+v %v", completion, err)
			}
		})
	}
	var count int
	var remaining string
	if err = s.Pool.QueryRow(ctx, `SELECT count(*),coalesce(min(operation_id::text),'') FROM webhook_operations`).Scan(&count, &remaining); err != nil || count != 1 || remaining != recent.ID {
		t.Fatalf("remaining count=%d identity=%s err=%v", count, remaining, err)
	}
}

func TestWebhookReceiptGCRechecksAfterFence(t *testing.T) {
	parallelRootDatabaseTest(t)
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

func TestWebhookMaintenanceObserveAndScanFailures(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx := context.Background()
	owner, endpoint, key, receipt := webhookStoredFixture(t)
	now := time.Now().UTC()
	overlap := key
	overlap.ID = uuid.NewString()
	overlap.Slot = "overlap"
	start, until := now.Add(-48*time.Hour), now.Add(-24*time.Hour)
	overlap.OverlapStartedAt, overlap.OverlapUntil = &start, &until
	sub := webhook.Subscription{ID: uuid.NewString(), EndpointID: endpoint.ID, ProjectID: uuid.NewString(), Owner: owner, AuthorizationState: "active", AuthorizationEpoch: 1, CreatedAt: now, UpdatedAt: now}
	binding := webhook.Binding{ID: uuid.NewString(), SubscriptionID: sub.ID, EventType: "task.created", CreatedAt: now, DeletedAt: &now}
	receipt.RecordedAt = now.Add(-31 * 24 * time.Hour)
	receipt.ExpiresAt = now.Add(-24 * time.Hour)
	_, err := s.WriteWebhook(ctx, owner, receipt.ID, func(sc store.WebhookWriteScope) error {
		w := sc.WebhookWriter()
		if err := w.PutEndpoint(ctx, endpoint); err != nil {
			return err
		}
		if err := w.PutSigningKey(ctx, key); err != nil {
			return err
		}
		if err := w.PutSigningKey(ctx, overlap); err != nil {
			return err
		}
		if err := w.PutSubscription(ctx, sub); err != nil {
			return err
		}
		if err := w.PutBinding(ctx, binding); err != nil {
			return err
		}
		return w.PutOperation(ctx, receipt)
	})
	if err != nil {
		t.Fatal(err)
	}
	id := store.WebhookReceiptIdentity{Owner: owner, OperationID: receipt.ID}
	if _, present, err := s.ObserveWebhookReceipt(ctx, id); err != nil || !present {
		t.Fatalf("receipt read: %v %v", present, err)
	}
	missing := id
	missing.OperationID = uuid.NewString()
	if _, present, err := s.ObserveWebhookReceipt(ctx, missing); err != nil || present {
		t.Fatalf("missing receipt: %v %v", present, err)
	}
	invalid := id
	invalid.OperationID = "not-a-uuid"
	if _, _, err := s.ObserveWebhookReceipt(ctx, invalid); err == nil {
		t.Fatal("invalid receipt read succeeded")
	}
	for _, limit := range []int{0, 501} {
		if _, err := s.ExpiredWebhookReceipts(ctx, nil, limit); err == nil {
			t.Fatalf("accepted limit %d", limit)
		}
	}
	if ids, err := s.ExpiredWebhookReceipts(ctx, nil, 1); err != nil || len(ids) != 1 {
		t.Fatalf("receipt scan %v %v", ids, err)
	}
	if ids, err := s.ExpiredWebhookReceipts(ctx, &id, 1); err != nil || len(ids) != 0 {
		t.Fatalf("receipt cursor %v %v", ids, err)
	}
	if _, err := s.ExpiredWebhookReceipts(ctx, &invalid, 1); err == nil {
		t.Fatal("invalid receipt cursor succeeded")
	}

	for _, c := range []store.WebhookConfigGCCandidate{
		{Kind: "key", ID: key.ID}, {Kind: "binding", ID: binding.ID}, {Kind: "subscription", ID: sub.ID},
		{Kind: "wait", EndpointID: endpoint.ID, Revision: 1}, {Kind: "endpoint", ID: endpoint.ID},
	} {
		present, err := s.ObserveWebhookConfigGC(ctx, c)
		if err != nil || !present {
			t.Fatalf("%s present: %v %v", c.Kind, present, err)
		}
		c.ID = uuid.NewString()
		c.EndpointID = uuid.NewString()
		present, err = s.ObserveWebhookConfigGC(ctx, c)
		if err != nil || present {
			t.Fatalf("%s absent: %v %v", c.Kind, present, err)
		}
	}
	if _, err := s.ObserveWebhookConfigGC(ctx, store.WebhookConfigGCCandidate{Kind: "invalid"}); err == nil {
		t.Fatal("accepted unknown config identity")
	}
	if _, err := s.ObserveWebhookConfigGC(ctx, store.WebhookConfigGCCandidate{Kind: "endpoint", ID: "invalid"}); err == nil {
		t.Fatal("accepted invalid config UUID")
	}
	for _, kind := range []string{"delivery", "event", "other"} {
		if err := s.ObserveWebhookRetention(ctx, kind, uuid.NewString()); err != nil {
			t.Fatalf("%s observation: %v", kind, err)
		}
	}
	if err := s.ObserveWebhookRetention(ctx, "delivery", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.ObserveWebhookRetention(ctx, "delivery", "not-a-uuid"); err == nil {
		t.Fatal("invalid delivery observation succeeded")
	}

	for _, limit := range []int{0, 501} {
		if _, err := s.ScanWebhookConfigGC(ctx, nil, limit); err == nil {
			t.Fatalf("accepted config limit %d", limit)
		}
	}
	scan, err := s.ScanWebhookConfigGC(ctx, nil, 1)
	if err != nil || len(scan.Candidates) != 1 || scan.Barrier == "" {
		t.Fatalf("config scan: %+v %v", scan, err)
	}
	after := scan.Candidates[0]
	if _, err = s.ScanWebhookConfigGC(ctx, &after, 1); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Pool.Exec(ctx, `ALTER TABLE webhook_signing_keys RENAME TO inaccessible_keys`); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ScanWebhookConfigGC(ctx, nil, 1); err == nil {
		t.Fatal("missing configuration table was ignored")
	}
}
