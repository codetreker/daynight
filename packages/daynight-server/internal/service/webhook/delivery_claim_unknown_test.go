package webhook

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
)

type unknownClaimThenFailure struct {
	calls, claims, admissions int
	failure                   error
}

type unknownClaimScope struct {
	store.WebhookDeliveryScope
	db *unknownClaimThenFailure
}

func (s unknownClaimScope) ObservedAt(context.Context) (time.Time, error) {
	return time.Now(), nil
}

func (s unknownClaimScope) Claim(_ context.Context, n int, now time.Time, tokens []string) ([]store.WebhookDelivery, error) {
	s.db.claims++
	if s.db.claims != 1 {
		return nil, s.db.failure
	}
	if n != 1 || len(tokens) != 1 || tokens[0] == "" {
		return nil, errors.New("invalid claim request")
	}
	until := now.Add(45 * time.Second)
	return []store.WebhookDelivery{{ID: "claimed-delivery", State: "leased", LeaseToken: &tokens[0], LeaseUntil: &until}}, nil
}

func (s unknownClaimScope) AdmissionSources(context.Context, string, time.Time) (store.WebhookAdmissionSources, error) {
	s.db.admissions++
	return store.WebhookAdmissionSources{}, errors.New("unexpected admission")
}

func (d *unknownClaimThenFailure) WriteWebhookDelivery(_ context.Context, fn func(store.WebhookDeliveryScope) error) (store.Completion, error) {
	d.calls++
	err := fn(unknownClaimScope{db: d})
	if d.calls == 1 {
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionUnknown}, errors.New("claim acknowledgement lost")
	}
	return store.Completion{Outcome: store.TransactionNotCommitted}, err
}

type countUnexpectedDelivery struct{ count int }

func (c *countUnexpectedDelivery) Do(context.Context, string, []byte, http.Header) (httpoutbound.Response, error) {
	c.count++
	return httpoutbound.Response{}, errors.New("unexpected send")
}

// A claim with an unknown commit outcome is never used for admission or HTTP;
// the worker polls again and exposes a subsequent definite storage failure.
func TestWorkerUnknownClaimNeverSendsAndRetries(t *testing.T) {
	failure := errors.New("claim store unavailable")
	db := &unknownClaimThenFailure{failure: failure}
	sender := &countUnexpectedDelivery{}
	r := NewRunner(db, &Service{}, true)
	r.client = sender
	r.pollInterval = 20 * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := r.worker(ctx, ctx)
	if !errors.Is(err, failure) || db.calls != 2 || db.claims != 2 || db.admissions != 0 || sender.count != 0 {
		t.Fatalf("unknown claim: error=%v transactions=%d claims=%d admissions=%d HTTP=%d", err, db.calls, db.claims, db.admissions, sender.count)
	}
}
