package task

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func threadClockID(number int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", number) }

func TestThreadClockSamplesForwardWithoutChangingUUID(t *testing.T) {
	head := model.ThreadPosition{CreatedAt: time.Date(2026, 11, 3, 10, 0, 0, 123000000, time.UTC), ID: threadClockID(9)}
	candidate := model.ThreadPosition{CreatedAt: head.CreatedAt.Add(-time.Hour), ID: threadClockID(10)}
	if threadPositionAfter(candidate, head) {
		t.Fatal("an earlier timestamp bypassed clock recovery with a larger UUID")
	}
	// This UUID would sort after head at equal time, but once clock recovery is
	// needed the sampler must wait past the head millisecond regardless of UUID.
	samples := []time.Time{head.CreatedAt.Add(-time.Hour), head.CreatedAt, head.CreatedAt.Add(time.Millisecond)}
	calls, waits := 0, 0
	observed, err := forwardThreadClock(context.Background(), head, time.Second, func(ctx context.Context) (time.Time, error) {
		if _, present := ctx.Deadline(); !present {
			t.Fatal("sampling context has no deadline")
		}
		value := samples[calls]
		calls++
		return value, nil
	}, func(context.Context) error { waits++; return nil })
	if err != nil || observed != samples[2] || calls != 3 || waits != 2 {
		t.Fatalf("clock recovery: %s calls=%d waits=%d %v", observed, calls, waits, err)
	}
	if !threadPositionAfter(model.ThreadPosition{CreatedAt: head.CreatedAt, ID: threadClockID(10)}, head) || threadPositionAfter(head, head) {
		t.Fatal("same-millisecond UUID ordering changed")
	}
}

func TestThreadClockBudgetsSamplingAndKeepsParentCancellation(t *testing.T) {
	head := model.ThreadPosition{CreatedAt: time.Now().UTC(), ID: threadClockID(9)}
	for _, duringSample := range []bool{false, true} {
		t.Run(map[bool]string{false: "timer", true: "query"}[duringSample], func(t *testing.T) {
			started := time.Now()
			_, err := forwardThreadClock(context.Background(), head, 15*time.Millisecond, func(ctx context.Context) (time.Time, error) {
				if duringSample {
					<-ctx.Done()
					return time.Time{}, ctx.Err()
				}
				return head.CreatedAt.Add(-time.Second), nil
			}, waitThreadClock)
			var clock *store.ThreadClockError
			if !errors.As(err, &clock) || !errors.Is(err, context.DeadlineExceeded) || clock.Head != head || time.Since(started) > time.Second {
				t.Fatalf("clock budget classification: %#v %v", clock, err)
			}
			if !duringSample && clock.Observed != head.CreatedAt.Add(-time.Second) {
				t.Fatalf("last safe sample lost: %#v", clock)
			}
			if clock.Error() != "reliable forward clock position was not obtained within budget" {
				t.Fatal("clock error overstates cause")
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	_, err := forwardThreadClock(ctx, head, time.Second, func(context.Context) (time.Time, error) {
		cancel()
		return head.CreatedAt, context.Canceled
	}, waitThreadClock)
	var clock *store.ThreadClockError
	if !errors.Is(err, context.Canceled) || errors.As(err, &clock) {
		t.Fatalf("parent cancellation reclassified as clock: %v", err)
	}
	_, err = forwardThreadClock(ctx, head, time.Second, func(context.Context) (time.Time, error) {
		t.Fatal("sample called after parent cancellation")
		return time.Time{}, nil
	}, waitThreadClock)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("initial cancellation lost: %v", err)
	}
	cause := errors.New("sampling failed")
	_, err = forwardThreadClock(context.Background(), head, time.Second,
		func(context.Context) (time.Time, error) { return time.Time{}, cause }, waitThreadClock)
	if !errors.Is(err, cause) || errors.As(err, &clock) {
		t.Fatalf("database failure became clock timeout: %v", err)
	}
	_, err = forwardThreadClock(context.Background(), head, time.Second,
		func(context.Context) (time.Time, error) { return head.CreatedAt, nil },
		func(context.Context) error { return cause })
	if !errors.Is(err, cause) || errors.As(err, &clock) {
		t.Fatalf("wait failure lost: %v", err)
	}
}
