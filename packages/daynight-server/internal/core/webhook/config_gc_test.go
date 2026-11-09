package webhook

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

type configGCCall struct {
	method        string
	candidate     store.WebhookConfigGCCandidate
	after         *store.WebhookConfigGCCandidate
	limit         int
	barrier       string
	scan          store.WebhookConfigGCScan
	facts         store.WebhookConfigGCFacts
	result        bool
	err           error
	callback      bool
	callbackError error
	completion    store.Completion
}

type configGCPlan struct {
	t     *testing.T
	ctx   context.Context
	calls []configGCCall
	next  int
}

func newConfigGCPlan(t *testing.T, calls ...configGCCall) *configGCPlan {
	t.Helper()
	p := &configGCPlan{t: t, ctx: t.Context(), calls: calls}
	t.Cleanup(func() { p.checkPosition(len(p.calls)) })
	return p
}
func (p *configGCPlan) take(ctx context.Context, method string) configGCCall {
	p.t.Helper()
	if ctx != p.ctx {
		p.t.Fatalf("%s replaced collector context", method)
	}
	if p.next >= len(p.calls) || p.calls[p.next].method != method {
		p.t.Fatalf("unexpected %s at call %d: plan=%+v", method, p.next, p.calls)
	}
	call := p.calls[p.next]
	p.next++
	return call
}
func (p *configGCPlan) checkPosition(want int) {
	p.t.Helper()
	if p.next != want {
		p.t.Fatalf("collector consumed %d calls, want %d", p.next, want)
	}
}
func (p *configGCPlan) count(method string) int {
	n := 0
	for _, call := range p.calls[:p.next] {
		if call.method == method {
			n++
		}
	}
	return n
}
func (p *configGCPlan) checkCandidate(got, want store.WebhookConfigGCCandidate) {
	p.t.Helper()
	if got != want {
		p.t.Fatalf("collector candidate=%+v, want %+v", got, want)
	}
}
func (p *configGCPlan) ScanWebhookConfigGC(ctx context.Context, after *store.WebhookConfigGCCandidate, limit int) (store.WebhookConfigGCScan, error) {
	call := p.take(ctx, "scan")
	if !reflect.DeepEqual(after, call.after) || limit != call.limit {
		p.t.Fatalf("scan after=%+v limit=%d, want after=%+v limit=%d", after, limit, call.after, call.limit)
	}
	return call.scan, call.err
}
func (p *configGCPlan) WebhookConfigGCBarrierPassed(ctx context.Context, barrier string) (bool, error) {
	call := p.take(ctx, "barrier")
	if barrier != call.barrier {
		p.t.Fatalf("barrier=%q, want %q", barrier, call.barrier)
	}
	return call.result, call.err
}
func (p *configGCPlan) WriteWebhookConfigGC(ctx context.Context, candidate store.WebhookConfigGCCandidate, fn func(store.WebhookConfigGCScope) error) (store.Completion, error) {
	call := p.take(ctx, "write")
	p.checkCandidate(candidate, call.candidate)
	if call.callback {
		err := fn(p)
		if (call.callbackError == nil && err != nil) || (call.callbackError != nil && !errors.Is(err, call.callbackError)) {
			p.t.Fatalf("write callback error=%v, want cause %v", err, call.callbackError)
		}
	}
	return call.completion, call.err
}
func (p *configGCPlan) ObserveWebhookConfigGC(ctx context.Context, candidate store.WebhookConfigGCCandidate) (bool, error) {
	call := p.take(ctx, "observe")
	p.checkCandidate(candidate, call.candidate)
	return call.result, call.err
}
func (p *configGCPlan) LockConfigCandidate(ctx context.Context, candidate store.WebhookConfigGCCandidate) (store.WebhookConfigGCFacts, error) {
	call := p.take(ctx, "lock")
	p.checkCandidate(candidate, call.candidate)
	return call.facts, call.err
}
func (p *configGCPlan) DeleteConfigCandidate(ctx context.Context, candidate store.WebhookConfigGCCandidate) (bool, error) {
	call := p.take(ctx, "delete")
	p.checkCandidate(candidate, call.candidate)
	return call.result, call.err
}

func TestConfigCollectorBarrierAndUnknown(t *testing.T) {
	id := store.WebhookConfigGCCandidate{Kind: "binding", ID: "first"}
	offline := errors.New("offline")
	s := newConfigGCPlan(t,
		configGCCall{method: "scan", limit: 1, scan: store.WebhookConfigGCScan{Barrier: "10", Candidates: []store.WebhookConfigGCCandidate{id}}},
		configGCCall{method: "barrier", barrier: "10", result: false},
		configGCCall{method: "barrier", barrier: "10", result: true},
		configGCCall{method: "write", candidate: id, callback: true, completion: store.Completion{Outcome: store.TransactionUnknown}},
		configGCCall{method: "lock", candidate: id, facts: store.WebhookConfigGCFacts{Present: true, Retired: true}},
		configGCCall{method: "delete", candidate: id, result: true},
		configGCCall{method: "observe", candidate: id, result: true, err: offline},
		configGCCall{method: "observe", candidate: id, result: true},
		configGCCall{method: "scan", after: &id, limit: 1},
	)
	c := &ConfigCollector{}
	n, err := c.Pass(s.ctx, s, 1)
	if err != nil || n != 0 {
		t.Fatalf("pending: %d %v", n, err)
	}
	s.checkPosition(2)
	n, err = c.Pass(s.ctx, s, 1)
	var unknown *ConfigGCUnknownError
	if n != 0 || !errors.As(err, &unknown) || unknown.Identity != id || unknown.Cause != nil {
		t.Fatalf("unknown: %d %v", n, err)
	}
	s.checkPosition(6)
	n, err = c.Pass(s.ctx, s, 1)
	if n != 0 || !errors.As(err, &unknown) || unknown.Identity != id || !errors.Is(err, offline) {
		t.Fatalf("unreadable: %d %v", n, err)
	}
	s.checkPosition(7)
	n, err = c.Pass(s.ctx, s, 1)
	if err != nil || n != 0 {
		t.Fatalf("observed: %d %v", n, err)
	}
	s.checkPosition(9)
	if s.count("write") != 1 || s.count("observe") != 2 || s.count("scan") != 2 || s.count("barrier") != 2 {
		t.Fatalf("unknown reconciliation calls=%+v", s.calls[:s.next])
	}
}

func configGCCandidate(kind string) store.WebhookConfigGCCandidate {
	c := store.WebhookConfigGCCandidate{Order: 1, Kind: kind, ID: uuid.NewString(), EndpointID: uuid.NewString(), Owner: webhook.Owner{Kind: "personal", ID: uuid.NewString()}}
	if kind == "binding" {
		c.Order, c.ProjectID = 2, uuid.NewString()
	}
	return c
}
func configGCCommittedCalls(candidate store.WebhookConfigGCCandidate, facts store.WebhookConfigGCFacts) []configGCCall {
	return []configGCCall{
		{method: "write", candidate: candidate, callback: true, completion: store.Completion{Outcome: store.TransactionCommitted}},
		{method: "lock", candidate: candidate, facts: facts},
		{method: "delete", candidate: candidate, result: true},
	}
}
func TestConfigCollectorDecisionReceivers(t *testing.T) {
	t.Run("expired key", func(t *testing.T) {
		candidate := configGCCandidate("key")
		now := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
		start := now.Add(-48 * time.Hour)
		facts := store.WebhookConfigGCFacts{Present: true, Retired: true, Expiry: start.Add(24 * time.Hour), ObservedAt: now}
		calls := []configGCCall{
			{method: "scan", limit: 1, scan: store.WebhookConfigGCScan{Barrier: "10", Candidates: []store.WebhookConfigGCCandidate{candidate}}},
			{method: "barrier", barrier: "10", result: true},
		}
		s := newConfigGCPlan(t, append(calls, configGCCommittedCalls(candidate, facts)...)...)
		n, err := (&ConfigCollector{}).Pass(s.ctx, s, 1)
		if n != 1 || err != nil {
			t.Fatalf("expired key removed=%d err=%v", n, err)
		}
	})
	t.Run("pending barrier", func(t *testing.T) {
		candidate := configGCCandidate("binding")
		calls := []configGCCall{
			{method: "scan", limit: 1, scan: store.WebhookConfigGCScan{Barrier: "10", Candidates: []store.WebhookConfigGCCandidate{candidate}}},
			{method: "barrier", barrier: "10", result: false},
			{method: "barrier", barrier: "10", result: true},
		}
		s := newConfigGCPlan(t, append(calls, configGCCommittedCalls(candidate, store.WebhookConfigGCFacts{Present: true, Retired: true})...)...)
		c := &ConfigCollector{}
		n, err := c.Pass(s.ctx, s, 1)
		if n != 0 || err != nil {
			t.Fatalf("pending barrier removed=%d err=%v", n, err)
		}
		s.checkPosition(2)
		n, err = c.Pass(s.ctx, s, 1)
		if n != 1 || err != nil {
			t.Fatalf("passed barrier removed=%d err=%v", n, err)
		}
	})
	for _, lockKind := range []string{"endpoint", "project"} {
		t.Run("busy "+lockKind, func(t *testing.T) {
			first, second := configGCCandidate("binding"), configGCCandidate("binding")
			first.ID = "00000000-0000-4000-8000-000000000001"
			second.ID = "00000000-0000-4000-8000-000000000002"
			cause := errors.New("busy " + lockKind)
			busy := &store.Error{DatabaseFailure: true, SQLState: "55P03", Cause: cause}
			write := configGCCall{method: "write", candidate: first, completion: store.Completion{Outcome: store.TransactionNotCommitted}, err: busy}
			calls := []configGCCall{
				{method: "scan", limit: 2, scan: store.WebhookConfigGCScan{Barrier: "10", Candidates: []store.WebhookConfigGCCandidate{first, second}}},
				{method: "barrier", barrier: "10", result: true},
			}
			if lockKind == "endpoint" {
				write.callback, write.callbackError = true, busy
				calls = append(calls, write, configGCCall{method: "lock", candidate: first, err: busy})
			} else {
				calls = append(calls, write)
			}
			s := newConfigGCPlan(t, append(calls, configGCCommittedCalls(second, store.WebhookConfigGCFacts{Present: true, Retired: true})...)...)
			n, err := (&ConfigCollector{}).Pass(s.ctx, s, 2)
			if n != 1 || err != nil {
				t.Fatalf("skip busy %s removed=%d err=%v", lockKind, n, err)
			}
		})
	}
}
