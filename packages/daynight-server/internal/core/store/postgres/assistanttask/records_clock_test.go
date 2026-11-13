package assistanttask

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestRecordClockWaitsForRealForwardSample(t *testing.T) {
	head := model.ThreadPosition{CreatedAt: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), ID: "head"}
	samples := []time.Time{head.CreatedAt.Add(-time.Second), head.CreatedAt, head.CreatedAt.Add(time.Millisecond)}
	i, waits := 0, 0
	got, err := forwardRecordClock(t.Context(), head, time.Second, func(ctx context.Context) (time.Time, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("sample lacks deadline")
		}
		v := samples[i]
		i++
		return v, nil
	}, func(context.Context) error { waits++; return nil })
	if err != nil || !got.Equal(samples[2]) || i != 3 || waits != 2 {
		t.Fatalf("real forward sample: %s samples=%d waits=%d error=%v", got, i, waits, err)
	}
}

func TestRecordClockClassifiesBudgetAndPreservesErrors(t *testing.T) {
	head := model.ThreadPosition{CreatedAt: time.Now().UTC(), ID: "head"}
	for _, phase := range []string{"before_sample", "sample", "wait"} {
		t.Run(phase, func(t *testing.T) {
			budget := 5 * time.Millisecond
			if phase == "before_sample" {
				budget = 0
			}
			_, err := forwardRecordClock(t.Context(), head, budget, func(ctx context.Context) (time.Time, error) {
				if phase == "before_sample" {
					t.Fatal("sample after deadline")
				}
				if phase == "sample" {
					<-ctx.Done()
					return time.Time{}, ctx.Err()
				}
				return head.CreatedAt.Add(-time.Second), nil
			}, waitRecordClock)
			var clock *store.ThreadClockError
			if !errors.As(err, &clock) || !errors.Is(err, context.DeadlineExceeded) || clock.Head != head {
				t.Fatalf("budget facts lost: %#v %v", clock, err)
			}
			if phase == "wait" && !clock.Observed.Equal(head.CreatedAt.Add(-time.Second)) {
				t.Fatal("last real sample lost")
			}
		})
	}
	cause := errors.New("clock I/O failed")
	for _, phase := range []string{"sample", "wait"} {
		t.Run(phase+"_failure", func(t *testing.T) {
			_, err := forwardRecordClock(t.Context(), head, time.Second, func(context.Context) (time.Time, error) {
				if phase == "sample" {
					return time.Time{}, cause
				}
				return head.CreatedAt, nil
			}, func(context.Context) error { return cause })
			var clock *store.ThreadClockError
			if !errors.Is(err, cause) || errors.As(err, &clock) {
				t.Fatalf("I/O error reclassified: %v", err)
			}
		})
	}
	for _, phase := range []string{"before_sample", "sample", "wait"} {
		t.Run(phase+"_cancel", func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if phase == "before_sample" {
				cancel()
			}
			_, err := forwardRecordClock(ctx, head, time.Second, func(context.Context) (time.Time, error) {
				if phase == "before_sample" {
					t.Fatal("sample after cancellation")
				}
				if phase == "sample" {
					cancel()
				}
				return head.CreatedAt, nil
			}, func(context.Context) error { cancel(); return ctx.Err() })
			var clock *store.ThreadClockError
			if !errors.Is(err, context.Canceled) || errors.As(err, &clock) {
				t.Fatalf("parent cancellation reclassified: %v", err)
			}
		})
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if !errors.Is(waitRecordClock(ctx), context.Canceled) {
		t.Fatal("clock wait ignored cancellation")
	}
}
