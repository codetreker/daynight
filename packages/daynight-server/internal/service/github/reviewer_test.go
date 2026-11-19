package github

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

type reviewerAllocatorFunc func(context.Context, time.Duration) (bool, error)

func (f reviewerAllocatorFunc) AssignPullRequestReviewer(ctx context.Context, activeWindow time.Duration) (bool, error) {
	return f(ctx, activeWindow)
}

func TestReviewerAllocationBoundsAndStopsOnFailure(t *testing.T) {
	for _, tc := range []struct {
		name      string
		wantCalls int
		assigned  bool
		err       error
	}{
		{name: "limited batch", wantCalls: reviewerBatch, assigned: true},
		{name: "no assignment", wantCalls: 1},
		{name: "database error", wantCalls: 1, err: errors.New("unavailable")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var output bytes.Buffer
			var calls int
			r := AppRunner{
				logger: slog.New(slog.NewTextHandler(&output, nil)),
				reviewers: reviewerAllocatorFunc(func(ctx context.Context, window time.Duration) (bool, error) {
					calls++
					if window != workercore.ActiveWindow {
						t.Errorf("active window = %v", window)
					}
					if _, ok := ctx.Deadline(); !ok {
						t.Error("allocation has no database deadline")
					}
					return tc.assigned, tc.err
				}),
			}
			r.assignReviewers(t.Context())
			if calls != tc.wantCalls {
				t.Fatalf("calls = %d, want %d", calls, tc.wantCalls)
			}
			if strings.Contains(output.String(), "assign_reviewer") != (tc.err != nil) {
				t.Fatalf("allocation log: %s", output.String())
			}
		})
	}
}

func TestAppRunnerStopsReviewerAllocationWithAdmission(t *testing.T) {
	started := make(chan struct{})
	canceled := make(chan struct{})
	r := appRunnerFixture(appDueReaderFunc(func(context.Context, time.Time, int) ([]string, error) {
		return nil, nil
	}), executorFunc(func(context.Context, string) error {
		t.Error("unexpected sync execution")
		return nil
	}))
	r.reviewers = reviewerAllocatorFunc(func(ctx context.Context, _ time.Duration) (bool, error) {
		close(started)
		<-ctx.Done()
		close(canceled)
		return false, ctx.Err()
	})
	if err := r.StartWithClaimContext(t.Context(), t.Context()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stopAppRunner(t, r) })
	event(t, started)
	r.StopClaims()
	event(t, canceled)
	stopAppRunner(t, r)
}
