package task_test

import (
	"context"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestMCPBoundedStepInvalidTitlePrecedesOversizedText(t *testing.T) {
	f := newStepsReadFixture(t, stepMockHeader(1))
	item := stepProjection("00000000", 0, "")
	item.Step.Title, item.InvalidTitle, item.Oversized = "\u0085", true, true
	f.Reader.TaskStepSummaryFn = func(ctx context.Context, task, step string) (store.TaskStepProjection, error) {
		if ctx != f.Ctx || task != f.Header.ID || step != item.Step.ID {
			t.Fatal("bounded Step summary query changed")
		}
		return item, nil
	}
	calls := 0
	f.Reader.TaskStepPageFn = func(ctx context.Context, task string, after int64, limit int, summary bool) ([]store.TaskStepProjection, error) {
		calls++
		if ctx != f.Ctx || task != f.Header.ID || after != -1 || limit != 1 || summary {
			t.Fatal("bounded Step full query changed")
		}
		return []store.TaskStepProjection{item}, nil
	}
	_, err := f.Steps.GetBounded(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, item.Step.ID)
	if err == nil || !strings.Contains(err.Error(), "step title must contain a non-whitespace character") {
		t.Fatalf("oversized description hid invalid stored title: %v", err)
	}
	item.Step.Title, item.InvalidTitle = "valid", false
	_, err = f.Steps.GetBounded(f.Ctx, f.Principal, f.Header.ProjectID, f.Header.ID, item.Step.ID)
	requireThreadFault(t, err, "resource_limit_exceeded")
	if calls != 2 {
		t.Fatalf("bounded Step page reads = %d, want 2", calls)
	}
}
