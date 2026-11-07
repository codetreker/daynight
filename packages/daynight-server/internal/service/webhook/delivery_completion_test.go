package webhook

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
)

type completionScope struct {
	store.WebhookDeliveryScope
	d           store.WebhookDelivery
	ticket      int64
	ticketError error
}

func (s *completionScope) NextQueueOrder(context.Context) (int64, error) {
	return s.ticket, s.ticketError
}
func (s *completionScope) UpdateDelivery(_ context.Context, d store.WebhookDelivery) error {
	s.d = d
	return nil
}
func planFixture() (store.WebhookDelivery, time.Time) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	schedule := make([]time.Time, 10)
	for i := range schedule {
		schedule[i] = now.Add(time.Duration(i) * time.Minute)
	}
	return store.WebhookDelivery{AutomaticScheduleAt: schedule, AutomaticExpiresAt: now.Add(72 * time.Hour), AutomaticOpen: true, AutomaticAttemptCount: 1, AutomaticPlanCursor: 1, Trigger: "automatic", State: "leased"}, now
}
func TestScheduleFailurePreservesBudgetAndNewTicket(t *testing.T) {
	d, now := planFixture()
	scope := &completionScope{ticket: 42}
	if err := scheduleFailure(context.Background(), scope, &d, now, nil); err != nil {
		t.Fatal(err)
	}
	if scope.d.State != "pending" || scope.d.QueueOrder != 42 || scope.d.AutomaticAttemptCount != 1 || !scope.d.NextAttemptAt.Equal(now.Add(time.Minute)) || !scope.d.MetadataExpiresAt.Equal(now.Add(30*24*time.Hour)) {
		t.Fatalf("rescheduled: %+v", scope.d)
	}
	tooLate := d.AutomaticExpiresAt.Add(time.Second)
	d, now = planFixture()
	if err := scheduleFailure(context.Background(), scope, &d, now, &tooLate); err != nil {
		t.Fatal(err)
	}
	if scope.d.State != "failed" || scope.d.AutomaticOpen || scope.d.NextAttemptAt != nil {
		t.Fatalf("wait past deadline: %+v", scope.d)
	}
}
func TestRecoverySchedulesOneMissedOpportunity(t *testing.T) {
	d, start := planFixture()
	now := start.Add(5*time.Minute + time.Second)
	scope := &completionScope{ticket: 77}
	if err := recoverSchedule(context.Background(), scope, &d, now, nil); err != nil {
		t.Fatal(err)
	}
	if scope.d.State != "pending" || scope.d.QueueOrder != 77 || scope.d.AutomaticPlanCursor != 1 || !scope.d.NextAttemptAt.Equal(now.Add(5*time.Second)) {
		t.Fatalf("recovery: %+v", scope.d)
	}
	d, start = planFixture()
	scope.ticketError = errors.New("sequence unavailable")
	if err := recoverSchedule(context.Background(), scope, &d, start.Add(5*time.Minute), nil); err == nil {
		t.Fatal("sequence failure hidden")
	}
}
func TestDeliveryObservationDoesNotPersistRawResponse(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	o := observe(time.Second, now, httpoutbound.Response{Status: 202, Body: []byte("private receiver response"), ReadError: true}, nil)
	if o.outcome != "acknowledged" || o.status == nil || *o.status != 202 || o.errorCode != nil {
		t.Fatalf("observation: %+v", o)
	}
	o = observe(time.Second, now, httpoutbound.Response{Status: 429, RetryAfter: "60"}, nil)
	if o.retry == nil || !o.retry.Equal(now.Add(time.Minute)) {
		t.Fatalf("retry: %+v", o)
	}
	o = observe(time.Second, now, httpoutbound.Response{}, errors.New("https://secret-host/private-token"))
	if o.outcome != "unknown" || o.errorCode == nil || *o.errorCode != "transport_error" || o.status != nil {
		t.Fatalf("failure observation: %+v", o)
	}
}

type lateScope struct {
	store.WebhookDeliveryScope
	attempt store.WebhookAttempt
	now     time.Time
}

func (s *lateScope) TryLockDelivery(context.Context, string) (store.WebhookDelivery, bool, error) {
	return store.WebhookDelivery{}, false, nil
}
func (s *lateScope) LockOwnAttempt(context.Context, string) (store.WebhookAttempt, error) {
	return s.attempt, nil
}
func (s *lateScope) ObservedAt(context.Context) (time.Time, error) { return s.now, nil }
func (s *lateScope) UpdateAttempt(_ context.Context, a store.WebhookAttempt) error {
	s.attempt = a
	return nil
}

type lateDB struct{ scope *lateScope }

func (db lateDB) WriteWebhookDelivery(_ context.Context, fn func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	err := fn(db.scope)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func TestFinalizeWaitsForRecoveryWithoutHoldingDelivery(t *testing.T) {
	now := time.Now()
	own := store.WebhookAttempt{ID: "a", DeliveryID: "d", LeaseToken: "token", Generation: 1}
	s := &lateScope{attempt: own, now: now}
	r := NewRunner(lateDB{scope: s}, &Service{}, true)
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	if err := r.finalize(ctx, own, now, time.Second, httpoutbound.Response{Status: 202}, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("waiting finalization: %v", err)
	}
	if s.attempt.LateObservedAt != nil {
		t.Fatal("fabricated late observation before recovery")
	}
	s.attempt.RecoveredUnknownAt = &now
	if err := r.finalize(context.Background(), own, now, time.Second, httpoutbound.Response{Status: 202}, nil); err != nil {
		t.Fatal(err)
	}
	if s.attempt.LateOutcome == nil || *s.attempt.LateOutcome != "acknowledged" {
		t.Fatal("late response not recorded")
	}
}

func TestRunnerStopHonorsDeadline(t *testing.T) {
	r := &Runner{}
	if err := r.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r.cancel = func() {}
	r.finished = make(chan struct{})
	if err := r.Stop(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("unbounded stop: %v", err)
	}
}

type recoveryScope struct {
	store.WebhookDeliveryScope
	d          store.WebhookDelivery
	now        time.Time
	attempts   []store.WebhookAttempt
	queryError error
	changed    bool
}

func (s *recoveryScope) ObservedAt(context.Context) (time.Time, error) { return s.now, nil }
func (s *recoveryScope) LockExpired(context.Context, int, time.Time) ([]store.WebhookDelivery, error) {
	if s.queryError != nil {
		return nil, s.queryError
	}
	return []store.WebhookDelivery{s.d}, nil
}
func (s *recoveryScope) LockAttempts(context.Context, string) ([]store.WebhookAttempt, error) {
	return s.attempts, nil
}
func (s *recoveryScope) UpdateDelivery(_ context.Context, d store.WebhookDelivery) error {
	s.d = d
	s.changed = true
	return nil
}

type recoveryDB struct{ scope *recoveryScope }

func (db recoveryDB) WriteWebhookDelivery(_ context.Context, fn func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	err := fn(db.scope)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func TestRecoveryDoesNotInventAttemptForClaim(t *testing.T) {
	d, now := planFixture()
	until := now.Add(-time.Second)
	d.LeaseUntil = &until
	d.ExpiresAt = now.Add(time.Hour)
	d.Generation = 1
	s := &recoveryScope{d: d, now: now}
	r := NewRunner(recoveryDB{scope: s}, &Service{}, false)
	if err := r.recoverExpired(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !s.changed || s.d.State != "pending" || s.d.Generation != 2 || len(s.attempts) != 0 || s.d.AutomaticAttemptCount != 1 {
		t.Fatalf("claim recovery: %+v", s.d)
	}
}
func TestRecoveryLeavesStateOnStorageFailure(t *testing.T) {
	d, now := planFixture()
	s := &recoveryScope{d: d, now: now, queryError: errors.New("database failure")}
	r := NewRunner(recoveryDB{scope: s}, &Service{}, false)
	if err := r.recoverExpired(context.Background()); err == nil || s.changed {
		t.Fatalf("storage failure hidden: %v", err)
	}
}
