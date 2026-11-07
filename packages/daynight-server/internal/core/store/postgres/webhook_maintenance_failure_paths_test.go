package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

func TestWebhookMaintenanceObserveAndScanFailures(t *testing.T) {
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

func TestWebhookReceiptGCRowFailureAndRecheck(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	owner, _, _, receipt := webhookStoredFixture(t)
	receipt.RecordedAt = time.Now().UTC().Add(-31 * 24 * time.Hour)
	receipt.ExpiresAt = receipt.RecordedAt.Add(30 * 24 * time.Hour)
	_, err := s.WriteWebhook(ctx, owner, receipt.ID, func(sc store.WebhookWriteScope) error { return sc.WebhookWriter().PutOperation(ctx, receipt) })
	if err != nil {
		t.Fatal(err)
	}
	id := store.WebhookReceiptIdentity{Owner: owner, OperationID: receipt.ID}
	missing := id
	missing.OperationID = uuid.NewString()
	_, err = s.WriteWebhookReceiptGC(ctx, missing, func(sc store.WebhookReceiptGCScope) error {
		_, _, present, err := sc.ReceiptExpiry(ctx, missing)
		if err != nil || present {
			t.Fatalf("missing row: %v %v", present, err)
		}
		deleted, err := sc.DeleteReceipt(ctx, missing)
		if err != nil || deleted {
			t.Fatalf("missing delete: %v %v", deleted, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	invalid := id
	invalid.OperationID = "invalid"
	for _, tc := range []struct {
		name string
		fn   func(store.WebhookReceiptGCScope) error
	}{
		{"lock", func(sc store.WebhookReceiptGCScope) error { _, _, _, err := sc.ReceiptExpiry(ctx, invalid); return err }},
		{"delete", func(sc store.WebhookReceiptGCScope) error { _, err := sc.DeleteReceipt(ctx, invalid); return err }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := s.WriteWebhookReceiptGC(ctx, id, tc.fn)
			if err == nil {
				t.Fatal("invalid UUID did not fail")
			}
		})
	}
	_, err = s.WriteWebhookReceiptGC(ctx, id, func(sc store.WebhookReceiptGCScope) error {
		expiry, now, present, err := sc.ReceiptExpiry(ctx, id)
		if err != nil || !present || now.Before(expiry) {
			t.Fatalf("expired receipt: %v %v", present, err)
		}
		deleted, err := sc.DeleteReceipt(ctx, id)
		if err != nil || !deleted {
			t.Fatalf("delete receipt: %v %v", deleted, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
