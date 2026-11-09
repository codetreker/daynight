package webhook

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ConfigCollector retains its snapshot barrier across bounded activations. It
// must not be used concurrently. A new process constructs a fresh collector.
type ConfigCollector struct {
	scan       store.WebhookConfigGCScan
	cursor     *store.WebhookConfigGCCandidate
	pageEnd    *store.WebhookConfigGCCandidate
	pageLast   bool
	pageLoaded bool
	unknown    *store.WebhookConfigGCCandidate
}

// ConfigGCUnknownError requires an observation before collection resumes.
type ConfigGCUnknownError struct {
	Identity store.WebhookConfigGCCandidate
	Cause    error
}

func (e *ConfigGCUnknownError) Error() string {
	return "webhook configuration collection outcome unknown"
}
func (e *ConfigGCUnknownError) Unwrap() error { return e.Cause }

// Reconcile reads an uncertain candidate before any further maintenance write.
func (c *ConfigCollector) Reconcile(ctx context.Context, db store.WebhookConfigGC) error {
	if c.unknown == nil {
		return nil
	}
	if _, err := db.ObserveWebhookConfigGC(ctx, *c.unknown); err != nil {
		return &ConfigGCUnknownError{Identity: *c.unknown, Cause: err}
	}
	c.unknown = nil
	return nil
}

// Pass returns confirmed deleted rows. Unknown outcomes are observed before any
// later mutation and are never counted as confirmed deletions.
func (c *ConfigCollector) Pass(ctx context.Context, db store.WebhookConfigGC, limit int) (int, error) {
	if limit < 1 || limit > 500 {
		return 0, fmt.Errorf("invalid webhook configuration collection limit")
	}
	if err := c.Reconcile(ctx, db); err != nil {
		return 0, err
	}
	if len(c.scan.Candidates) == 0 {
		if c.pageLoaded {
			if c.pageLast {
				c.cursor = nil
			} else {
				c.cursor = c.pageEnd
			}
			c.pageLoaded = false
		}
		scan, err := db.ScanWebhookConfigGC(ctx, c.cursor, limit)
		if err != nil {
			return 0, err
		}
		c.scan = scan
		if len(scan.Candidates) == 0 {
			c.cursor = nil
			return 0, nil
		}
		end := scan.Candidates[len(scan.Candidates)-1]
		c.pageEnd, c.pageLast, c.pageLoaded = &end, len(scan.Candidates) < limit, true
	}
	passed, err := db.WebhookConfigGCBarrierPassed(ctx, c.scan.Barrier)
	if err != nil || !passed {
		return 0, err
	}
	count := 0
	for len(c.scan.Candidates) > 0 && count < limit {
		candidate := c.scan.Candidates[0]
		removed := false
		completion, err := db.WriteWebhookConfigGC(ctx, candidate, func(scope store.WebhookConfigGCScope) error {
			facts, err := scope.LockConfigCandidate(ctx, candidate)
			if err != nil {
				return err
			}
			if !facts.Present || !facts.Retired || facts.Referenced || (!facts.Expiry.IsZero() && facts.ObservedAt.Before(facts.Expiry)) {
				return nil
			}
			removed, err = scope.DeleteConfigCandidate(ctx, candidate)
			return err
		})
		if completion.Outcome == store.TransactionUnknown {
			c.unknown = &candidate
			c.scan.Candidates = c.scan.Candidates[1:]
			return count, &ConfigGCUnknownError{Identity: candidate, Cause: err}
		}
		if err != nil {
			// A proven rollback after a bounded lock wait must not starve the
			// other candidates retained from the same safe snapshot.
			_, state := store.DatabaseErrorFacts(err)
			if completion.Outcome == store.TransactionNotCommitted && (state == "55P03" || errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded)) {
				c.scan.Candidates = c.scan.Candidates[1:]
				if state == "55P03" && ctx.Err() == nil {
					continue
				}
			}
			return count, err
		}
		if completion.Outcome != store.TransactionCommitted {
			return count, fmt.Errorf("webhook configuration collection did not commit")
		}
		c.scan.Candidates = c.scan.Candidates[1:]
		if removed {
			count++
		}
	}
	return count, nil
}
