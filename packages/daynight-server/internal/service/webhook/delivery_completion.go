package webhook

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
)

type observation struct {
	outcome    string
	status     *int16
	duration   *int64
	errorCode  *string
	retry      *time.Time
	diagnostic *string
}

func observe(elapsed time.Duration, finished time.Time, response httpoutbound.Response, failure error) observation {
	duration := elapsed.Milliseconds()
	if duration < 0 {
		duration = 0
	}
	o := observation{duration: &duration}
	if failure != nil {
		code := "transport_error"
		o.outcome, o.errorCode = "unknown", &code
		return o
	}
	status := int16(response.Status)
	o.status = &status
	result := protocol.Classify(response.Status, response.RetryAfter, finished)
	o.outcome, o.retry = result.Category, result.RetryNotBefore
	if result.Reason != "" {
		o.errorCode = &result.Reason
	}
	if result.RetryAfterInvalid {
		code := "invalid_retry_after"
		o.diagnostic = &code
	}
	return o
}
func (r *Runner) finalize(ctx context.Context, own store.WebhookAttempt, dispatched time.Time, elapsed time.Duration, response httpoutbound.Response, failure error) error {
	for {
		done, err := r.finalizeOnce(ctx, own, dispatched, elapsed, response, failure)
		if err != nil || done {
			return err
		}
		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
func (r *Runner) finalizeOnce(ctx context.Context, own store.WebhookAttempt, dispatched time.Time, elapsed time.Duration, response httpoutbound.Response, failure error) (bool, error) {
	stale := false
	completion, err := r.transaction(ctx, func(ctx context.Context, sc store.WebhookDeliveryScope) error {
		d, locked, err := sc.TryLockDelivery(ctx, own.DeliveryID)
		if err != nil {
			return err
		}
		if !locked {
			stale = true
			return nil
		}
		attempts, err := sc.LockAttempts(ctx, d.ID)
		if err != nil {
			return err
		}
		var a *store.WebhookAttempt
		for i := range attempts {
			if attempts[i].ID == own.ID {
				a = &attempts[i]
				break
			}
		}
		if a == nil {
			return fmt.Errorf("webhook admitted attempt missing")
		}
		if d.State != "leased" || d.LeaseToken == nil || *d.LeaseToken != own.LeaseToken || d.Generation != own.Generation || d.CurrentAttemptID == nil || *d.CurrentAttemptID != own.ID {
			stale = true
			return nil
		}
		if a.FinishedAt != nil || a.RetentionClosedAt != nil {
			return fmt.Errorf("webhook attempt already closed")
		}
		wait, err := sc.LockWait(ctx, d.EndpointID, d.DestinationRevision)
		obsoleteWait := false
		if errors.Is(err, model.ErrNotFound) {
			current, readErr := sc.CurrentDestination(ctx, d.EndpointID, d.DestinationRevision)
			if readErr != nil {
				return readErr
			}
			if current {
				return fmt.Errorf("current webhook endpoint wait missing")
			}
			obsoleteWait, err = true, nil
		}
		if err != nil {
			return err
		}
		if !obsoleteWait && wait.Owner != d.Owner {
			return fmt.Errorf("webhook wait owner mismatch")
		}
		finished, err := sc.ObservedAt(ctx)
		if err != nil {
			return err
		}
		o := observe(elapsed, finished, response, failure)
		a.DispatchedAt, a.FinishedAt, a.Outcome, a.HTTPStatus, a.DurationMS, a.ErrorCode = &dispatched, &finished, &o.outcome, o.status, o.duration, o.errorCode
		a.RetryAfterNotBefore, a.RetryAfterDiagnosticCode = o.retry, o.diagnostic
		if err := sc.UpdateAttempt(ctx, *a); err != nil {
			return err
		}
		if o.retry != nil && !obsoleteWait {
			if err := sc.RaiseWait(ctx, d.EndpointID, d.DestinationRevision, *o.retry, finished); err != nil {
				return err
			}
			if wait.NotBefore == nil || o.retry.After(*wait.NotBefore) {
				wait.NotBefore = o.retry
			}
		}
		if o.outcome == "acknowledged" {
			return terminalDelivery(ctx, sc, &d, finished, "delivered", "")
		}
		if obsoleteWait {
			return terminalDelivery(ctx, sc, &d, finished, "suppressed", "destination_changed")
		}
		if valueIs(o.errorCode, "receiver_retired") {
			return terminalDelivery(ctx, sc, &d, finished, "failed", "receiver_retired")
		}
		return scheduleFailure(ctx, sc, &d, finished, wait.NotBefore)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		return false, transactionError("finalize", completion, err)
	}
	if !stale {
		return true, nil
	}
	ready := true
	completion, err = r.transaction(ctx, func(ctx context.Context, sc store.WebhookDeliveryScope) error {
		a, err := sc.LockOwnAttempt(ctx, own.ID)
		if errors.Is(err, model.ErrNotFound) {
			// Retention may have deleted the history; never recreate it.
			return nil
		}
		if err != nil {
			return err
		}
		if a.DeliveryID != own.DeliveryID || a.LeaseToken != own.LeaseToken || a.Generation != own.Generation {
			return fmt.Errorf("webhook late identity mismatch")
		}
		if a.RetentionClosedAt != nil || a.LateObservedAt != nil {
			return nil
		}
		if a.RecoveredUnknownAt == nil {
			ready = false
			return nil
		}
		finished, err := sc.ObservedAt(ctx)
		if err != nil {
			return err
		}
		o := observe(elapsed, finished, response, failure)
		a.LateObservedAt, a.LateOutcome, a.LateHTTPStatus, a.LateDurationMS, a.LateErrorCode = &finished, &o.outcome, o.status, o.duration, o.errorCode
		a.LateRetryAfterNotBefore, a.LateRetryAfterDiagnosticCode = o.retry, o.diagnostic
		return sc.UpdateAttempt(ctx, a)
	})
	return ready, transactionError("late observation", completion, err)
}
func scheduleFailure(ctx context.Context, sc store.WebhookDeliveryScope, d *store.WebhookDelivery, now time.Time, wait *time.Time) error {
	next, cursor, ok, err := core.NextAutomatic(d.AutomaticScheduleAt, d.AutomaticPlanCursor, d.AutomaticAttemptCount, d.AutomaticOpen, now, d.AutomaticExpiresAt, wait)
	if err != nil {
		return err
	}
	d.AutomaticPlanCursor = cursor
	if !ok {
		return terminalDelivery(ctx, sc, d, now, "failed", "automatic_exhausted")
	}
	ticket, err := sc.NextQueueOrder(ctx)
	if err != nil {
		return err
	}
	clearLease(d)
	d.State, d.Trigger, d.ManualOperationID = "pending", "automatic", nil
	d.NextAttemptAt, d.ExpiresAt, d.QueueOrder = &next, d.AutomaticExpiresAt, ticket
	touchDelivery(d, now)
	return sc.UpdateDelivery(ctx, *d)
}

// Expired leases with admitted attempts become unknown; those attempts are
// never reused. Recovery of a mere claim does not invent an attempt.
func (r *Runner) recoverExpired(ctx context.Context) error {
	completion, err := r.transaction(ctx, func(ctx context.Context, sc store.WebhookDeliveryScope) error {
		now, err := sc.ObservedAt(ctx)
		if err != nil {
			return err
		}
		// One Delivery per transaction avoids taking another Delivery after a
		// shared Wait leaf, even when several instances recover concurrently.
		expired, err := sc.LockExpired(ctx, 1, now)
		if err != nil {
			return err
		}
		for _, d := range expired {
			attempts, err := sc.LockAttempts(ctx, d.ID)
			if err != nil {
				return err
			}
			now, err = sc.ObservedAt(ctx)
			if err != nil {
				return err
			}
			if d.LeaseUntil == nil || now.Before(*d.LeaseUntil) {
				continue
			}
			var admitted *store.WebhookAttempt
			for i := range attempts {
				if d.CurrentAttemptID != nil && attempts[i].ID == *d.CurrentAttemptID {
					admitted = &attempts[i]
					break
				}
			}
			if d.CurrentAttemptID != nil && admitted == nil {
				return fmt.Errorf("webhook admitted attempt missing")
			}
			if admitted != nil && admitted.FinishedAt == nil {
				unknown := "unknown"
				admitted.FinishedAt, admitted.Outcome, admitted.RecoveredUnknownAt = &now, &unknown, &now
				if err := sc.UpdateAttempt(ctx, *admitted); err != nil {
					return err
				}
			}
			d.Generation++
			if !now.Before(d.ExpiresAt) {
				if err := terminalDelivery(ctx, sc, &d, now, "failed", "expired"); err != nil {
					return err
				}
				continue
			}
			if admitted == nil {
				clearLease(&d)
				d.State = "pending"
				touchDelivery(&d, now)
				if err := sc.UpdateDelivery(ctx, d); err != nil {
					return err
				}
				continue
			}
			wait, err := sc.LockWait(ctx, d.EndpointID, d.DestinationRevision)
			if errors.Is(err, model.ErrNotFound) {
				current, readErr := sc.CurrentDestination(ctx, d.EndpointID, d.DestinationRevision)
				if readErr != nil {
					return readErr
				}
				if current {
					return fmt.Errorf("current webhook endpoint wait missing")
				}
				if err := terminalDelivery(ctx, sc, &d, now, "suppressed", "destination_changed"); err != nil {
					return err
				}
				continue
			}
			if err != nil {
				return err
			}
			if wait.Owner != d.Owner {
				return fmt.Errorf("webhook wait owner mismatch")
			}
			now, err = sc.ObservedAt(ctx)
			if err != nil {
				return err
			}
			if err := recoverSchedule(ctx, sc, &d, now, wait.NotBefore); err != nil {
				return err
			}
		}
		if len(expired) != 0 {
			return nil
		}
		due, err := sc.LockDueExpiry(ctx, 1, now)
		if err != nil {
			return err
		}
		for _, d := range due {
			if err := terminalDelivery(ctx, sc, &d, now, "failed", "expired"); err != nil {
				return err
			}
		}
		return nil
	})
	return transactionError("recovery", completion, err)
}
func recoverSchedule(ctx context.Context, sc store.WebhookDeliveryScope, d *store.WebhookDelivery, now time.Time, wait *time.Time) error {
	if d.AutomaticOpen && d.AutomaticAttemptCount < 10 && now.Before(d.AutomaticExpiresAt) {
		_, due, err := core.AutomaticSlot(d.AutomaticScheduleAt, d.AutomaticPlanCursor, now, d.AutomaticExpiresAt)
		if err != nil {
			return err
		}
		if due {
			next := now.Add(5 * time.Second)
			if wait != nil && wait.After(next) {
				next = *wait
			}
			if next.Before(d.AutomaticExpiresAt) {
				ticket, err := sc.NextQueueOrder(ctx)
				if err != nil {
					return err
				}
				clearLease(d)
				d.State, d.Trigger, d.ManualOperationID = "pending", "automatic", nil
				d.NextAttemptAt, d.ExpiresAt, d.QueueOrder = &next, d.AutomaticExpiresAt, ticket
				touchDelivery(d, now)
				return sc.UpdateDelivery(ctx, *d)
			}
			return terminalDelivery(ctx, sc, d, now, "failed", "expired")
		}
	}
	return scheduleFailure(ctx, sc, d, now, wait)
}
