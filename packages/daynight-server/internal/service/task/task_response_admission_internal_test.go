package task

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
)

func TestTaskResponseAdmissionEncodesRESTAndMCP(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	task := model.Task{Title: "Task", Version: 1, CreatedAt: now, UpdatedAt: now}
	for _, changed := range []bool{false, true} {
		if err := admitTaskResponse(WithMCPTaskResponse(t.Context(), "request<&"), task, changed); err != nil {
			t.Fatalf("valid response: %v", err)
		}
	}
	oversized := task
	oversized.Description = strings.Repeat("<", taskcore.MaxTaskResponseJSONBytes/6+1)
	assertResponseLimit(t, admitTaskResponse(context.Background(), oversized, true))
	assertResponseLimit(t, admitTaskResponse(WithMCPTaskResponse(t.Context(), strings.Repeat("<", taskcore.MaxTaskResponseJSONBytes/6+1)), task, false))
	assertResponseLimit(t, taskResponseError(taskprotocol.ErrLegacyWorkerIndeterminate))
	sentinel := errors.New("encoding failure")
	if got := taskResponseError(sentinel); got != sentinel {
		t.Fatalf("unexpected conversion of encoding failure: %v", got)
	}
}

func assertResponseLimit(t *testing.T, err error) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "resource_limit_exceeded" {
		t.Fatalf("expected resource limit fault: %v", err)
	}
	if !errors.Is(err, taskprotocol.ErrLegacyWorkerIndeterminate) {
		var violation *limit.Violation
		if !errors.As(err, &violation) {
			t.Fatalf("lost measured violation: %v", err)
		}
	}
}
