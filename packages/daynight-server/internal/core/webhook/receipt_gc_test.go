package webhook

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type receiptGCStub struct {
	candidates                   []store.WebhookReceiptIdentity
	expires, now                 time.Time
	present                      bool
	removed                      bool
	outcome                      store.TransactionOutcome
	writeErr, readErr, deleteErr error
	observed                     int
	deletes                      int
}

func (s *receiptGCStub) ObserveWebhookReceipt(context.Context, store.WebhookReceiptIdentity) (time.Time, bool, error) {
	s.observed++
	return s.expires, s.present, nil
}

func (s *receiptGCStub) ExpiredWebhookReceipts(context.Context, *store.WebhookReceiptIdentity, int) ([]store.WebhookReceiptIdentity, error) {
	return s.candidates, s.readErr
}
func (s *receiptGCStub) WriteWebhookReceiptGC(_ context.Context, _ store.WebhookReceiptIdentity, fn func(store.WebhookReceiptGCScope) error) (store.Completion, error) {
	if err := fn(s); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: s.outcome}, s.writeErr
}
func (s *receiptGCStub) ReceiptExpiry(context.Context, store.WebhookReceiptIdentity) (time.Time, time.Time, bool, error) {
	return s.expires, s.now, s.present, nil
}
func (s *receiptGCStub) DeleteReceipt(context.Context, store.WebhookReceiptIdentity) (bool, error) {
	s.deletes++
	return s.removed, s.deleteErr
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
			s := &receiptGCStub{candidates: []store.WebhookReceiptIdentity{{}}, expires: now.Add(tc.delta), now: now, present: tc.present, removed: tc.removed, outcome: tc.outcome, writeErr: tc.writeErr}
			count, completion, err := (&ReceiptCollector{}).Pass(context.Background(), s, 1)
			if count != tc.wantCount || s.deletes != tc.wantDeletes || (err != nil) != tc.wantErr || completion.Outcome != tc.outcome {
				t.Fatalf("count=%d deletes=%d completion=%+v err=%v", count, s.deletes, completion, err)
			}
			if tc.outcome == store.TransactionUnknown {
				var unknown *ReceiptGCUnknownError
				if !errors.As(err, &unknown) || s.observed != 0 {
					t.Fatalf("unknown=%+v reads=%d err=%v", unknown, s.observed, err)
				}
			}
		})
	}
	for _, n := range []int{0, 501} {
		if _, _, err := (&ReceiptCollector{}).Pass(context.Background(), &receiptGCStub{}, n); err == nil {
			t.Fatalf("limit %d accepted", n)
		}
	}
}
