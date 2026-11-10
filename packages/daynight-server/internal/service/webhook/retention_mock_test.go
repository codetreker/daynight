package webhook

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
)

var retentionTestNow = time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

type retentionStoreMock struct {
	t               *testing.T
	mu              sync.Mutex
	calls           []string
	scanConfig      func(context.Context, *store.WebhookConfigGCCandidate, int) (store.WebhookConfigGCScan, error)
	configBarrier   func(context.Context, string) (bool, error)
	writeConfig     func(context.Context, store.WebhookConfigGCCandidate, func(store.WebhookConfigGCScope) error) (store.Completion, error)
	observeConfig   func(context.Context, store.WebhookConfigGCCandidate) (bool, error)
	expiredReceipts func(context.Context, *store.WebhookReceiptIdentity, int) ([]store.WebhookReceiptIdentity, error)
	writeReceipt    func(context.Context, store.WebhookReceiptIdentity, func(store.WebhookReceiptGCScope) error) (store.Completion, error)
	observeReceipt  func(context.Context, store.WebhookReceiptIdentity) (time.Time, bool, error)
	writeHistory    func(context.Context, func(store.WebhookRetentionScope) error) (store.Completion, error)
	observeHistory  func(context.Context, string, string) error
}

func retentionRequire[T any](t *testing.T, name string, fn T, configured bool) T {
	t.Helper()
	if !configured {
		t.Errorf("unexpected retention DAO call: %s", name)
		panic("unexpected retention DAO call: " + name)
	}
	return fn
}
func (m *retentionStoreMock) record(name string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, name)
}
func (m *retentionStoreMock) recorded() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.calls...)
}
func (m *retentionStoreMock) ScanWebhookConfigGC(c context.Context, a *store.WebhookConfigGCCandidate, n int) (store.WebhookConfigGCScan, error) {
	m.record("config.scan")
	return retentionRequire(m.t, "config.scan", m.scanConfig, m.scanConfig != nil)(c, a, n)
}
func (m *retentionStoreMock) WebhookConfigGCBarrierPassed(c context.Context, b string) (bool, error) {
	m.record("config.barrier")
	return retentionRequire(m.t, "config.barrier", m.configBarrier, m.configBarrier != nil)(c, b)
}
func (m *retentionStoreMock) WriteWebhookConfigGC(c context.Context, a store.WebhookConfigGCCandidate, f func(store.WebhookConfigGCScope) error) (store.Completion, error) {
	m.record("config.write")
	return retentionRequire(m.t, "config.write", m.writeConfig, m.writeConfig != nil)(c, a, f)
}
func (m *retentionStoreMock) ObserveWebhookConfigGC(c context.Context, a store.WebhookConfigGCCandidate) (bool, error) {
	m.record("config.observe")
	return retentionRequire(m.t, "config.observe", m.observeConfig, m.observeConfig != nil)(c, a)
}
func (m *retentionStoreMock) ExpiredWebhookReceipts(c context.Context, a *store.WebhookReceiptIdentity, n int) ([]store.WebhookReceiptIdentity, error) {
	m.record("receipt.scan")
	return retentionRequire(m.t, "receipt.scan", m.expiredReceipts, m.expiredReceipts != nil)(c, a, n)
}
func (m *retentionStoreMock) WriteWebhookReceiptGC(c context.Context, a store.WebhookReceiptIdentity, f func(store.WebhookReceiptGCScope) error) (store.Completion, error) {
	m.record("receipt.write")
	return retentionRequire(m.t, "receipt.write", m.writeReceipt, m.writeReceipt != nil)(c, a, f)
}
func (m *retentionStoreMock) ObserveWebhookReceipt(c context.Context, a store.WebhookReceiptIdentity) (time.Time, bool, error) {
	m.record("receipt.observe")
	return retentionRequire(m.t, "receipt.observe", m.observeReceipt, m.observeReceipt != nil)(c, a)
}
func (m *retentionStoreMock) WriteWebhookRetention(c context.Context, f func(store.WebhookRetentionScope) error) (store.Completion, error) {
	m.record("history.write")
	return retentionRequire(m.t, "history.write", m.writeHistory, m.writeHistory != nil)(c, f)
}
func (m *retentionStoreMock) ObserveWebhookRetention(c context.Context, k, id string) error {
	m.record("history.observe")
	return retentionRequire(m.t, "history.observe", m.observeHistory, m.observeHistory != nil)(c, k, id)
}

type retentionScopeMock struct {
	t         *testing.T
	calls     []string
	now       func(context.Context) (time.Time, error)
	candidate func(context.Context, string, time.Time) (store.WebhookDelivery, bool, error)
	attempts  func(context.Context, string) ([]store.WebhookAttempt, error)
	seconds   func(context.Context, int64) (int, error)
	extend    func(context.Context, string, time.Time, time.Time) (int, error)
	close     func(context.Context, string, time.Time) (int, error)
	children  func(context.Context, string, int) (int, error)
	delivery  func(context.Context, string) (int, error)
	orphan    func(context.Context) (string, int, error)
	fact      func(context.Context) (string, int, error)
	payload   func(context.Context, string, time.Time) (int, error)
}

func (m *retentionScopeMock) ObservedAt(c context.Context) (time.Time, error) {
	m.calls = append(m.calls, "time")
	return retentionRequire(m.t, "ObservedAt", m.now, m.now != nil)(c)
}
func (m *retentionScopeMock) LockRetentionCandidate(c context.Context, p string, a time.Time) (store.WebhookDelivery, bool, error) {
	m.calls = append(m.calls, "candidate."+p)
	return retentionRequire(m.t, "LockRetentionCandidate", m.candidate, m.candidate != nil)(c, p, a)
}
func (m *retentionScopeMock) LockAttempts(c context.Context, id string) ([]store.WebhookAttempt, error) {
	m.calls = append(m.calls, "attempts")
	return retentionRequire(m.t, "LockAttempts", m.attempts, m.attempts != nil)(c, id)
}
func (m *retentionScopeMock) RetentionSeconds(c context.Context, v int64) (int, error) {
	m.calls = append(m.calls, "policy")
	return retentionRequire(m.t, "RetentionSeconds", m.seconds, m.seconds != nil)(c, v)
}
func (m *retentionScopeMock) ExtendRetention(c context.Context, id string, a, b time.Time) (int, error) {
	m.calls = append(m.calls, "extend")
	return retentionRequire(m.t, "ExtendRetention", m.extend, m.extend != nil)(c, id, a, b)
}
func (m *retentionScopeMock) CloseRetention(c context.Context, id string, a time.Time) (int, error) {
	m.calls = append(m.calls, "close")
	return retentionRequire(m.t, "CloseRetention", m.close, m.close != nil)(c, id, a)
}
func (m *retentionScopeMock) DeleteRetentionChildren(c context.Context, id string, n int) (int, error) {
	m.calls = append(m.calls, "children")
	return retentionRequire(m.t, "DeleteRetentionChildren", m.children, m.children != nil)(c, id, n)
}
func (m *retentionScopeMock) DeleteRetainedDelivery(c context.Context, id string) (int, error) {
	m.calls = append(m.calls, "delivery")
	return retentionRequire(m.t, "DeleteRetainedDelivery", m.delivery, m.delivery != nil)(c, id)
}
func (m *retentionScopeMock) DeleteUnreferencedEvent(c context.Context) (string, int, error) {
	m.calls = append(m.calls, "orphan")
	return retentionRequire(m.t, "DeleteUnreferencedEvent", m.orphan, m.orphan != nil)(c)
}
func (m *retentionScopeMock) ClearExpiredEvent(c context.Context) (string, int, error) {
	m.calls = append(m.calls, "fact")
	return retentionRequire(m.t, "ClearExpiredEvent", m.fact, m.fact != nil)(c)
}
func (m *retentionScopeMock) RemoveExpiredPayload(c context.Context, id string, a time.Time) (int, error) {
	m.calls = append(m.calls, "payload")
	return retentionRequire(m.t, "RemoveExpiredPayload", m.payload, m.payload != nil)(c, id, a)
}

func retentionEmptyScope(t *testing.T) *retentionScopeMock {
	return &retentionScopeMock{t: t,
		now: func(context.Context) (time.Time, error) { return retentionTestNow, nil },
		candidate: func(_ context.Context, _ string, a time.Time) (store.WebhookDelivery, bool, error) {
			if !a.Equal(retentionTestNow) {
				t.Errorf("candidate time=%v", a)
			}
			return store.WebhookDelivery{}, false, nil
		},
		orphan: func(context.Context) (string, int, error) { return "", 0, nil },
		fact:   func(context.Context) (string, int, error) { return "", 0, nil },
	}
}
func retentionEmptyStore(t *testing.T) *retentionStoreMock {
	m := &retentionStoreMock{t: t,
		scanConfig: func(_ context.Context, _ *store.WebhookConfigGCCandidate, n int) (store.WebhookConfigGCScan, error) {
			if n < 1 || n > 125 {
				t.Errorf("config budget=%d", n)
			}
			return store.WebhookConfigGCScan{}, nil
		},
		expiredReceipts: func(_ context.Context, _ *store.WebhookReceiptIdentity, n int) ([]store.WebhookReceiptIdentity, error) {
			if n < 1 || n > 125 {
				t.Errorf("receipt budget=%d", n)
			}
			return nil, nil
		},
	}
	m.writeHistory = func(_ context.Context, f func(store.WebhookRetentionScope) error) (store.Completion, error) {
		return retentionCallback(f, retentionEmptyScope(t))
	}
	return m
}
func retentionCallback(f func(store.WebhookRetentionScope) error, s store.WebhookRetentionScope) (store.Completion, error) {
	if err := f(s); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func retentionCandidateScope(t *testing.T, phase string, d store.WebhookDelivery) *retentionScopeMock {
	s := retentionEmptyScope(t)
	s.candidate = func(_ context.Context, p string, a time.Time) (store.WebhookDelivery, bool, error) {
		if !a.Equal(retentionTestNow) {
			t.Errorf("candidate observation=%v", a)
		}
		if p == phase {
			return d, true, nil
		}
		return store.WebhookDelivery{}, false, nil
	}
	return s
}
func retentionDeliveryFixture() store.WebhookDelivery {
	return store.WebhookDelivery{ID: "11111111-1111-4111-8111-111111111111", EventID: "22222222-2222-4222-8222-222222222222", EndpointID: "33333333-3333-4333-8333-333333333333", ProjectID: "44444444-4444-4444-8444-444444444444", Owner: Owner{Kind: "personal", ID: "55555555-5555-4555-8555-555555555555"}, State: "failed", Trigger: "automatic", Generation: 1, AdapterVersion: 1, PolicyVersion: 1, OccurredAt: retentionTestNow.Add(-40 * 24 * time.Hour), LastActivityAt: retentionTestNow.Add(-40 * 24 * time.Hour), MetadataExpiresAt: retentionTestNow.Add(-10 * 24 * time.Hour), PayloadExpiresAt: retentionTestNow.Add(-33 * 24 * time.Hour)}
}
func retentionFail(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func retentionAssertCallOrder(t *testing.T, calls []string, want ...string) {
	t.Helper()
	if fmt.Sprint(calls) != fmt.Sprint(want) {
		t.Fatalf("DAO calls=%v want=%v", calls, want)
	}
}

type retentionConfigCollectorMock struct {
	t         *testing.T
	mu        sync.Mutex
	db        store.WebhookConfigGC
	ctx       context.Context
	want      []string
	next      int
	reconcile func(context.Context, store.WebhookConfigGC) error
	pass      func(context.Context, store.WebhookConfigGC, int) (int, error)
}

func (m *retentionConfigCollectorMock) unexpected(method string) error {
	m.t.Helper()
	m.t.Errorf("unexpected config collector call: %s", method)
	return fmt.Errorf("unexpected config collector call: %s", method)
}

func (m *retentionConfigCollectorMock) call(ctx context.Context, db store.WebhookConfigGC, method string) error {
	m.t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.next >= len(m.want) || m.want[m.next] != method {
		return m.unexpected(method)
	}
	if ctx == nil || db != m.db {
		return m.unexpected(method + " context/store")
	}
	if method == "reconcile" {
		m.ctx = ctx
	} else if ctx != m.ctx {
		return m.unexpected(method + " replaced context")
	}
	m.next++
	return nil
}

func (m *retentionConfigCollectorMock) Reconcile(ctx context.Context, db store.WebhookConfigGC) error {
	if err := m.call(ctx, db, "reconcile"); err != nil {
		return err
	}
	if m.reconcile == nil {
		return m.unexpected("unconfigured Reconcile")
	}
	return m.reconcile(ctx, db)
}

func (m *retentionConfigCollectorMock) Pass(ctx context.Context, db store.WebhookConfigGC, budget int) (int, error) {
	if err := m.call(ctx, db, "pass"); err != nil {
		return 0, err
	}
	if budget != 125 {
		return 0, m.unexpected(fmt.Sprintf("Pass budget %d, want 125", budget))
	}
	if m.pass == nil {
		return 0, m.unexpected("unconfigured Pass")
	}
	return m.pass(ctx, db, budget)
}

func retentionWithConfigCollector(t *testing.T, db *retentionStoreMock, calls []string, pass func(context.Context, store.WebhookConfigGC, int) (int, error)) *Retention {
	t.Helper()
	r := NewRetention(db)
	if collector, ok := r.config.(*core.ConfigCollector); !ok || collector == nil {
		t.Fatal("retention constructor did not bind its stateful config collector")
	}
	db.scanConfig, db.configBarrier, db.writeConfig, db.observeConfig = nil, nil, nil, nil
	m := &retentionConfigCollectorMock{t: t, db: db, want: append([]string(nil), calls...), pass: pass,
		reconcile: func(context.Context, store.WebhookConfigGC) error { return nil },
	}
	t.Cleanup(func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.next != len(m.want) {
			t.Errorf("config collector consumed %d calls, want %v", m.next, m.want)
		}
	})
	r.config = m
	return r
}

var _ retentionStore = (*retentionStoreMock)(nil)
var _ store.WebhookRetentionScope = (*retentionScopeMock)(nil)
