package webhook

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

type receiptGCCall struct {
	method           string
	id               store.WebhookReceiptIdentity
	after            *store.WebhookReceiptIdentity
	limit            int
	candidates       []store.WebhookReceiptIdentity
	expires, now     time.Time
	present, removed bool
	err              error
	callback         bool
	callbackError    error
	completion       store.Completion
}

type receiptGCPlan struct {
	t     *testing.T
	ctx   context.Context
	calls []receiptGCCall
	next  int
}

func newReceiptGCPlan(t *testing.T, calls ...receiptGCCall) *receiptGCPlan {
	t.Helper()
	plan := &receiptGCPlan{t: t, ctx: t.Context(), calls: append([]receiptGCCall{}, calls...)}
	for i := range plan.calls {
		if after := plan.calls[i].after; after != nil {
			copied := *after
			plan.calls[i].after = &copied
		}
		if ids := plan.calls[i].candidates; ids != nil {
			plan.calls[i].candidates = append([]store.WebhookReceiptIdentity{}, ids...)
		}
	}
	t.Cleanup(func() { plan.checkPosition(len(plan.calls)) })
	return plan
}
func (p *receiptGCPlan) take(ctx context.Context, method string) receiptGCCall {
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
func (p *receiptGCPlan) checkPosition(want int) {
	p.t.Helper()
	if p.next != want {
		p.t.Fatalf("receipt collector consumed %d calls, want %d", p.next, want)
	}
}
func (p *receiptGCPlan) count(method string) int {
	n := 0
	for _, call := range p.calls[:p.next] {
		if call.method == method {
			n++
		}
	}
	return n
}
func (p *receiptGCPlan) checkIdentity(got, want store.WebhookReceiptIdentity) {
	p.t.Helper()
	if got != want {
		p.t.Fatalf("receipt identity=%+v, want %+v", got, want)
	}
}
func (p *receiptGCPlan) ExpiredWebhookReceipts(ctx context.Context, after *store.WebhookReceiptIdentity, limit int) ([]store.WebhookReceiptIdentity, error) {
	call := p.take(ctx, "scan")
	if !reflect.DeepEqual(after, call.after) || limit != call.limit {
		p.t.Fatalf("receipt scan after=%+v limit=%d, want after=%+v limit=%d", after, limit, call.after, call.limit)
	}
	return call.candidates, call.err
}
func (p *receiptGCPlan) WriteWebhookReceiptGC(ctx context.Context, id store.WebhookReceiptIdentity, fn func(store.WebhookReceiptGCScope) error) (store.Completion, error) {
	call := p.take(ctx, "write")
	p.checkIdentity(id, call.id)
	if call.callback {
		err := fn(p)
		if (call.callbackError == nil && err != nil) || (call.callbackError != nil && !errors.Is(err, call.callbackError)) {
			p.t.Fatalf("receipt callback error=%v, want cause %v", err, call.callbackError)
		}
	}
	return call.completion, call.err
}
func (p *receiptGCPlan) ObserveWebhookReceipt(ctx context.Context, id store.WebhookReceiptIdentity) (time.Time, bool, error) {
	call := p.take(ctx, "observe")
	p.checkIdentity(id, call.id)
	return call.expires, call.present, call.err
}
func (p *receiptGCPlan) ReceiptExpiry(ctx context.Context, id store.WebhookReceiptIdentity) (time.Time, time.Time, bool, error) {
	call := p.take(ctx, "expiry")
	p.checkIdentity(id, call.id)
	return call.expires, call.now, call.present, call.err
}
func (p *receiptGCPlan) DeleteReceipt(ctx context.Context, id store.WebhookReceiptIdentity) (bool, error) {
	call := p.take(ctx, "delete")
	p.checkIdentity(id, call.id)
	return call.removed, call.err
}
func receiptGCWriteCalls(id store.WebhookReceiptIdentity, expires, now time.Time, present, removed, wantDelete bool, completion store.Completion, writeErr error) []receiptGCCall {
	calls := []receiptGCCall{
		{method: "write", id: id, callback: true, completion: completion, err: writeErr},
		{method: "expiry", id: id, expires: expires, now: now, present: present},
	}
	if wantDelete {
		calls = append(calls, receiptGCCall{method: "delete", id: id, removed: removed})
	}
	return calls
}

func TestCollectExpiredReceipts(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name                   string
		delta                  time.Duration
		present, removed       bool
		outcome                store.TransactionOutcome
		writeErr               error
		wantCount, wantDeletes int
		wantErr                bool
	}{
		{"expired", -time.Nanosecond, true, true, store.TransactionCommitted, nil, 1, 1, false},
		{"boundary", 0, true, true, store.TransactionCommitted, nil, 1, 1, false},
		{"future", time.Nanosecond, true, true, store.TransactionCommitted, nil, 0, 0, false},
		{"already removed", -time.Hour, false, false, store.TransactionCommitted, nil, 0, 0, false},
		{"unknown commit", -time.Hour, true, true, store.TransactionUnknown, errors.New("commit response lost"), 0, 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			id := store.WebhookReceiptIdentity{}
			calls := []receiptGCCall{{method: "scan", limit: 1, candidates: []store.WebhookReceiptIdentity{id}}}
			s := newReceiptGCPlan(t, append(calls, receiptGCWriteCalls(id, now.Add(tc.delta), now, tc.present, tc.removed, tc.wantDeletes == 1, store.Completion{Outcome: tc.outcome}, tc.writeErr)...)...)
			count, completion, err := (&ReceiptCollector{}).Pass(s.ctx, s, 1)
			if count != tc.wantCount || s.count("delete") != tc.wantDeletes || (err != nil) != tc.wantErr || completion.Outcome != tc.outcome {
				t.Fatalf("count=%d deletes=%d completion=%+v err=%v", count, s.count("delete"), completion, err)
			}
			if tc.outcome == store.TransactionUnknown {
				var unknown *ReceiptGCUnknownError
				if !errors.As(err, &unknown) || unknown.Identity != id || !errors.Is(err, tc.writeErr) || s.count("observe") != 0 {
					t.Fatalf("unknown=%+v reads=%d err=%v", unknown, s.count("observe"), err)
				}
			}
		})
	}
	for _, limit := range []int{0, 501} {
		t.Run(fmt.Sprintf("limit %d", limit), func(t *testing.T) {
			s := newReceiptGCPlan(t)
			count, completion, err := (&ReceiptCollector{}).Pass(s.ctx, s, limit)
			if err == nil || count != 0 || completion.Outcome != store.TransactionNotCommitted {
				t.Fatalf("limit=%d count=%d completion=%+v err=%v", limit, count, completion, err)
			}
		})
	}
}

func TestReceiptCollectorEligibilityReceivers(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	id := store.WebhookReceiptIdentity{OperationID: "operation", Owner: webhook.Owner{Kind: "personal", ID: "owner"}}
	for _, tc := range []struct {
		name                string
		delta               time.Duration
		present, wantDelete bool
		outcome             store.TransactionOutcome
		wantCount           int
	}{
		{"expired", -time.Second, true, true, store.TransactionCommitted, 1},
		{"exact expiry", 0, true, true, store.TransactionCommitted, 1},
		{"future", time.Second, true, false, store.TransactionCommitted, 0},
		{"absent", -time.Second, false, false, store.TransactionCommitted, 0},
		{"fence busy", -time.Second, true, false, store.TransactionNotCommitted, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := []receiptGCCall{{method: "scan", limit: 125, candidates: []store.WebhookReceiptIdentity{id}}}
			if tc.name == "fence busy" {
				calls = append(calls, receiptGCCall{method: "write", id: id, completion: store.Completion{Outcome: store.TransactionNotCommitted}, err: store.ErrWebhookReceiptFenceBusy})
			} else {
				calls = append(calls, receiptGCWriteCalls(id, now.Add(tc.delta), now, tc.present, true, tc.wantDelete, store.Completion{Outcome: tc.outcome}, nil)...)
			}
			s := newReceiptGCPlan(t, calls...)
			count, completion, err := (&ReceiptCollector{}).Pass(s.ctx, s, 125)
			if err != nil || count != tc.wantCount || completion.Outcome != tc.outcome {
				t.Fatalf("eligibility count=%d completion=%+v err=%v", count, completion, err)
			}
		})
	}
}

func TestReceiptCollectorSharedBudget(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	ids := make([]store.WebhookReceiptIdentity, 125)
	for i := range ids {
		ids[i] = store.WebhookReceiptIdentity{OperationID: fmt.Sprint(i)}
	}
	calls := []receiptGCCall{{method: "scan", limit: 125, candidates: ids}}
	for _, id := range ids {
		calls = append(calls, receiptGCWriteCalls(id, now, now, true, true, true, store.Completion{Outcome: store.TransactionCommitted}, nil)...)
	}
	s := newReceiptGCPlan(t, calls...)
	count, completion, err := (&ReceiptCollector{}).Pass(s.ctx, s, 125)
	if err != nil || count != 125 || completion.Outcome != store.TransactionCommitted || s.count("write") != 125 || s.count("delete") != 125 {
		t.Fatalf("shared receipt budget count=%d completion=%+v err=%v", count, completion, err)
	}
}

func TestReceiptCollectorUnknownStateBridge(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	id := store.WebhookReceiptIdentity{OperationID: "original"}
	lost, offline := errors.New("private reply lost"), errors.New("readback unavailable")
	calls := []receiptGCCall{{method: "scan", limit: 125, candidates: []store.WebhookReceiptIdentity{id}}}
	calls = append(calls, receiptGCWriteCalls(id, now.Add(-time.Second), now, true, true, true, store.Completion{Outcome: store.TransactionUnknown}, lost)...)
	calls = append(calls,
		receiptGCCall{method: "observe", id: id, expires: time.Time{}, present: false, err: offline},
		receiptGCCall{method: "observe", id: id, expires: time.Time{}, present: false},
		receiptGCCall{method: "scan", after: &id, limit: 125},
	)
	s := newReceiptGCPlan(t, calls...)
	c := &ReceiptCollector{}
	count, completion, err := c.Pass(s.ctx, s, 125)
	var unknown *ReceiptGCUnknownError
	if count != 0 || completion.Outcome != store.TransactionUnknown || !errors.As(err, &unknown) || unknown.Identity != id || !errors.Is(err, lost) || c.unknown == nil || *c.unknown != id {
		t.Fatalf("unknown bridge count=%d completion=%+v err=%v pending=%+v", count, completion, err, c.unknown)
	}
	s.checkPosition(4)
	if err = c.Reconcile(s.ctx, s); !errors.As(err, &unknown) || unknown.Identity != id || !errors.Is(err, offline) || c.unknown == nil || *c.unknown != id {
		t.Fatalf("failed bridge readback err=%v pending=%+v", err, c.unknown)
	}
	s.checkPosition(5)
	if err = c.Reconcile(s.ctx, s); err != nil || c.unknown != nil {
		t.Fatalf("successful bridge readback err=%v pending=%+v", err, c.unknown)
	}
	s.checkPosition(6)
	count, completion, err = c.Pass(s.ctx, s, 125)
	if err != nil || count != 0 || completion.Outcome != store.TransactionNotCommitted || s.count("write") != 1 || s.count("observe") != 2 || s.count("scan") != 2 {
		t.Fatalf("bridge resumed count=%d completion=%+v err=%v", count, completion, err)
	}
}

func TestReceiptCollectorBusyCursorWrap(t *testing.T) {
	now := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	owner := webhook.Owner{Kind: "personal", ID: "owner"}
	first := store.WebhookReceiptIdentity{Owner: owner, OperationID: "00000000-0000-4000-8000-000000000001"}
	second := store.WebhookReceiptIdentity{Owner: owner, OperationID: "00000000-0000-4000-8000-000000000002"}
	calls := []receiptGCCall{
		{method: "scan", limit: 1, candidates: []store.WebhookReceiptIdentity{first}},
		{method: "write", id: first, completion: store.Completion{Outcome: store.TransactionNotCommitted}, err: store.ErrWebhookReceiptFenceBusy},
		{method: "scan", after: &first, limit: 1, candidates: []store.WebhookReceiptIdentity{second}},
	}
	calls = append(calls, receiptGCWriteCalls(second, now.Add(-24*time.Hour), now, true, true, true, store.Completion{Outcome: store.TransactionCommitted}, nil)...)
	calls = append(calls, receiptGCCall{method: "scan", after: &second, limit: 1}, receiptGCCall{method: "scan", limit: 1, candidates: []store.WebhookReceiptIdentity{first}})
	calls = append(calls, receiptGCWriteCalls(first, now.Add(-48*time.Hour), now, true, true, true, store.Completion{Outcome: store.TransactionCommitted}, nil)...)
	s := newReceiptGCPlan(t, calls...)
	c := &ReceiptCollector{}
	for _, want := range []struct {
		count, position int
		outcome         store.TransactionOutcome
	}{
		{0, 2, store.TransactionNotCommitted},
		{1, 6, store.TransactionCommitted},
		{0, 7, store.TransactionNotCommitted},
		{1, 11, store.TransactionCommitted},
	} {
		count, completion, err := c.Pass(s.ctx, s, 1)
		if err != nil || count != want.count || completion.Outcome != want.outcome {
			t.Fatalf("cursor pass count=%d completion=%+v err=%v", count, completion, err)
		}
		s.checkPosition(want.position)
	}
}
