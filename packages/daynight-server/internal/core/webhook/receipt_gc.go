package webhook

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ReceiptGCUnknownError preserves the identity of an uncertain write. The
// caller must observe that identity before deciding whether to continue.
type ReceiptGCUnknownError struct {
	Identity store.WebhookReceiptIdentity
	Cause    error
}

func (e *ReceiptGCUnknownError) Error() string { return "webhook receipt collection outcome unknown" }
func (e *ReceiptGCUnknownError) Unwrap() error { return e.Cause }

// ReceiptCollector keeps a bounded scan position and an uncertain identity
// across activations. It must not be used concurrently.
type ReceiptCollector struct {
	cursor  *store.WebhookReceiptIdentity
	unknown *store.WebhookReceiptIdentity
}

func (c *ReceiptCollector) Reconcile(ctx context.Context, db store.WebhookReceiptGC) error {
	if c.unknown == nil {
		return nil
	}
	if _, _, err := db.ObserveWebhookReceipt(ctx, *c.unknown); err != nil {
		return &ReceiptGCUnknownError{Identity: *c.unknown, Cause: err}
	}
	c.unknown = nil
	return nil
}

// Pass counts only confirmed committed deletions.
func (c *ReceiptCollector) Pass(ctx context.Context, db store.WebhookReceiptGC, limit int) (count int, completion store.Completion, err error) {
	completion.Outcome = store.TransactionNotCommitted
	if limit < 1 || limit > 500 {
		return 0, completion, fmt.Errorf("invalid webhook receipt collection limit")
	}
	if err = c.Reconcile(ctx, db); err != nil {
		return 0, completion, err
	}
	candidates, err := db.ExpiredWebhookReceipts(ctx, c.cursor, limit)
	if err != nil {
		return 0, completion, err
	}
	if len(candidates) == 0 {
		c.cursor = nil
		return 0, completion, nil
	}
	for _, id := range candidates {
		removed := false
		completion, err = db.WriteWebhookReceiptGC(ctx, id, func(scope store.WebhookReceiptGCScope) error {
			expires, now, present, err := scope.ReceiptExpiry(ctx, id)
			if err != nil || !present || now.Before(expires) {
				return err
			}
			removed, err = scope.DeleteReceipt(ctx, id)
			return err
		})
		if completion.Outcome == store.TransactionUnknown {
			c.cursor, c.unknown = &id, &id
			return count, completion, &ReceiptGCUnknownError{Identity: id, Cause: err}
		}
		if err != nil {
			if completion.Outcome == store.TransactionNotCommitted && errors.Is(err, store.ErrWebhookReceiptFenceBusy) {
				c.cursor = &id
				continue
			}
			return count, completion, err
		}
		if completion.Outcome != store.TransactionCommitted {
			return count, completion, fmt.Errorf("webhook receipt collection did not commit")
		}
		c.cursor = &id
		if removed {
			count++
		}
	}
	if len(candidates) < limit {
		c.cursor = nil
	}
	return count, completion, nil
}
