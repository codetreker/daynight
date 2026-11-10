package server

import (
	"bytes"
	"context"
	"encoding/json"
	"reflect"
	"sync"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	webhookcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	webhookhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

type webhookHTTPCall struct {
	method   string
	owner    webhookhttp.Owner
	endpoint string
	list     webhookhttp.ListQuery
	mutation webhookhttp.Mutation
	history  webhookservice.DeliveryQuery
	body     json.RawMessage
	err      error
}

// Each response is a supplied business fact, independent of previous requests.
type webhookHTTPPlans struct {
	t         *testing.T
	principal model.Principal
	mu        sync.Mutex
	calls     []webhookHTTPCall
}

func (p *webhookHTTPPlans) add(call webhookHTTPCall) {
	p.t.Helper()
	call.body = bytes.Clone(call.body)
	call.mutation = cloneWebhookHTTPMutation(call.mutation)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls = append(p.calls, call)
}

func (p *webhookHTTPPlans) take(ctx context.Context, principal model.Principal, method string) webhookHTTPCall {
	p.t.Helper()
	requireExactOperationHTTPContext(p.t, ctx)
	p.mu.Lock()
	defer p.mu.Unlock()
	if principal != p.principal || len(p.calls) == 0 || p.calls[0].method != method {
		unexpectedHTTPCall(p.t, "Webhook."+method)
	}
	call := p.calls[0]
	p.calls = p.calls[1:]
	call.body = bytes.Clone(call.body)
	return call
}

func (p *webhookHTTPPlans) equal(got, want any, argument string) {
	p.t.Helper()
	if !reflect.DeepEqual(got, want) {
		p.t.Errorf("Webhook %s: got %#v, want %#v", argument, got, want)
		panic("Webhook operation arguments differ")
	}
}

func (p *webhookHTTPPlans) verify() {
	p.t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.calls) != 0 {
		p.t.Errorf("%d Webhook operations were not called", len(p.calls))
	}
}

func (p *webhookHTTPPlans) Catalog(ctx context.Context, principal model.Principal) (any, error) {
	call := p.take(ctx, principal, "Catalog")
	return call.body, call.err
}
func (p *webhookHTTPPlans) List(ctx context.Context, principal model.Principal, owner webhookhttp.Owner, query webhookhttp.ListQuery) (any, error) {
	call := p.take(ctx, principal, "List")
	p.equal(owner, call.owner, "list owner")
	p.equal(query, call.list, "list query")
	return call.body, call.err
}
func (p *webhookHTTPPlans) Get(ctx context.Context, principal model.Principal, owner webhookhttp.Owner, endpoint string) (any, error) {
	call := p.take(ctx, principal, "Get")
	p.equal(owner, call.owner, "get owner")
	p.equal(endpoint, call.endpoint, "get endpoint")
	return call.body, call.err
}
func (p *webhookHTTPPlans) Mutate(ctx context.Context, principal model.Principal, owner webhookhttp.Owner, mutation webhookhttp.Mutation) (webhookhttp.MutationResult, error) {
	call := p.take(ctx, principal, "Mutate")
	p.equal(owner, call.owner, "mutation owner")
	p.equal(mutation, call.mutation, "complete mutation")
	return webhookhttp.MutationResult{Body: call.body, Replay: false}, call.err
}
func (p *webhookHTTPPlans) Operation(ctx context.Context, principal model.Principal, owner webhookhttp.Owner, id string) (any, error) {
	p.take(ctx, principal, "unexpected Operation")
	panic("unreachable")
}
func (p *webhookHTTPPlans) Secret(ctx context.Context, principal model.Principal, owner webhookhttp.Owner, id string) (any, error) {
	p.take(ctx, principal, "unexpected Secret")
	panic("unreachable")
}
func (p *webhookHTTPPlans) ListDeliveries(ctx context.Context, principal model.Principal, owner webhookhttp.Owner, endpoint string, query webhookservice.DeliveryQuery) (any, error) {
	call := p.take(ctx, principal, "ListDeliveries")
	p.equal(owner, call.owner, "history owner")
	p.equal(endpoint, call.endpoint, "history endpoint")
	p.equal(query, call.history, "history query")
	return call.body, call.err
}
func (p *webhookHTTPPlans) GetDelivery(ctx context.Context, principal model.Principal, _ webhookhttp.Owner, _, _ string) (any, error) {
	p.take(ctx, principal, "unexpected GetDelivery")
	panic("unreachable")
}
func (p *webhookHTTPPlans) ListAttempts(ctx context.Context, principal model.Principal, _ webhookhttp.Owner, _, _ string, _ webhookservice.AttemptQuery) (any, error) {
	p.take(ctx, principal, "unexpected ListAttempts")
	panic("unreachable")
}
func (p *webhookHTTPPlans) Payload(ctx context.Context, principal model.Principal, _ webhookhttp.Owner, _, _ string) (any, error) {
	p.take(ctx, principal, "unexpected Payload")
	panic("unreachable")
}
func (p *webhookHTTPPlans) Redeliver(ctx context.Context, principal model.Principal, _ webhookhttp.Owner, _, _ string, _ webhookservice.Redelivery) (webhookservice.Result, error) {
	p.take(ctx, principal, "unexpected Redeliver")
	panic("unreachable")
}

func cloneWebhookHTTPMutation(value webhookhttp.Mutation) webhookhttp.Mutation {
	if value.Name != nil {
		name := *value.Name
		value.Name = &name
	}
	if value.Enabled != nil {
		enabled := *value.Enabled
		value.Enabled = &enabled
	}
	if value.Destination != nil {
		destination := *value.Destination
		value.Destination = &destination
	}
	if value.Subscriptions != nil {
		subscriptions := make([]webhookcore.SubscriptionInput, len(value.Subscriptions))
		for i, sub := range value.Subscriptions {
			if sub.ID != nil {
				id := *sub.ID
				sub.ID = &id
			}
			sub.EventTypes = append([]string(nil), sub.EventTypes...)
			subscriptions[i] = sub
		}
		value.Subscriptions = subscriptions
	}
	if value.ConfirmProjectIDs != nil {
		ids := make([]string, len(value.ConfirmProjectIDs))
		copy(ids, value.ConfirmProjectIDs)
		value.ConfirmProjectIDs = ids
	}
	return value
}

func webhookHTTPDocument(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
