package task_test

import (
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"

	"context"
	"errors"
	"strings"
	"testing"
)

func TestWorkerClaimClockFailurePreservesTask(t *testing.T) {
	tasks, _, project, databaseURL, principal := taskService(t)
	target := claimableTask(t, tasks, principal, project.ID)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	traced := tracedTasks(t, databaseURL, taskQueryAction{
		match: func(sql string) bool { return strings.Contains(sql, "SELECT statement_timestamp()") },
		start: cancel,
	})
	_, err := traced.ClaimWorker(ctx, principal, project.ID, target.ID, taskcore.ClaimWorker{Version: target.Version, WorkerDescriptor: workerDescriptor()})
	assertOperational(t, err)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("claim clock failure lost cancellation: %v", err)
	}
	assertTaskUnchanged(t, tasks, principal, target)
}
