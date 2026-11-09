package server

import (
	"bytes"
	"context"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

// The plans contain independent observations. Captured writes never populate a read plan.
type webhookHTTPPlans struct {
	t             *testing.T
	mu            sync.Mutex
	reads, writes []*webhookHTTPScope
	scopes        []*webhookHTTPScope
}

func (p *webhookHTTPPlans) read(ctx context.Context, fn func(store.WebhookReadScope) error) error {
	p.mu.Lock()
	if len(p.reads) == 0 {
		p.mu.Unlock()
		unexpectedHTTPCall(p.t, "webhook snapshot")
	}
	scope := p.reads[0]
	p.reads = p.reads[1:]
	p.mu.Unlock()
	return fn(scope)
}
func (p *webhookHTTPPlans) write(ctx context.Context, owner wm.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
	p.mu.Lock()
	if len(p.writes) == 0 {
		p.mu.Unlock()
		unexpectedHTTPCall(p.t, "webhook write")
	}
	scope := p.writes[0]
	p.writes = p.writes[1:]
	p.mu.Unlock()
	scope.equal(owner, scope.endpoint.Owner, "operation owner")
	scope.equal(id, scope.operation.ID, "operation ID")
	err := fn(scope)
	return store.Completion{Outcome: scope.outcome}, err
}
func (p *webhookHTTPPlans) addRead(scope *webhookHTTPScope) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reads = append(p.reads, scope)
	p.scopes = append(p.scopes, scope)
}
func (p *webhookHTTPPlans) addWrite(scope *webhookHTTPScope) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.writes = append(p.writes, scope)
	p.scopes = append(p.scopes, scope)
}
func (p *webhookHTTPPlans) verify() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.reads) != 0 || len(p.writes) != 0 {
		p.t.Errorf("unconsumed webhook scopes: read=%d write=%d", len(p.reads), len(p.writes))
	}
	for _, scope := range p.scopes {
		scope.mu.Lock()
		if len(scope.want) != 0 {
			p.t.Errorf("unconsumed webhook DAO calls: %v", scope.want)
		}
		scope.mu.Unlock()
	}
}

type webhookHTTPUnusedWriter interface{ store.WebhookWriter }

type webhookHTTPScope struct {
	store.WebhookWriteScope
	webhookHTTPUnusedWriter
	store.WebhookHistoryReader
	store.WebhookEligibilityDAO
	store.CredentialReader
	t                *testing.T
	mu               sync.Mutex
	want             []string
	principal        model.Principal
	now              time.Time
	endpoint         wm.Endpoint
	key              wm.SigningKey
	subscription     wm.Subscription
	binding          wm.Binding
	operation        wm.Operation
	policy           wm.Policy
	delivery         store.WebhookDelivery
	sources          store.WebhookHistorySources
	outcome          store.TransactionOutcome
	operationMissing bool
}

func (s *webhookHTTPScope) call(ctx context.Context, name string) {
	s.t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx.Err() != nil || len(s.want) == 0 || s.want[0] != name {
		s.t.Errorf("webhook DAO %s, remaining=%v context=%v", name, s.want, ctx.Err())
		panic(fmt.Sprintf("unexpected webhook DAO call %s", name))
	}
	s.want = s.want[1:]
}
func (s *webhookHTTPScope) equal(got, want any, name string) {
	s.t.Helper()
	if !reflect.DeepEqual(got, want) {
		s.t.Errorf("%s: got %#v want %#v", name, got, want)
		panic("webhook DAO argument mismatch")
	}
}
func (s *webhookHTTPScope) CredentialDAO() store.CredentialReader       { return s }
func (s *webhookHTTPScope) WebhookDAO() store.WebhookReader             { return s }
func (s *webhookHTTPScope) WebhookWriter() store.WebhookWriter          { return s }
func (s *webhookHTTPScope) EligibilityDAO() store.WebhookEligibilityDAO { return s }
func (s *webhookHTTPScope) Credential(ctx context.Context, principal model.Principal) (store.ThreadCredential, error) {
	s.call(ctx, "Credential")
	s.equal(principal, s.principal, "credential principal")
	return store.ThreadCredential{}, nil
}
func (s *webhookHTTPScope) ObservedAt(ctx context.Context) (time.Time, error) {
	s.call(ctx, "ObservedAt")
	return s.now, nil
}
func (s *webhookHTTPScope) Policy(ctx context.Context, version int64) (wm.Policy, error) {
	s.call(ctx, "Policy")
	s.equal(version, int64(1), "policy version")
	return s.policy, nil
}
func (s *webhookHTTPScope) Endpoint(ctx context.Context, owner wm.Owner, id string) (wm.Endpoint, error) {
	s.call(ctx, "Endpoint")
	s.equal(owner, s.endpoint.Owner, "endpoint owner")
	s.equal(id, s.endpoint.ID, "endpoint ID")
	return s.endpoint, nil
}
func (s *webhookHTTPScope) Endpoints(ctx context.Context, owner wm.Owner) ([]wm.Endpoint, error) {
	s.call(ctx, "Endpoints")
	s.equal(owner, s.endpoint.Owner, "list owner")
	return []wm.Endpoint{}, nil
}
func (s *webhookHTTPScope) SigningKeys(ctx context.Context, endpoint string) ([]wm.SigningKey, error) {
	s.call(ctx, "SigningKeys")
	s.equal(endpoint, s.endpoint.ID, "signing endpoint")
	return []wm.SigningKey{s.key}, nil
}
func (s *webhookHTTPScope) Subscriptions(ctx context.Context, endpoint string) ([]wm.Subscription, error) {
	s.call(ctx, "Subscriptions")
	s.equal(endpoint, s.endpoint.ID, "subscription endpoint")
	return []wm.Subscription{s.subscription}, nil
}
func (s *webhookHTTPScope) Bindings(ctx context.Context, subscription string) ([]wm.Binding, error) {
	s.call(ctx, "Bindings")
	s.equal(subscription, s.subscription.ID, "binding subscription")
	return []wm.Binding{s.binding}, nil
}
func (s *webhookHTTPScope) Operation(ctx context.Context, owner wm.Owner, id string) (wm.Operation, error) {
	s.call(ctx, "Operation")
	s.equal(owner, s.operation.Owner, "receipt owner")
	s.equal(id, s.operation.ID, "receipt ID")
	if s.operationMissing {
		return wm.Operation{}, model.ErrNotFound
	}
	return s.operation, nil
}
func (s *webhookHTTPScope) ReadEligibility(ctx context.Context, owner wm.Owner, project, actor string) (store.WebhookEligibility, error) {
	s.call(ctx, "ReadEligibility")
	s.equal(owner, s.endpoint.Owner, "eligibility owner")
	s.equal(project, s.subscription.ProjectID, "eligibility project")
	s.equal(actor, s.principal.UserID, "eligibility actor")
	name := "maintenance"
	return store.WebhookEligibility{Status: "eligible", ProjectName: &name}, nil
}
func (s *webhookHTTPScope) LockConfigurationSources(ctx context.Context, owner wm.Owner, actor string, projects []string) error {
	s.call(ctx, "LockConfigurationSources")
	s.equal(owner, s.endpoint.Owner, "source owner")
	s.equal(actor, s.principal.UserID, "source actor")
	s.equal(projects, []string{s.subscription.ProjectID}, "configuration projects")
	return nil
}
func (s *webhookHTTPScope) LockCredential(ctx context.Context, principal model.Principal) (store.ThreadCredential, error) {
	s.call(ctx, "LockCredential")
	s.equal(principal, s.principal, "locked credential")
	return store.ThreadCredential{}, nil
}
func (s *webhookHTTPScope) PutEndpoint(ctx context.Context, endpoint wm.Endpoint) error {
	s.call(ctx, "PutEndpoint")
	s.equal(endpoint, s.endpoint, "written endpoint")
	return nil
}
func (s *webhookHTTPScope) PutSubscription(ctx context.Context, sub wm.Subscription) error {
	s.call(ctx, "PutSubscription")
	s.equal(sub, s.subscription, "written subscription")
	return nil
}
func (s *webhookHTTPScope) PutBinding(ctx context.Context, binding wm.Binding) error {
	s.call(ctx, "PutBinding")
	s.equal(binding, s.binding, "written binding")
	return nil
}
func (s *webhookHTTPScope) DeleteSigningKeys(ctx context.Context, endpoint string) error {
	s.call(ctx, "DeleteSigningKeys")
	s.equal(endpoint, s.endpoint.ID, "cleared signing endpoint")
	return nil
}
func (s *webhookHTTPScope) PutSigningKey(ctx context.Context, key wm.SigningKey) error {
	s.call(ctx, "PutSigningKey")
	s.equal(key, s.key, "written signing key")
	return nil
}
func (s *webhookHTTPScope) PutOperation(ctx context.Context, operation wm.Operation) error {
	s.call(ctx, "PutOperation")
	s.equal(operation, s.operation, "written operation")
	return nil
}
func (s *webhookHTTPScope) HistoryDisclosure(ctx context.Context, owner wm.Owner, endpoint, actor string, at time.Time) (string, error) {
	s.call(ctx, "HistoryDisclosure")
	s.equal(owner, s.endpoint.Owner, "history owner")
	s.equal(endpoint, s.endpoint.ID, "history endpoint")
	s.equal(actor, s.principal.UserID, "history actor")
	s.equal(at, s.now, "history observation")
	return "current", nil
}
func (s *webhookHTTPScope) HistoryDeliveries(ctx context.Context, owner wm.Owner, endpoint string, at time.Time, id string, limit int) ([]store.WebhookDelivery, error) {
	s.call(ctx, "HistoryDeliveries")
	s.equal(owner, s.endpoint.Owner, "history collection owner")
	s.equal(endpoint, s.endpoint.ID, "history collection endpoint")
	s.equal(at, time.Time{}, "history position")
	s.equal(id, "", "history ID")
	s.equal(limit, 100, "history limit")
	return []store.WebhookDelivery{s.delivery}, nil
}
func (s *webhookHTTPScope) HistorySources(ctx context.Context, delivery store.WebhookDelivery, actor string) (store.WebhookHistorySources, error) {
	s.call(ctx, "HistorySources")
	s.equal(delivery, s.delivery, "history delivery")
	s.equal(actor, s.principal.UserID, "history source actor")
	return s.sources, nil
}
func (s *webhookHTTPScope) HistoryAttempts(ctx context.Context, delivery string) ([]store.WebhookAttempt, error) {
	s.call(ctx, "HistoryAttempts")
	s.equal(delivery, s.delivery.ID, "history attempts")
	return []store.WebhookAttempt{}, nil
}

func webhookHTTPRandom() *bytes.Reader {
	data := bytes.Repeat([]byte{0x11}, 16)
	data = append(data, bytes.Repeat([]byte{0x22}, 16)...)
	data = append(data, bytes.Repeat([]byte{0x33}, 32)...)
	data = append(data, bytes.Repeat([]byte{0x44}, 16)...)
	data = append(data, bytes.Repeat([]byte{0x55}, 16)...)
	return bytes.NewReader(data)
}
