package task_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func assertHTTPWorkerMode(t *testing.T, task api.Task, expected string) {
	t.Helper()
	var document struct {
		Properties struct {
			Worker struct {
				Mode string `json:"agentControlMode"`
			} `json:"worker"`
		} `json:"properties"`
	}
	if err := json.Unmarshal([]byte(jsonBody(t, task)), &document); err != nil {
		t.Fatal(err)
	}
	if document.Properties.Worker.Mode != expected {
		t.Fatalf("worker mode = %q, want %q", document.Properties.Worker.Mode, expected)
	}
}

func TestWorkerHTTPModeFrozenAcrossSummaryAndNewClaims(t *testing.T) {
	for _, tc := range []struct {
		operation, mode string
		state           model.WorkerState
	}{
		{"claim", "web", model.WorkerActive}, {"update", "web", model.WorkerActive}, {"release", "web", model.WorkerReleased}, {"complete", "web", model.WorkerCompleted},
	} {
		t.Run(tc.operation, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			returned, worker := workerHTTPTask(t, model.AgentClaude, model.WorkerAgentControlMode(tc.mode), tc.state)
			path, method, body := workerHTTPPath(), http.MethodPost, workerClaimBody(returned.Version-1)
			body["agent"] = "claude"
			switch tc.operation {
			case "claim":
				body["agentControlMode"] = "web"
				h.Tasks.ClaimWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.ClaimWorker) (model.Task, error) {
					assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
					if input.Version != returned.Version-1 || !reflect.DeepEqual(input.WorkerDescriptor, workerHTTPDescriptor(body)) {
						t.Fatalf("web descriptor: %+v", input)
					}
					return returned, nil
				}
			case "update":
				method = http.MethodPatch
				body = map[string]any{"version": returned.Version - 1, "claimId": worker.ClaimID, "phase": "executing", "nativeSessionId": "claude-session", "herdr": nil}
				worker.Phase = model.WorkerExecuting
				native := "claude-session"
				worker.NativeSessionID = &native
				returned = workerHTTPResult(t, returned, worker)
				h.Tasks.UpdateWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.UpdateWorker) (model.Task, error) {
					assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
					if input.Version != returned.Version-1 || input.ClaimID != worker.ClaimID || input.Phase == nil || *input.Phase != model.WorkerExecuting || input.NativeSessionID == nil || *input.NativeSessionID == nil || **input.NativeSessionID != native || input.Herdr == nil || *input.Herdr != nil {
						t.Fatalf("web summary fields: %+v", input)
					}
					return returned, nil
				}
			case "release":
				path += "/release"
				body = map[string]any{"version": returned.Version - 1, "claimId": worker.ClaimID, "stoppedConfirmed": true}
				h.Tasks.ReleaseWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.ReleaseWorker) (model.Task, error) {
					assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
					if input.Version != returned.Version-1 || input.ClaimID != worker.ClaimID || !input.StoppedConfirmed {
						t.Fatalf("release web input: %+v", input)
					}
					return returned, nil
				}
			case "complete":
				path = taskCollection(testProjectID) + "/" + testTaskID + "/status"
				method = http.MethodPut
				body = map[string]any{"version": returned.Version - 1, "claimId": worker.ClaimID, "status": "done"}
				h.Tasks.SetStatusFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.SetTaskStatus) (model.Task, error) {
					assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
					if input.Version != returned.Version-1 || input.ClaimID == nil || *input.ClaimID != worker.ClaimID || input.Status != model.TaskDone {
						t.Fatalf("completion input: %+v", input)
					}
					return returned, nil
				}
			}
			response := protocolRequest(h, method, path, jsonBody(t, body), "2")
			got := decodeResponse[api.Task](t, response, http.StatusOK)
			assertHTTPWorkerMode(t, got, tc.mode)
			if got.Version != returned.Version || apiWorker(t, got.Properties).ClaimID != worker.ClaimID || apiWorker(t, got.Properties).Agent != "claude" {
				t.Fatal("HTTP response changed mode or ownership facts")
			}
		})
	}
	for _, mode := range []string{"herdr", "web"} {
		t.Run("reject mode patch/"+mode, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			assertProjectError(t, protocolRequest(h, http.MethodPatch, workerHTTPPath(), jsonBody(t, map[string]any{"version": 1, "claimId": workerHTTPClaimID, "agentControlMode": mode, "phase": "executing"}), "2"), http.StatusBadRequest, "invalid_input")
			if h.Tasks.TotalCalls() != 0 {
				t.Fatal("mode patch reached service")
			}
		})
	}
	t.Run("web resource refusal", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		h.Tasks.UpdateWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.UpdateWorker) (model.Task, error) {
			assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
			if input.Herdr == nil || *input.Herdr == nil || **input.Herdr != (model.WorkerHerdr{Session: "s", WorkspaceID: "w", PaneID: "p"}) {
				t.Fatalf("Herdr input: %+v", input)
			}
			return model.Task{}, &model.Fault{Code: "invalid_input", Message: "Execution mode does not admit Herdr resources"}
		}
		assertProjectError(t, protocolRequest(h, http.MethodPatch, workerHTTPPath(), jsonBody(t, map[string]any{"version": 1, "claimId": workerHTTPClaimID, "herdr": map[string]any{"session": "s", "workspaceId": "w", "paneId": "p"}}), "2"), http.StatusBadRequest, "invalid_input")
	})
}

func TestWorkerHTTPModeLegacyDefaultAndInvalidInputs(t *testing.T) {
	for _, mode := range []any{nil, false, "", "WEB", "other", "web "} {
		t.Run("claim/"+jsonBody(t, mode), func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			body := workerClaimBody(1)
			body["agentControlMode"] = mode
			assertProjectError(t, protocolRequest(h, http.MethodPost, workerHTTPPath(), jsonBody(t, body), "2"), http.StatusBadRequest, "invalid_input")
			if h.Tasks.TotalCalls() != 0 {
				t.Fatal("invalid mode reached service")
			}
		})
	}
	t.Run("unsupported provider", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		body := workerClaimBody(1)
		body["agentControlMode"], body["agent"] = "web", "unsupported"
		h.Tasks.ClaimWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.ClaimWorker) (model.Task, error) {
			assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
			if input.Agent != "unsupported" || input.AgentControlMode != model.AgentControlModeWeb {
				t.Fatalf("provider input: %+v", input)
			}
			return model.Task{}, &model.Fault{Code: "invalid_input", Message: "Unsupported provider"}
		}
		assertProjectError(t, protocolRequest(h, http.MethodPost, workerHTTPPath(), jsonBody(t, body), "2"), http.StatusBadRequest, "invalid_input")
	})
	t.Run("omitted claim mode", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		returned, _ := workerHTTPTask(t, model.AgentCodex, model.AgentControlModeHerdr, model.WorkerActive)
		h.Tasks.ClaimWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.ClaimWorker) (model.Task, error) {
			assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
			if input.AgentControlMode != model.AgentControlModeHerdr {
				t.Fatalf("default mode: %q", input.AgentControlMode)
			}
			return returned, nil
		}
		assertHTTPWorkerMode(t, decodeResponse[api.Task](t, protocolRequest(h, http.MethodPost, workerHTTPPath(), jsonBody(t, workerClaimBody(returned.Version-1)), "2"), http.StatusOK), "herdr")
	})
}

func TestWorkerHTTPCopilotWebClaim(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	returned, worker := workerHTTPTask(t, model.AgentCopilot, model.AgentControlModeWeb, model.WorkerActive)
	body := workerClaimBody(returned.Version - 1)
	body["agent"], body["agentControlMode"] = "copilot", "web"
	h.Tasks.ClaimWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.ClaimWorker) (model.Task, error) {
		assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
		if !reflect.DeepEqual(input.WorkerDescriptor, workerHTTPDescriptor(body)) {
			t.Fatalf("Copilot claim: %+v", input)
		}
		return returned, nil
	}
	got := decodeResponse[api.Task](t, protocolRequest(h, http.MethodPost, workerHTTPPath(), jsonBody(t, body), "2"), http.StatusOK)
	assertHTTPWorkerMode(t, got, "web")
	if apiWorker(t, got.Properties).Agent != "copilot" || apiWorker(t, got.Properties).ClaimID != worker.ClaimID {
		t.Fatal("Copilot response changed provider or claim")
	}
}
