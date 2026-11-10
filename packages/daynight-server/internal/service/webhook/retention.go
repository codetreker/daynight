package webhook

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
)

const retentionBatch = 500

type retentionStore interface {
	store.WebhookRetentionTransactions
	store.WebhookReceiptGC
	store.WebhookConfigGC
}

type configCollector interface {
	Reconcile(context.Context, store.WebhookConfigGC) error
	Pass(context.Context, store.WebhookConfigGC, int) (int, error)
}

type receiptCollector interface {
	Reconcile(context.Context, store.WebhookReceiptGC) error
	Pass(context.Context, store.WebhookReceiptGC, int) (int, store.Completion, error)
}

// Retention owns a separate history maintenance loop, independent of dispatch.
// Construction does not start work; the owner must stop it before closing DB.
type Retention struct {
	DB             retentionStore
	mu             sync.Mutex
	passMu         sync.Mutex
	observationMu  sync.RWMutex
	observation    RetentionObservation
	events         chan RetentionEvent
	droppedEvents  atomic.Uint64
	passLag        retentionLag
	unknownPending bool
	cancel         context.CancelFunc
	done           chan struct{}
	failures       chan error
	pending        *retentionUnknown
	config         configCollector
	receipts       receiptCollector
	phase          int
	historyPhase   int
	wait           func(context.Context, time.Duration) bool
}

type retentionUnknown struct{ kind, id string }

func NewRetention(db retentionStore) *Retention {
	return &Retention{DB: db, config: &core.ConfigCollector{}, receipts: &core.ReceiptCollector{}, failures: make(chan error, 1), events: make(chan RetentionEvent, 128), wait: waitPoll}
}
func (r *Retention) Failures() <-chan error { return r.failures }
func (r *Retention) Start(parent context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if parent == nil || r.DB == nil || r.done != nil {
		return fmt.Errorf("invalid or already started webhook retention")
	}
	ctx, cancel := context.WithCancel(parent)
	r.cancel = cancel
	r.done = make(chan struct{})
	go func() {
		defer close(r.done)
		defer func() {
			if recover() != nil && ctx.Err() == nil {
				r.failures <- fmt.Errorf("webhook retention panic")
			}
		}()
		err := r.run(ctx)
		if ctx.Err() == nil {
			if err == nil {
				err = fmt.Errorf("webhook retention exited unexpectedly")
			}
			r.failures <- err
		}
	}()
	return nil
}
func (r *Retention) Stop(ctx context.Context) error {
	r.mu.Lock()
	cancel, done := r.cancel, r.done
	r.mu.Unlock()
	if cancel == nil {
		return nil
	}
	cancel()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (r *Retention) run(ctx context.Context) error {
	for ctx.Err() == nil {
		n, more, err := r.Pass(ctx)
		if err != nil {
			var receiptUnknown *core.ReceiptGCUnknownError
			var configUnknown *core.ConfigGCUnknownError
			if !errors.Is(err, errDeliveryOutcomeUnknown) && !errors.As(err, &receiptUnknown) && !errors.As(err, &configUnknown) {
				return err
			}
			more = true
		}
		delay := time.Minute
		if more || n == retentionBatch {
			delay = time.Second
		}
		if !r.wait(ctx, delay) {
			return nil
		}
	}
	return nil
}

// Pass bounds actual affected rows and cancels database work after two seconds.
// The result is only reported after each transaction is known committed.
func (r *Retention) Pass(parent context.Context) (total int, continueSoon bool, resultErr error) {
	return r.pass(parent, 2*time.Second)
}

func (r *Retention) pass(parent context.Context, timeout time.Duration) (total int, continueSoon bool, resultErr error) {
	if !r.passMu.TryLock() {
		return 0, true, nil
	}
	defer r.passMu.Unlock()
	r.passLag = retentionLag{}
	var observation RetentionObservation
	defer func() {
		observation.ConfirmedRows, observation.ContinueSoon = total, continueSoon
		r.publishObservation(observation, resultErr)
	}()
	if r.DB == nil {
		return 0, false, fmt.Errorf("missing webhook retention store")
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	if err := r.receipts.Reconcile(ctx, r.DB); err != nil {
		if ctx.Err() != nil && parent.Err() == nil {
			return 0, true, nil
		}
		return 0, false, err
	}
	if r.pending != nil {
		if err := r.DB.ObserveWebhookRetention(ctx, r.pending.kind, r.pending.id); err != nil {
			if ctx.Err() != nil && parent.Err() == nil {
				return 0, true, nil
			}
			return 0, false, fmt.Errorf("reconcile unknown webhook retention: %w", err)
		}
		r.pending = nil
	}
	if err := r.config.Reconcile(ctx, r.DB); err != nil {
		if ctx.Err() != nil && parent.Err() == nil {
			return 0, true, nil
		}
		return 0, false, err
	}
	r.unknownPending = false
	start := r.phase
	r.phase = (r.phase + 1) % 3
	more := false
	for offset := 0; offset < 3 && total < retentionBatch; offset++ {
		budget := min(retentionBatch/4, retentionBatch-total)
		switch (start + offset) % 3 {
		case 0:
			n, err := r.config.Pass(ctx, r.DB, budget)
			total += n
			observation.ConfigRows += n
			more = more || n == budget
			if err != nil {
				var unknown *core.ConfigGCUnknownError
				if errors.As(err, &unknown) {
					return total, false, err
				}
				if ctx.Err() != nil && parent.Err() == nil {
					return total, true, nil
				}
				return total, false, err
			}
		case 1:
			n, _, err := r.receipts.Pass(ctx, r.DB, budget)
			total += n
			observation.ReceiptRows += n
			more = more || n == budget
			if err != nil {
				var unknown *core.ReceiptGCUnknownError
				if errors.As(err, &unknown) {
					return total, false, err
				}
				if ctx.Err() != nil && parent.Err() == nil {
					return total, true, nil
				}
				return total, false, err
			}
		case 2:
			for total < retentionBatch {
				changed, found, needsBudget, err := r.step(ctx, retentionBatch-total)
				if err != nil {
					if ctx.Err() != nil && parent.Err() == nil && !errors.Is(err, errDeliveryOutcomeUnknown) {
						return total, true, nil
					}
					return total, false, err
				}
				total += changed
				observation.HistoryRows += changed
				if needsBudget {
					more = true
					break
				}
				if !found {
					break
				}
			}
		}
	}
	return total, more || total == retentionBatch, nil
}
func (r *Retention) step(ctx context.Context, budget int) (changed int, found, needsBudget bool, err error) {
	var subjectKind, subjectID string
	var phaseName string
	var delivery store.WebhookDelivery
	var dueAt, observedAt time.Time
	completion, cause := r.DB.WriteWebhookRetention(ctx, func(sc store.WebhookRetentionScope) error {
		now, e := sc.ObservedAt(ctx)
		if e != nil {
			return e
		}
		phases := [...]string{"purge", "close", "payload", "orphan", "fact"}
		for offset := 0; offset < len(phases); offset++ {
			index := (r.historyPhase + offset) % len(phases)
			phase := phases[index]
			if phase == "orphan" || phase == "fact" {
				subjectKind = "event"
				phaseName = phase
				if phase == "orphan" {
					subjectID, changed, e = sc.DeleteUnreferencedEvent(ctx)
				} else {
					subjectID, changed, e = sc.ClearExpiredEvent(ctx)
				}
				if e != nil {
					return e
				}
				if changed != 0 {
					found = true
					r.historyPhase = (index + 1) % len(phases)
					return nil
				}
				continue
			}
			d, ok, e := sc.LockRetentionCandidate(ctx, phase, now)
			if e != nil {
				return e
			}
			if !ok {
				continue
			}
			found = true
			r.historyPhase = (index + 1) % len(phases)
			subjectKind, subjectID = "delivery", d.ID
			phaseName, delivery = phase, d
			now, e = sc.ObservedAt(ctx)
			if e != nil {
				return e
			}
			switch phase {
			case "purge":
				if d.PurgingAt != nil {
					dueAt, observedAt = *d.PurgingAt, now
				}
				changed, e = sc.DeleteRetentionChildren(ctx, d.ID, budget)
				if e != nil {
					return e
				}
				if changed == 0 {
					changed, e = sc.DeleteRetainedDelivery(ctx, d.ID)
					if e == nil && changed == 0 {
						return fmt.Errorf("closed webhook retention has undeletable children")
					}
				}
				return e
			case "payload":
				if d.PurgingAt != nil || d.PayloadRemovedAt != nil || now.Before(d.PayloadExpiresAt) || core.RetentionActive(d, now) {
					found = false
					return nil
				}
				dueAt, observedAt = d.PayloadExpiresAt, now
				changed, e = sc.RemoveExpiredPayload(ctx, d.ID, now)
				return e
			case "close":
				if d.PurgingAt != nil || now.Before(d.MetadataExpiresAt) || core.RetentionActive(d, now) {
					found = false
					return nil
				}
				attempts, e := sc.LockAttempts(ctx, d.ID)
				if e != nil {
					return e
				}
				if len(attempts) > 13 {
					return fmt.Errorf("webhook retention attempt limit exceeded")
				}
				now, e = sc.ObservedAt(ctx)
				if e != nil {
					return e
				}
				last := core.LastRetentionActivity(d, attempts)
				seconds, e := sc.RetentionSeconds(ctx, d.PolicyVersion)
				if e != nil {
					return e
				}
				if seconds <= 0 {
					return fmt.Errorf("invalid webhook retention policy")
				}
				expiry := last.Add(time.Duration(seconds) * time.Second)
				if expiry.After(now) {
					changed, e = sc.ExtendRetention(ctx, d.ID, last, expiry)
					return e
				}
				dueAt, observedAt = expiry, now
				if d.MetadataExpiresAt.After(dueAt) {
					dueAt = d.MetadataExpiresAt
				}
				if budget < 1+len(attempts) {
					needsBudget = true
					return nil
				}
				for _, a := range attempts {
					if a.RetentionClosedAt != nil {
						return fmt.Errorf("open webhook delivery has closed attempt")
					}
				}
				changed, e = sc.CloseRetention(ctx, d.ID, now)
				if e == nil && changed != 1+len(attempts) {
					return fmt.Errorf("webhook retention close count mismatch")
				}
				return e
			}
		}
		return nil
	})
	if e := transactionError("retention", completion, cause); e != nil {
		if errors.Is(e, errDeliveryOutcomeUnknown) {
			r.pending = &retentionUnknown{kind: subjectKind, id: subjectID}
		}
		r.emitRetentionStep(phaseName, subjectKind, subjectID, delivery, 0, e)
		return 0, false, false, e
	}
	if !dueAt.IsZero() {
		r.recordLag(observedAt, dueAt)
	}
	if changed > 0 {
		r.emitRetentionStep(phaseName, subjectKind, subjectID, delivery, changed, nil)
	}
	return changed, found, needsBudget, nil
}
