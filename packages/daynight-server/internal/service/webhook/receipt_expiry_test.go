package webhook

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

type receiptClockScope struct {
	store.WebhookReadScope
	at  time.Time
	err error
}

func (s receiptClockScope) ObservedAt(context.Context) (time.Time, error) {
	return s.at, s.err
}

func TestOperationReceiptDeadlineUsesObservedDatabaseTime(t *testing.T) {
	deadline := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	op := wm.Operation{ExpiresAt: deadline}
	for _, code := range []string{"not_found", "operation_expired"} {
		if err := requireLiveOperation(t.Context(), receiptClockScope{at: deadline.Add(-time.Nanosecond)}, op, code); err != nil {
			t.Fatal(err)
		}
		for _, observed := range []time.Time{deadline, deadline.Add(time.Nanosecond)} {
			expectFault(t, requireLiveOperation(t.Context(), receiptClockScope{at: observed}, op, code), code)
		}
	}
	failure := errors.New("database clock failed")
	if err := requireLiveOperation(t.Context(), receiptClockScope{err: failure}, op, "not_found"); !errors.Is(err, failure) {
		t.Fatalf("clock failure was hidden: %v", err)
	}
}
