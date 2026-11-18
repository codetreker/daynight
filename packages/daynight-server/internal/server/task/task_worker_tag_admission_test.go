package task_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestWorkerClaimTagFilterKeyProtocol(t *testing.T) {
	valid := strings.Repeat("a1", 32)
	for _, tc := range []struct {
		name  string
		value any
		good  bool
	}{
		{"valid", valid, true}, {"null", nil, false}, {"number", 123, false}, {"short", valid[:63], false}, {"uppercase", strings.ToUpper(valid), false}, {"nonhex", strings.Repeat("g", 64), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			extendedWorkerTestHandler(h)
			body := workerClaimBody(3)
			body["taskTagFilterKey"] = tc.value
			calls := 0
			if tc.good {
				h.Tasks.ClaimWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.ClaimWorker) (model.Task, error) {
					calls++
					assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
					if input.TaskTagFilterKey == nil || *input.TaskTagFilterKey != valid {
						t.Fatalf("proof: %+v", input.TaskTagFilterKey)
					}
					result, _ := workerHTTPTask(t, model.AgentCodex, model.AgentControlModeWeb, model.WorkerActive)
					return result, nil
				}
			}
			response := projectRequest(h, http.MethodPost, workerHTTPPath(), jsonBody(t, body))
			if tc.good {
				decodeResponse[any](t, response, http.StatusOK)
				if calls != 1 {
					t.Fatal("claim was not invoked")
				}
				return
			}
			assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
			if calls != 0 {
				t.Fatal("invalid proof invoked claim")
			}
		})
	}
}
