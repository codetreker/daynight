package webhook

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type deliveryUnexpectedScope struct{ t testing.TB }

func (s deliveryUnexpectedScope) unexpected(method string) error {
	s.t.Helper()
	s.t.Errorf("unexpected delivery DAO call: %s", method)
	return fmt.Errorf("unexpected delivery DAO call: %s", method)
}

func (s deliveryUnexpectedScope) ObservedAt(ctx context.Context) (time.Time, error) {
	panic(s.unexpected("ObservedAt"))
}

func (s deliveryUnexpectedScope) Claim(ctx context.Context, limit int, at time.Time, tokens []string) ([]store.WebhookDelivery, error) {
	panic(s.unexpected("Claim"))
}

func (s deliveryUnexpectedScope) LockExpired(ctx context.Context, limit int, at time.Time) ([]store.WebhookDelivery, error) {
	panic(s.unexpected("LockExpired"))
}

func (s deliveryUnexpectedScope) LockDueExpiry(ctx context.Context, limit int, at time.Time) ([]store.WebhookDelivery, error) {
	panic(s.unexpected("LockDueExpiry"))
}

func (s deliveryUnexpectedScope) AdmissionSources(ctx context.Context, id string, at time.Time) (store.WebhookAdmissionSources, error) {
	panic(s.unexpected("AdmissionSources"))
}

func (s deliveryUnexpectedScope) LockDelivery(ctx context.Context, id string) (store.WebhookDelivery, error) {
	panic(s.unexpected("LockDelivery"))
}

func (s deliveryUnexpectedScope) TryLockDelivery(ctx context.Context, id string) (store.WebhookDelivery, bool, error) {
	panic(s.unexpected("TryLockDelivery"))
}

func (s deliveryUnexpectedScope) LockAttempts(ctx context.Context, id string) ([]store.WebhookAttempt, error) {
	panic(s.unexpected("LockAttempts"))
}

func (s deliveryUnexpectedScope) LockOwnAttempt(ctx context.Context, id string) (store.WebhookAttempt, error) {
	panic(s.unexpected("LockOwnAttempt"))
}

func (s deliveryUnexpectedScope) CurrentDestination(ctx context.Context, id string, revision int64) (bool, error) {
	panic(s.unexpected("CurrentDestination"))
}

func (s deliveryUnexpectedScope) LockWait(ctx context.Context, id string, revision int64) (store.WebhookEndpointWait, error) {
	panic(s.unexpected("LockWait"))
}

func (s deliveryUnexpectedScope) InsertAttempt(ctx context.Context, a store.WebhookAttempt) error {
	panic(s.unexpected("InsertAttempt"))
}

func (s deliveryUnexpectedScope) UpdateDelivery(ctx context.Context, d store.WebhookDelivery) error {
	panic(s.unexpected("UpdateDelivery"))
}

func (s deliveryUnexpectedScope) UpdateAttempt(ctx context.Context, a store.WebhookAttempt) error {
	panic(s.unexpected("UpdateAttempt"))
}

func (s deliveryUnexpectedScope) RaiseWait(ctx context.Context, id string, revision int64, wait, at time.Time) error {
	panic(s.unexpected("RaiseWait"))
}

func (s deliveryUnexpectedScope) NextQueueOrder(ctx context.Context) (int64, error) {
	panic(s.unexpected("NextQueueOrder"))
}

type deliveryScopeScript struct {
	deliveryUnexpectedScope
	mu                 sync.Mutex
	calls              map[string]int
	maxCalls           map[string]int
	observedAt         func(ctx context.Context) (time.Time, error)
	claim              func(ctx context.Context, limit int, at time.Time, tokens []string) ([]store.WebhookDelivery, error)
	lockExpired        func(ctx context.Context, limit int, at time.Time) ([]store.WebhookDelivery, error)
	lockDueExpiry      func(ctx context.Context, limit int, at time.Time) ([]store.WebhookDelivery, error)
	admissionSources   func(ctx context.Context, id string, at time.Time) (store.WebhookAdmissionSources, error)
	lockDelivery       func(ctx context.Context, id string) (store.WebhookDelivery, error)
	tryLockDelivery    func(ctx context.Context, id string) (store.WebhookDelivery, bool, error)
	lockAttempts       func(ctx context.Context, id string) ([]store.WebhookAttempt, error)
	lockOwnAttempt     func(ctx context.Context, id string) (store.WebhookAttempt, error)
	currentDestination func(ctx context.Context, id string, revision int64) (bool, error)
	lockWait           func(ctx context.Context, id string, revision int64) (store.WebhookEndpointWait, error)
	insertAttempt      func(ctx context.Context, a store.WebhookAttempt) error
	updateDelivery     func(ctx context.Context, d store.WebhookDelivery) error
	updateAttempt      func(ctx context.Context, a store.WebhookAttempt) error
	raiseWait          func(ctx context.Context, id string, revision int64, wait, at time.Time) error
	nextQueueOrder     func(ctx context.Context) (int64, error)
}

func (s *deliveryScopeScript) record(method string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.calls == nil {
		s.calls = make(map[string]int)
	}
	s.calls[method]++
	limit := 1
	if n, ok := s.maxCalls[method]; ok {
		limit = n
	}
	if s.calls[method] > limit {
		panic(s.unexpected(method + " beyond configured calls"))
	}
}

func (s *deliveryScopeScript) ObservedAt(ctx context.Context) (time.Time, error) {
	s.record("ObservedAt")
	if s.observedAt == nil {
		panic(s.unexpected("ObservedAt"))
	}
	return s.observedAt(ctx)
}

func (s *deliveryScopeScript) Claim(ctx context.Context, limit int, at time.Time, tokens []string) ([]store.WebhookDelivery, error) {
	s.record("Claim")
	if s.claim == nil {
		panic(s.unexpected("Claim"))
	}
	return s.claim(ctx, limit, at, tokens)
}

func (s *deliveryScopeScript) LockExpired(ctx context.Context, limit int, at time.Time) ([]store.WebhookDelivery, error) {
	s.record("LockExpired")
	if s.lockExpired == nil {
		panic(s.unexpected("LockExpired"))
	}
	return s.lockExpired(ctx, limit, at)
}

func (s *deliveryScopeScript) LockDueExpiry(ctx context.Context, limit int, at time.Time) ([]store.WebhookDelivery, error) {
	s.record("LockDueExpiry")
	if s.lockDueExpiry == nil {
		panic(s.unexpected("LockDueExpiry"))
	}
	return s.lockDueExpiry(ctx, limit, at)
}

func (s *deliveryScopeScript) AdmissionSources(ctx context.Context, id string, at time.Time) (store.WebhookAdmissionSources, error) {
	s.record("AdmissionSources")
	if s.admissionSources == nil {
		panic(s.unexpected("AdmissionSources"))
	}
	return s.admissionSources(ctx, id, at)
}

func (s *deliveryScopeScript) LockDelivery(ctx context.Context, id string) (store.WebhookDelivery, error) {
	s.record("LockDelivery")
	if s.lockDelivery == nil {
		panic(s.unexpected("LockDelivery"))
	}
	return s.lockDelivery(ctx, id)
}

func (s *deliveryScopeScript) TryLockDelivery(ctx context.Context, id string) (store.WebhookDelivery, bool, error) {
	s.record("TryLockDelivery")
	if s.tryLockDelivery == nil {
		panic(s.unexpected("TryLockDelivery"))
	}
	return s.tryLockDelivery(ctx, id)
}

func (s *deliveryScopeScript) LockAttempts(ctx context.Context, id string) ([]store.WebhookAttempt, error) {
	s.record("LockAttempts")
	if s.lockAttempts == nil {
		panic(s.unexpected("LockAttempts"))
	}
	return s.lockAttempts(ctx, id)
}

func (s *deliveryScopeScript) LockOwnAttempt(ctx context.Context, id string) (store.WebhookAttempt, error) {
	s.record("LockOwnAttempt")
	if s.lockOwnAttempt == nil {
		panic(s.unexpected("LockOwnAttempt"))
	}
	return s.lockOwnAttempt(ctx, id)
}

func (s *deliveryScopeScript) CurrentDestination(ctx context.Context, id string, revision int64) (bool, error) {
	s.record("CurrentDestination")
	if s.currentDestination == nil {
		panic(s.unexpected("CurrentDestination"))
	}
	return s.currentDestination(ctx, id, revision)
}

func (s *deliveryScopeScript) LockWait(ctx context.Context, id string, revision int64) (store.WebhookEndpointWait, error) {
	s.record("LockWait")
	if s.lockWait == nil {
		panic(s.unexpected("LockWait"))
	}
	return s.lockWait(ctx, id, revision)
}

func (s *deliveryScopeScript) InsertAttempt(ctx context.Context, a store.WebhookAttempt) error {
	s.record("InsertAttempt")
	if s.insertAttempt == nil {
		panic(s.unexpected("InsertAttempt"))
	}
	return s.insertAttempt(ctx, a)
}

func (s *deliveryScopeScript) UpdateDelivery(ctx context.Context, d store.WebhookDelivery) error {
	s.record("UpdateDelivery")
	if s.updateDelivery == nil {
		panic(s.unexpected("UpdateDelivery"))
	}
	return s.updateDelivery(ctx, d)
}

func (s *deliveryScopeScript) UpdateAttempt(ctx context.Context, a store.WebhookAttempt) error {
	s.record("UpdateAttempt")
	if s.updateAttempt == nil {
		panic(s.unexpected("UpdateAttempt"))
	}
	return s.updateAttempt(ctx, a)
}

func (s *deliveryScopeScript) RaiseWait(ctx context.Context, id string, revision int64, wait, at time.Time) error {
	s.record("RaiseWait")
	if s.raiseWait == nil {
		panic(s.unexpected("RaiseWait"))
	}
	return s.raiseWait(ctx, id, revision, wait, at)
}

func (s *deliveryScopeScript) NextQueueOrder(ctx context.Context) (int64, error) {
	s.record("NextQueueOrder")
	if s.nextQueueOrder == nil {
		panic(s.unexpected("NextQueueOrder"))
	}
	return s.nextQueueOrder(ctx)
}

type deliveryTransactionScript struct {
	t     testing.TB
	write func(context.Context, func(store.WebhookDeliveryScope) error) (store.Completion, error)
}

func (d deliveryTransactionScript) WriteWebhookDelivery(ctx context.Context, f func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	if d.write == nil {
		d.t.Errorf("unexpected delivery transaction")
		panic("unexpected delivery transaction")
	}
	return d.write(ctx, f)
}

func deliveryCommitted(t testing.TB, scope store.WebhookDeliveryScope) deliveryTransactionScript {
	t.Helper()
	return deliveryTransactionScript{t: t, write: func(_ context.Context, f func(store.WebhookDeliveryScope) error) (store.Completion, error) {
		if err := f(scope); err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}}
}
