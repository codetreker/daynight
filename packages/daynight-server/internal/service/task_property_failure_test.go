package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
)

func TestPropertyInputFaultPreservesFailureCategory(t *testing.T) {
	operational := fmt.Errorf("property operation: %w", context.Canceled)
	if actual := propertyInputFault(operational); actual != operational {
		t.Fatalf("operational failure changed identity: %v", actual)
	}
	cause := errors.New("invalid stored syntax")
	invalid := &taskproperties.ValidationError{Path: "properties.pullRequests", Rule: "properties.pullRequests must be an array", Cause: cause}
	wrapped := fmt.Errorf("read property: %w", invalid)
	fault := requireFault(t, propertyInputFault(wrapped), "invalid_input")
	if fault.Message != invalid.Rule || !errors.Is(fault, cause) || !errors.Is(fault, wrapped) {
		t.Fatalf("property validation lost its safe diagnostic or cause: %#v", fault)
	}
}

func TestWorkerClaimClockFailurePreservesTask(t *testing.T) {
	tasks, _, project, databaseURL, principal := taskService(t)
	target := claimableTask(t, tasks, principal, project.ID)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	traced := tracedTasks(t, databaseURL, taskQueryAction{
		match: func(sql string) bool { return strings.Contains(sql, "SELECT statement_timestamp()") },
		start: cancel,
	})
	_, err := traced.ClaimWorker(ctx, principal, project.ID, target.ID, ClaimWorker{Version: target.Version, WorkerDescriptor: workerDescriptor()})
	assertOperational(t, err)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("claim clock failure lost cancellation: %v", err)
	}
	assertTaskUnchanged(t, tasks, principal, target)
}
