package webhook_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

type retentionUnknownDB struct {
	*postgres.Store
	inject, observed bool
}
type retentionUnknownScope struct {
	store.WebhookRetentionScope
	changed bool
}

func (s *retentionUnknownScope) RemoveExpiredPayload(ctx context.Context, id string, now time.Time) (int, error) {
	n, e := s.WebhookRetentionScope.RemoveExpiredPayload(ctx, id, now)
	s.changed = n > 0 && e == nil
	return n, e
}
func (db *retentionUnknownDB) WriteWebhookRetention(ctx context.Context, fn func(store.WebhookRetentionScope) error) (store.Completion, error) {
	if db.inject && !db.observed {
		return store.Completion{Outcome: store.TransactionNotCommitted}, errors.New("write before observation")
	}
	var changed bool
	c, e := db.Store.WriteWebhookRetention(ctx, func(sc store.WebhookRetentionScope) error {
		s := &retentionUnknownScope{WebhookRetentionScope: sc}
		err := fn(s)
		changed = s.changed
		return err
	})
	if changed && e == nil && !db.inject {
		db.inject = true
		return store.Completion{Outcome: store.TransactionUnknown}, errors.New("lost commit reply")
	}
	return c, e
}
func (db *retentionUnknownDB) ObserveWebhookRetention(ctx context.Context, kind, id string) error {
	err := db.Store.ObserveWebhookRetention(ctx, kind, id)
	if err == nil {
		db.observed = true
	}
	return err
}

func TestRetentionUnknownCommitObservedBeforeContinuation(t *testing.T) {
	f, id := retentionCapture(t)
	ageRetention(t, f, id, 8*24*time.Hour)
	db := &retentionUnknownDB{Store: f.db}
	gc := webhook.NewRetention(db)
	if _, _, err := gc.Pass(f.ctx); err == nil || !db.inject || db.observed {
		t.Fatalf("missing unknown result: %v", err)
	}
	var removed bool
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT body IS NULL FROM webhook_deliveries WHERE id=$1`, id).Scan(&removed); err != nil || !removed {
		t.Fatalf("committed removal unavailable: %v", err)
	}
	if _, _, err := gc.Pass(f.ctx); err != nil || !db.observed {
		t.Fatalf("reconciliation failed: %v", err)
	}
}
