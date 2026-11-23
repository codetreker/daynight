package session

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func TestDeletedTaskAllowsWebArchiveWithoutRetiringClaim(t *testing.T) {
	f := setup(t)
	r := &record{Snapshot: sp.Snapshot{Lifecycle: "active", ControllerFence: sp.ControllerFence{Fence: sp.Fence{ClaimID: f.r.ClaimID}}}}
	live := task{Status: "in_progress", Worker: f.data.Task.Worker}
	if err := archiveStopped(r, live); err == nil {
		t.Fatal("live execution allowed to archive")
	}
	live.Deleted = true
	if active(live, r) {
		t.Fatal("hidden task remains active")
	}
	if err := archiveStopped(r, live); err != nil {
		t.Fatalf("hidden task cannot finish archive: %v", err)
	}
}

func TestGoalSessionQueriesDoNotLookupExecution(t *testing.T) {
	f := setup(t)
	f.data.Task.Type = model.TaskTypeGoal
	ctx := context.Background()
	result, err := withinRecordingPhase(f, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1}, func(phase context.Context) (map[string]any, error) {
		return f.s.Current(phase, f.p, f.project, f.task)
	})
	if err != nil || result["status"] != "not_applicable" {
		t.Fatalf("goal current: %v %v", result, err)
	}
	page, err := withinRecordingPhase(f, ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1}, func(phase context.Context) (map[string]any, error) {
		return f.s.TerminalHistory(phase, f.p, f.project, f.task, "", 10)
	})
	if err != nil || len(page["items"].([]map[string]any)) != 0 {
		t.Fatalf("goal history: %v %v", page, err)
	}
}

func withinRecordingPhase[T any](f fixture, ctx context.Context, counts map[string]int, fn func(context.Context) (T, error)) (T, error) {
	phase := f.dao.ContextPhase(ctx, counts)
	defer f.dao.FinishContext(phase)
	return fn(phase)
}
