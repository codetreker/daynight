package worker

import (
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestActiveAtAndAdmission(t *testing.T) {
	now := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		offset time.Duration
		active bool
	}{
		{time.Millisecond, false}, {0, true}, {-ActiveWindow + time.Nanosecond, true}, {-ActiveWindow, false}, {-ActiveWindow - time.Nanosecond, false},
	} {
		seen := now.Add(tc.offset)
		if got := ActiveAt(seen, now); got != tc.active {
			t.Errorf("offset %s: %v", tc.offset, got)
		}
		for _, count := range []int{99, 100, 101} {
			err := AdmitActiveWorker(store.WorkerAdmission{ObservedAt: now, LastSeenAt: &seen, ActiveCount: count})
			rejected := count > 100 || (count == 100 && !tc.active)
			var fault *model.Fault
			if rejected != (errors.As(err, &fault) && fault.Code == "active_worker_limit_exceeded") || (!rejected && err != nil) {
				t.Errorf("offset %s count %d: %v", tc.offset, count, err)
			}
		}
	}
	if ActiveAt(time.Time{}, now) || ActiveAt(now, time.Time{}) {
		t.Fatal("zero time is not active")
	}
	if err := AdmitActiveWorker(store.WorkerAdmission{ObservedAt: now, ActiveCount: 100}); err == nil {
		t.Fatal("new worker admitted at capacity")
	}
}
