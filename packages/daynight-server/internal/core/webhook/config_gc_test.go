package webhook

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type configGCStub struct {
	scan                             store.WebhookConfigGCScan
	passed                           bool
	outcome                          store.TransactionOutcome
	facts                            store.WebhookConfigGCFacts
	writes, observes, deletes, scans int
	observeErr                       error
}

func (s *configGCStub) ScanWebhookConfigGC(context.Context, *store.WebhookConfigGCCandidate, int) (store.WebhookConfigGCScan, error) {
	s.scans++
	return s.scan, nil
}
func (s *configGCStub) WebhookConfigGCBarrierPassed(context.Context, string) (bool, error) {
	return s.passed, nil
}
func (s *configGCStub) WriteWebhookConfigGC(_ context.Context, _ store.WebhookConfigGCCandidate, fn func(store.WebhookConfigGCScope) error) (store.Completion, error) {
	s.writes++
	if err := fn(s); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: s.outcome}, nil
}
func (s *configGCStub) ObserveWebhookConfigGC(context.Context, store.WebhookConfigGCCandidate) (bool, error) {
	s.observes++
	return true, s.observeErr
}
func (s *configGCStub) LockConfigCandidate(context.Context, store.WebhookConfigGCCandidate) (store.WebhookConfigGCFacts, error) {
	return s.facts, nil
}
func (s *configGCStub) DeleteConfigCandidate(context.Context, store.WebhookConfigGCCandidate) (bool, error) {
	s.deletes++
	return true, nil
}

func TestConfigCollectorBarrierAndUnknown(t *testing.T) {
	id := store.WebhookConfigGCCandidate{Kind: "binding", ID: "first"}
	s := &configGCStub{scan: store.WebhookConfigGCScan{Barrier: "10", Candidates: []store.WebhookConfigGCCandidate{id}}, facts: store.WebhookConfigGCFacts{Present: true, Retired: true}, outcome: store.TransactionUnknown}
	c := &ConfigCollector{}
	n, err := c.Pass(context.Background(), s, 1)
	if err != nil || n != 0 || s.writes != 0 || s.scans != 1 {
		t.Fatalf("pending: %d %v %#v", n, err, s)
	}
	s.passed = true
	n, err = c.Pass(context.Background(), s, 1)
	var unknown *ConfigGCUnknownError
	if n != 0 || !errors.As(err, &unknown) || unknown.Identity != id || s.writes != 1 || s.scans != 1 {
		t.Fatalf("unknown: %d %v %#v", n, err, s)
	}
	s.observeErr = errors.New("offline")
	if _, err = c.Pass(context.Background(), s, 1); !errors.As(err, &unknown) || s.writes != 1 || s.observes != 1 {
		t.Fatalf("unreadable: %v %#v", err, s)
	}
	s.observeErr = nil
	s.scan = store.WebhookConfigGCScan{}
	n, err = c.Pass(context.Background(), s, 1)
	if err != nil || n != 0 || s.writes != 1 || s.observes != 2 || s.scans != 2 {
		t.Fatalf("observed: %d %v %#v", n, err, s)
	}
}
