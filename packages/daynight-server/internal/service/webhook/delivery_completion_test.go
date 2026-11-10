package webhook

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
)

type completionScope struct {
	deliveryUnexpectedScope
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
	scope := &completionScope{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}, ticket: 42}
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
	scope := &completionScope{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}, ticket: 77}
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
	deliveryUnexpectedScope
	attempt   store.WebhookAttempt
	now       time.Time
	readError error
	updates   []store.WebhookAttempt
}

func (s *lateScope) TryLockDelivery(context.Context, string) (store.WebhookDelivery, bool, error) {
	return store.WebhookDelivery{}, false, nil
}
func (s *lateScope) LockOwnAttempt(context.Context, string) (store.WebhookAttempt, error) {
	return s.attempt, s.readError
}
func (s *lateScope) ObservedAt(context.Context) (time.Time, error) { return s.now, nil }
func (s *lateScope) UpdateAttempt(_ context.Context, a store.WebhookAttempt) error {
	s.updates = append(s.updates, a)
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
	s := &lateScope{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}, attempt: own, now: now}
	r := NewRunner(lateDB{scope: s}, &Service{}, true)
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	if err := r.finalize(ctx, own, now, time.Second, httpoutbound.Response{Status: 202}, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("waiting finalization: %v", err)
	}
	if len(s.updates) != 0 {
		t.Fatal("fabricated late observation before recovery")
	}
	s.attempt.RecoveredUnknownAt = &now
	if err := r.finalize(context.Background(), own, now, time.Second, httpoutbound.Response{Status: 202}, nil); err != nil {
		t.Fatal(err)
	}
	if len(s.updates) != 1 || s.updates[0].LateOutcome == nil || *s.updates[0].LateOutcome != "acknowledged" {
		t.Fatal("late response not recorded")
	}
}

func TestLateFinalizationRejectsDifferentAttemptAndReadFailure(t *testing.T) {
	now := time.Now()
	own := store.WebhookAttempt{ID: "a", DeliveryID: "d", LeaseToken: "token", Generation: 1}
	s := &lateScope{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}, attempt: own, now: now}
	r := NewRunner(lateDB{scope: s}, &Service{}, true)
	s.attempt.LeaseToken = "other"
	if done, err := r.finalizeOnce(context.Background(), own, now, time.Second, httpoutbound.Response{Status: 202}, nil); err == nil {
		t.Fatalf("different attempt accepted: %t %v", done, err)
	}
	s.attempt = own
	s.readError = errors.New("attempt read failed")
	if done, err := r.finalizeOnce(context.Background(), own, now, time.Second, httpoutbound.Response{Status: 202}, nil); err == nil {
		t.Fatalf("read failure hidden: %t %v", done, err)
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
	deliveryUnexpectedScope
	d              store.WebhookDelivery
	now            time.Time
	attempts       []store.WebhookAttempt
	attemptUpdates []store.WebhookAttempt
	updated        store.WebhookDelivery
	queryError     error
	changed        bool
	attemptError   error
	waitError      error
	wait           store.WebhookEndpointWait
	noExpired      bool
	due            []store.WebhookDelivery
	current        bool
	currentError   error
}

func (s *recoveryScope) ObservedAt(context.Context) (time.Time, error) { return s.now, nil }
func (s *recoveryScope) LockExpired(context.Context, int, time.Time) ([]store.WebhookDelivery, error) {
	if s.queryError != nil {
		return nil, s.queryError
	}
	if s.noExpired {
		return nil, nil
	}
	return []store.WebhookDelivery{s.d}, nil
}
func (s *recoveryScope) LockAttempts(context.Context, string) ([]store.WebhookAttempt, error) {
	return s.attempts, s.attemptError
}
func (s *recoveryScope) LockDueExpiry(context.Context, int, time.Time) ([]store.WebhookDelivery, error) {
	return s.due, nil
}
func (s *recoveryScope) LockWait(context.Context, string, int64) (store.WebhookEndpointWait, error) {
	return s.wait, s.waitError
}
func (s *recoveryScope) CurrentDestination(context.Context, string, int64) (bool, error) {
	return s.current, s.currentError
}
func (s *recoveryScope) UpdateAttempt(_ context.Context, a store.WebhookAttempt) error {
	s.attemptUpdates = append(s.attemptUpdates, a)
	return nil
}
func (s *recoveryScope) UpdateDelivery(_ context.Context, d store.WebhookDelivery) error {
	s.updated = d
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
	s := &recoveryScope{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}, d: d, now: now}
	r := NewRunner(recoveryDB{scope: s}, &Service{}, false)
	if err := r.recoverExpired(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !s.changed || s.updated.State != "pending" || s.updated.Generation != 2 || len(s.attempts) != 0 || s.updated.AutomaticAttemptCount != 1 {
		t.Fatalf("claim recovery: %+v", s.d)
	}
}
func TestRecoveryLeavesStateOnStorageFailure(t *testing.T) {
	d, now := planFixture()
	s := &recoveryScope{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}, d: d, now: now, queryError: errors.New("database failure")}
	r := NewRunner(recoveryDB{scope: s}, &Service{}, false)
	if err := r.recoverExpired(context.Background()); err == nil || s.changed {
		t.Fatalf("storage failure hidden: %v", err)
	}
}

func TestRecoveryRejectsBrokenAttemptAndWait(t *testing.T) {
	d, now := planFixture()
	until, id := now.Add(-time.Second), "attempt"
	d.ID, d.LeaseUntil, d.ExpiresAt, d.CurrentAttemptID = "delivery", &until, now.Add(time.Hour), &id
	s := &recoveryScope{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}, d: d, now: now}
	r := NewRunner(recoveryDB{scope: s}, &Service{}, false)
	s.attemptError = errors.New("attempt history read failed")
	if err := r.recoverExpired(context.Background()); err == nil || s.changed {
		t.Fatalf("attempt history error hidden: %v", err)
	}
	s.attemptError = nil
	if err := r.recoverExpired(context.Background()); err == nil || s.changed {
		t.Fatalf("missing attempt accepted: %v", err)
	}
	s.attempts = []store.WebhookAttempt{{ID: id, DeliveryID: d.ID}}
	s.waitError = errors.New("wait lookup failed")
	if err := r.recoverExpired(context.Background()); err == nil || s.changed {
		t.Fatalf("wait lookup failure ignored: %v", err)
	}
	s.waitError = nil
	s.wait.Owner.ID = "different owner"
	if err := r.recoverExpired(context.Background()); err == nil || s.changed {
		t.Fatalf("inconsistent wait accepted: %v", err)
	}
	s.waitError = model.ErrNotFound
	s.current = true
	if err := r.recoverExpired(context.Background()); err == nil || s.changed {
		t.Fatalf("missing current wait accepted: %v", err)
	}
	s.currentError = errors.New("destination read failed")
	if err := r.recoverExpired(context.Background()); err == nil || s.changed {
		t.Fatalf("destination read failure hidden: %v", err)
	}
}

func TestRecoveryExpiresPendingWithoutClaim(t *testing.T) {
	d, now := planFixture()
	d.State = "pending"
	s := &recoveryScope{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}, now: now, noExpired: true, due: []store.WebhookDelivery{d}}
	r := NewRunner(recoveryDB{scope: s}, &Service{}, false)
	if err := r.recoverExpired(context.Background()); err != nil || !s.changed || s.updated.State != "failed" || s.updated.AutomaticOpen {
		t.Fatalf("expired pending: %+v %v", s.d, err)
	}
}

type recoveryOutcomes struct {
	calls  int
	cancel context.CancelFunc
}

func (d *recoveryOutcomes) WriteWebhookDelivery(_ context.Context, _ func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	d.calls++
	if d.calls == 1 {
		if d.cancel != nil {
			d.cancel()
		}
		return store.Completion{Outcome: store.TransactionUnknown}, errors.New("lost commit receipt")
	}
	return store.Completion{Outcome: store.TransactionNotCommitted}, errors.New("permanent storage failure")
}
func TestMaintenanceContinuesAfterUnknownRecovery(t *testing.T) {
	db := &recoveryOutcomes{}
	r := NewRunner(db, &Service{}, false)
	r.maintenancePollInterval = time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := r.maintenance(ctx); err == nil || db.calls != 2 {
		t.Fatalf("unknown recovery ended prematurely: calls=%d err=%v", db.calls, err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	db = &recoveryOutcomes{cancel: cancel}
	r = NewRunner(db, &Service{}, false)
	if err := r.maintenance(ctx); err != nil || db.calls != 1 {
		t.Fatalf("cancelled wait: calls=%d err=%v", db.calls, err)
	}
}

type brokenRandom struct{}

func (brokenRandom) Read([]byte) (int, error) { return 0, errors.New("entropy unavailable") }
func TestWorkerReportsEntropyFailureBeforeClaim(t *testing.T) {
	r := NewRunner(nil, &Service{Random: brokenRandom{}}, true)
	if err := r.worker(context.Background(), context.Background()); err == nil {
		t.Fatal("entropy failure hidden")
	}
}
