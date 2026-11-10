package webhook

import (
	"context"
	"errors"
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
		s.(*retentionScopeMock).t.Errorf("unexpected successful history callback error: %v", err)
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

// Each queued activation describes one driver call, including history calls that
// share the collector context. The plan does not model collector state or storage.
type retentionCollectorOperation struct {
	name       string
	rows       int
	completion store.Completion
	err        error
	invoke     func(context.Context) (int, store.Completion, error)
}
type retentionCollectorActivation struct {
	calls []retentionCollectorOperation
	next  int
	ctx   context.Context
}
type retentionCollectorPlan struct {
	t           *testing.T
	mu          sync.Mutex
	db          *retentionStoreMock
	activations []*retentionCollectorActivation
	history     func(context.Context, func(store.WebhookRetentionScope) error) (store.Completion, error)
}

func (p *retentionCollectorPlan) queue(calls ...retentionCollectorOperation) {
	p.t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(calls) == 0 {
		p.t.Fatal("empty retention activation plan")
	}
	p.activations = append(p.activations, &retentionCollectorActivation{calls: append([]retentionCollectorOperation(nil), calls...)})
}
func (p *retentionCollectorPlan) take(ctx context.Context, db any, name string) (retentionCollectorOperation, error) {
	p.t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	unexpected := func(reason string) (retentionCollectorOperation, error) {
		err := fmt.Errorf("unexpected retention operation %s: %s", name, reason)
		p.t.Error(err)
		return retentionCollectorOperation{}, err
	}
	if len(p.activations) == 0 {
		return unexpected("no queued activation")
	}
	activation := p.activations[0]
	if activation.calls[activation.next].name != name {
		return unexpected(fmt.Sprintf("want %s", activation.calls[activation.next].name))
	}
	if ctx == nil || ctx.Done() == nil || db != p.db {
		return unexpected("context/store identity")
	}
	if activation.ctx == nil {
		activation.ctx = ctx
	} else if ctx != activation.ctx {
		return unexpected("replaced activation context")
	}
	call := activation.calls[activation.next]
	activation.next++
	if activation.next == len(activation.calls) {
		p.activations = p.activations[1:]
	}
	return call, nil
}
func (p *retentionCollectorPlan) result(ctx context.Context, db any, name string) (int, store.Completion, error) {
	call, err := p.take(ctx, db, name)
	if err != nil {
		return 0, store.Completion{}, err
	}
	if call.invoke != nil {
		return call.invoke(ctx)
	}
	return call.rows, call.completion, call.err
}
func (p *retentionCollectorPlan) consumed() {
	p.t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.activations) != 0 {
		p.t.Errorf("retention has %d unconsumed activations; next calls=%+v", len(p.activations), p.activations[0].calls[p.activations[0].next:])
	}
}
func retentionOperation(name string) retentionCollectorOperation {
	return retentionCollectorOperation{name: name}
}
func retentionConfigResult(rows int, err error) retentionCollectorOperation {
	return retentionCollectorOperation{name: "config.pass", rows: rows, err: err}
}
func retentionReceiptResult(rows int, completion store.Completion, err error) retentionCollectorOperation {
	return retentionCollectorOperation{name: "receipt.pass", rows: rows, completion: completion, err: err}
}
func retentionPassCalls(configRows, receiptRows int, classes ...string) []retentionCollectorOperation {
	calls := []retentionCollectorOperation{retentionOperation("receipt.reconcile"), retentionOperation("config.reconcile")}
	for _, class := range classes {
		switch class {
		case "config":
			calls = append(calls, retentionConfigResult(configRows, nil))
		case "receipt":
			calls = append(calls, retentionReceiptResult(receiptRows, store.Completion{Outcome: store.TransactionCommitted}, nil))
		case "history":
			calls = append(calls, retentionOperation("history.write"))
		default:
			panic("invalid retention test class: " + class)
		}
	}
	return calls
}

type retentionConfigCollectorMock struct{ plan *retentionCollectorPlan }

func (m *retentionConfigCollectorMock) Reconcile(ctx context.Context, db store.WebhookConfigGC) error {
	_, _, err := m.plan.result(ctx, db, "config.reconcile")
	return err
}
func (m *retentionConfigCollectorMock) Pass(ctx context.Context, db store.WebhookConfigGC, budget int) (int, error) {
	if budget != 125 {
		m.plan.t.Errorf("config budget=%d, want 125", budget)
	}
	n, _, err := m.plan.result(ctx, db, "config.pass")
	return n, err
}

type retentionReceiptCollectorMock struct{ plan *retentionCollectorPlan }

func (m *retentionReceiptCollectorMock) Reconcile(ctx context.Context, db store.WebhookReceiptGC) error {
	_, _, err := m.plan.result(ctx, db, "receipt.reconcile")
	return err
}
func (m *retentionReceiptCollectorMock) Pass(ctx context.Context, db store.WebhookReceiptGC, budget int) (int, store.Completion, error) {
	if budget != 125 {
		m.plan.t.Errorf("receipt budget=%d, want 125", budget)
	}
	return m.plan.result(ctx, db, "receipt.pass")
}
func retentionWithCollectors(t *testing.T, db *retentionStoreMock) (*Retention, *retentionCollectorPlan) {
	t.Helper()
	r := NewRetention(db)
	if collector, ok := r.config.(*core.ConfigCollector); !ok || collector == nil {
		t.Fatal("retention constructor did not bind its stateful config collector")
	}
	if collector, ok := r.receipts.(*core.ReceiptCollector); !ok || collector == nil {
		t.Fatal("retention constructor did not bind its stateful receipt collector")
	}
	db.scanConfig, db.configBarrier, db.writeConfig, db.observeConfig = nil, nil, nil, nil
	db.expiredReceipts, db.writeReceipt, db.observeReceipt = nil, nil, nil
	p := &retentionCollectorPlan{t: t, db: db, history: db.writeHistory}
	config, receipts := &retentionConfigCollectorMock{plan: p}, &retentionReceiptCollectorMock{plan: p}
	r.config, r.receipts = config, receipts
	db.writeHistory = func(ctx context.Context, fn func(store.WebhookRetentionScope) error) (store.Completion, error) {
		if _, err := p.take(ctx, db, "history.write"); err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return retentionRequire(t, "controlled history.write", p.history, p.history != nil)(ctx, fn)
	}
	observe := db.observeHistory
	db.observeHistory = func(ctx context.Context, kind, id string) error {
		call, err := p.take(ctx, db, "history.observe")
		if err != nil {
			return err
		}
		if call.err != nil {
			return call.err
		}
		return retentionRequire(t, "controlled history.observe", observe, observe != nil)(ctx, kind, id)
	}
	t.Cleanup(func() {
		p.consumed()
		if r.config != config || r.receipts != receipts {
			t.Error("retention replaced its per-instance collector operations")
		}
	})
	return r, p
}
func retentionExpectCallback(t *testing.T, callback error, wantError bool, cause error) {
	t.Helper()
	if (callback != nil) != wantError {
		t.Errorf("history callback error=%v wantError=%v", callback, wantError)
	}
	if cause != nil && !errors.Is(callback, cause) {
		t.Errorf("history callback lost expected cause: %v", callback)
	}
}

var _ retentionStore = (*retentionStoreMock)(nil)
var _ store.WebhookRetentionScope = (*retentionScopeMock)(nil)
var _ configCollector = (*retentionConfigCollectorMock)(nil)
var _ receiptCollector = (*retentionReceiptCollectorMock)(nil)
