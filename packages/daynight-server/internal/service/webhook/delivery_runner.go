package webhook

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
)

const deliveryWorkers = 8

var errDeliveryOutcomeUnknown = errors.New("webhook transaction outcome unknown")

type outboundClient interface {
	Do(context.Context, string, []byte, http.Header) (httpoutbound.Response, error)
}

// Runner owns the delivery pool. Construction starts no background work.
type Runner struct {
	DB         store.WebhookDeliveryTransactions
	Logger     *slog.Logger
	service    *Service
	client     outboundClient
	enabled    bool
	mu         sync.Mutex
	cancel     context.CancelFunc
	stopClaims context.CancelFunc
	finished   chan struct{}
	failures   chan error
}

func NewRunner(db store.WebhookDeliveryTransactions, service *Service, enabled bool) *Runner {
	return &Runner{DB: db, service: service, client: httpoutbound.New(), enabled: enabled, failures: make(chan error, 1)}
}

// Failures reports permanent worker failure to the application owner.
func (r *Runner) Failures() <-chan error { return r.failures }

// Start derives the pool from the application runtime, not a source request.
func (r *Runner) Start(parent context.Context) error {
	return r.StartWithClaimContext(parent, parent)
}

// StartWithClaimContext binds claim admission to the runtime root while work
// already claimed can drain under the separate work context.
func (r *Runner) StartWithClaimContext(parent, claims context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cancel != nil || r.finished != nil {
		return fmt.Errorf("webhook runner already started")
	}
	if parent == nil || claims == nil || parent.Err() != nil || claims.Err() != nil || r.DB == nil || r.service == nil || (r.enabled && r.service.Keys == nil) || r.client == nil {
		return fmt.Errorf("invalid webhook runner dependencies")
	}
	ctx, cancel := context.WithCancel(parent)
	r.cancel = cancel
	claimCtx, stopClaims := context.WithCancel(claims)
	r.stopClaims = stopClaims
	r.finished = make(chan struct{})
	var wg sync.WaitGroup
	launch := func(work func(context.Context) error, stopped func() bool) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() {
				if recover() != nil {
					r.fail(fmt.Errorf("webhook worker panic"))
				}
			}()
			err := work(ctx)
			if ctx.Err() == nil && (err != nil || !stopped()) {
				if err == nil {
					err = fmt.Errorf("webhook worker exited unexpectedly")
				}
				r.fail(err)
			}
		}()
	}
	launch(r.maintenance, func() bool { return false })
	if r.enabled {
		for i := 0; i < deliveryWorkers; i++ {
			launch(func(ctx context.Context) error { return r.worker(ctx, claimCtx) }, func() bool { return claimCtx.Err() != nil })
		}
	}
	go func() { wg.Wait(); close(r.finished) }()
	return nil
}

// StopClaims prevents further network work from being claimed while already
// claimed work is allowed to finish under the runtime context.
func (r *Runner) StopClaims() {
	r.mu.Lock()
	stop := r.stopClaims
	r.mu.Unlock()
	if stop != nil {
		stop()
	}
}
func (r *Runner) fail(err error) {
	select {
	case r.failures <- err:
	default:
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cancel != nil {
		r.cancel()
	}
	if r.stopClaims != nil {
		r.stopClaims()
	}
}

// Stop stops new claims and cancels in-flight work; callers supply the shared
// shutdown deadline before releasing the underlying store.
func (r *Runner) Stop(ctx context.Context) error {
	r.mu.Lock()
	cancel, stopClaims, done := r.cancel, r.stopClaims, r.finished
	r.mu.Unlock()
	if cancel == nil {
		return nil
	}
	stopClaims()
	cancel()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (r *Runner) transaction(ctx context.Context, fn func(context.Context, store.WebhookDeliveryScope) error) (store.Completion, error) {
	bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return r.DB.WriteWebhookDelivery(bounded, func(sc store.WebhookDeliveryScope) error { return fn(bounded, sc) })
}
func transactionError(phase string, c store.Completion, err error) error {
	if c.Outcome == store.TransactionUnknown {
		return fmt.Errorf("webhook %s transaction unknown: %w", phase, errors.Join(errDeliveryOutcomeUnknown, err))
	}
	if err != nil {
		return fmt.Errorf("webhook %s transaction %s: %w", phase, c.Outcome, err)
	}
	if c.Outcome != store.TransactionCommitted {
		return fmt.Errorf("webhook %s transaction %s", phase, c.Outcome)
	}
	return nil
}
func waitPoll(ctx context.Context) bool {
	t := time.NewTimer(time.Second)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
func (r *Runner) worker(ctx, claimCtx context.Context) error {
	for claimCtx.Err() == nil {
		id, err := r.service.newID()
		if err != nil {
			return err
		}
		var deliveries []store.WebhookDelivery
		completion, err := r.transaction(claimCtx, func(ctx context.Context, sc store.WebhookDeliveryScope) error {
			now, e := sc.ObservedAt(ctx)
			if e != nil {
				return e
			}
			deliveries, e = sc.Claim(ctx, 1, now, []string{id})
			return e
		})
		if err != nil || completion.Outcome != store.TransactionCommitted {
			if claimCtx.Err() != nil {
				return nil
			}
			failure := transactionError("claim", completion, err)
			if errors.Is(failure, errDeliveryOutcomeUnknown) {
				if !waitPoll(claimCtx) {
					return nil
				}
				continue
			}
			return failure
		}
		if len(deliveries) == 0 {
			if !waitPoll(claimCtx) {
				return nil
			}
			continue
		}
		if len(deliveries) != 1 {
			return fmt.Errorf("webhook claim exceeded idle capacity")
		}
		r.logDelivery(deliveries[0], nil, nil, "claim", "")
		prepared, err := r.admit(ctx, deliveries[0])
		if err != nil {
			r.logDelivery(deliveries[0], nil, nil, "admission", "admission_failed")
			if errors.Is(err, errDeliveryOutcomeUnknown) {
				continue
			}
			return err
		}
		if prepared == nil {
			continue
		}
		r.logDelivery(prepared.delivery, &prepared.attempt, prepared.originRequestID, "admitted", "")
		var dispatched time.Time
		completion, err = r.transaction(ctx, func(ctx context.Context, sc store.WebhookDeliveryScope) error {
			var e error
			dispatched, e = sc.ObservedAt(ctx)
			return e
		})
		if err != nil || completion.Outcome != store.TransactionCommitted {
			failure := transactionError("dispatch time", completion, err)
			if errors.Is(failure, errDeliveryOutcomeUnknown) {
				continue
			}
			return failure
		}
		start := time.Now()
		r.logDelivery(prepared.delivery, &prepared.attempt, prepared.originRequestID, "http", "")
		response, sendErr := r.client.Do(ctx, prepared.target, prepared.body, prepared.headers)
		finished := time.Now()
		if err := r.finalize(ctx, prepared.attempt, dispatched, finished.Sub(start), response, sendErr); err != nil {
			r.logDelivery(prepared.delivery, &prepared.attempt, prepared.originRequestID, "finalize", "finalize_failed")
			if errors.Is(err, errDeliveryOutcomeUnknown) {
				continue
			}
			return err
		}
		result := observe(finished.Sub(start), dispatched, response, sendErr)
		r.logDeliveryResult(prepared.delivery, &prepared.attempt, prepared.originRequestID, "finalize", result.outcome, &result)
		r.logDeliveryResult(prepared.delivery, &prepared.attempt, prepared.originRequestID, "finished", result.outcome, &result)
	}
	return nil
}

func (r *Runner) logDelivery(d store.WebhookDelivery, a *store.WebhookAttempt, request *string, phase, code string) {
	r.logDeliveryResult(d, a, request, phase, code, nil)
}

func (r *Runner) logDeliveryResult(d store.WebhookDelivery, a *store.WebhookAttempt, request *string, phase, code string, result *observation) {
	if r.Logger == nil {
		return
	}
	var status *int16
	var duration *int64
	var outcome *string
	if result != nil {
		status, duration, outcome = result.status, result.duration, &result.outcome
	}
	attempt, origin := "", ""
	if a != nil {
		attempt = a.ID
	}
	if request != nil {
		origin = *request
	}
	r.Logger.Info("webhook delivery", "component", "webhook", "phase", phase,
		"origin_request_id", origin, "operation_id", d.ManualOperationID, "event_id", d.EventID, "delivery_id", d.ID,
		"attempt_id", attempt, "endpoint_id", d.EndpointID, "owner_kind", d.Owner.Kind,
		"owner_id", d.Owner.ID, "project_id", d.ProjectID, "adapter", d.DestinationKind,
		"adapter_version", d.AdapterVersion, "trigger", d.Trigger,
		"generation", d.Generation, "result_code", code, "outcome", outcome,
		"http_status", status, "duration_ms", duration)
}
func (r *Runner) maintenance(ctx context.Context) error {
	for ctx.Err() == nil {
		if err := r.recoverExpired(ctx); err != nil {
			if errors.Is(err, errDeliveryOutcomeUnknown) {
				if !waitPoll(ctx) {
					return nil
				}
				continue
			}
			return err
		}
		if !waitPoll(ctx) {
			return nil
		}
	}
	return nil
}
