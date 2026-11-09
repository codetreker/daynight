package webhook

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
)

func TestOutOfRangeStatusLateObservation(t *testing.T) {
	now := time.Now()
	own := store.WebhookAttempt{ID: "a", DeliveryID: "d", LeaseToken: "token", Generation: 1, RecoveredUnknownAt: &now}
	scope := &lateScope{deliveryUnexpectedScope: deliveryUnexpectedScope{t: t}, attempt: own, now: now}
	runner := NewRunner(lateDB{scope: scope}, &Service{}, true)
	done, err := runner.finalizeOnce(context.Background(), own, now, time.Second, httpoutbound.Response{Status: 600}, nil)
	if len(scope.updates) != 1 {
		t.Fatalf("late update calls=%d", len(scope.updates))
	}
	a := scope.updates[0]
	if err != nil || !done || a.LateHTTPStatus != nil || a.LateOutcome == nil || *a.LateOutcome != "transport_error" || a.LateErrorCode == nil || *a.LateErrorCode != "invalid_http_status" || a.RecoveredUnknownAt == nil {
		t.Fatalf("late observation=%+v done=%v err=%v", a, done, err)
	}
	for _, code := range []int{0, 99, 600, 999, 1 << 20} {
		o := observe(time.Second, now, httpoutbound.Response{Status: code}, nil)
		if o.status != nil || o.outcome != "transport_error" {
			t.Fatalf("invalid status %d: %+v", code, o)
		}
	}
	for _, code := range []int{100, 599} {
		o := observe(time.Second, now, httpoutbound.Response{Status: code}, nil)
		if o.status == nil || int(*o.status) != code {
			t.Fatalf("valid status %d: %+v", code, o)
		}
	}
}
