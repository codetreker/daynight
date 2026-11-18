package task_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
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
		{"claim", "web", model.WorkerActive}, {"update", "web", model.WorkerActive}, {"release", "web", model.WorkerActive}, {"complete", "web", model.WorkerCompleted},
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
				body = map[string]any{"version": returned.Version - 1, "claimId": worker.ClaimID, "phase": "executing", "nativeSessionId": "claude-session"}
				worker.Phase = model.WorkerExecuting
				native := "claude-session"
				worker.NativeSessionID = &native
				returned = workerHTTPResult(t, returned, worker)
				h.Tasks.UpdateWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.UpdateWorker) (model.Task, error) {
					assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
					if input.Version != returned.Version-1 || input.ClaimID != worker.ClaimID || input.Phase == nil || *input.Phase != model.WorkerExecuting || input.NativeSessionID == nil || *input.NativeSessionID == nil || **input.NativeSessionID != native {
						t.Fatalf("web summary fields: %+v", input)
					}
					return returned, nil
				}
			case "release":
				returned.Status = model.TaskTodo
				returned.Properties = workerHTTPProperties(t, returned.Properties, nil)
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
			if tc.operation == "release" {
				if apiWorker(t, got.Properties) != nil {
					t.Fatal("release retained worker")
				}
				return
			}
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

		assertProjectError(t, protocolRequest(h, http.MethodPatch, workerHTTPPath(), jsonBody(t, map[string]any{"version": 1, "claimId": workerHTTPClaimID, "herdr": map[string]any{"session": "s", "workspaceId": "w", "paneId": "p"}}), "2"), http.StatusBadRequest, "invalid_input")
		if h.Tasks.TotalCalls() != 0 {
			t.Fatal("Herdr resource reached service")
		}
	})
}

func TestWorkerHTTPRejectsHerdrMember(t *testing.T) {
	for _, method := range []string{http.MethodPost, http.MethodPatch} {
		for _, value := range []any{nil, map[string]any{"session": "s", "workspaceId": "w", "paneId": "p"}} {
			t.Run(method+"/"+jsonBody(t, value), func(t *testing.T) {
				h := newHTTPFixture(t, io.Discard)
				body := workerClaimBody(1)
				if method == http.MethodPatch {
					body = map[string]any{"version": 1, "claimId": workerHTTPClaimID, "phase": "executing"}
				}
				body["herdr"] = value
				response := protocolRequest(h, method, workerHTTPPath(), jsonBody(t, body), "2")
				assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
				if got := decodeResponse[api.ErrorResponse](t, response, http.StatusBadRequest).Error.Message; got != "Herdr is no longer supported. Upgrade your Daynight client." {
					t.Fatalf("Herdr diagnostic = %q", got)
				}
				if h.Tasks.TotalCalls() != 0 {
					t.Fatal("invalid member reached service")
				}
			})
		}
	}
}

func TestWorkerHTTPModeRequiresExplicitWeb(t *testing.T) {
	for _, mode := range []any{nil, false, "", "herdr", "WEB", "other", "web "} {
		t.Run("claim/"+jsonBody(t, mode), func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			body := workerClaimBody(1)
			body["agentControlMode"] = mode
			response := protocolRequest(h, http.MethodPost, workerHTTPPath(), jsonBody(t, body), "2")
			assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
			if mode == "herdr" {
				if got := decodeResponse[api.ErrorResponse](t, response, http.StatusBadRequest).Error.Message; got != "Herdr is no longer supported. Upgrade your Daynight client." {
					t.Fatalf("Herdr mode diagnostic = %q", got)
				}
			}
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
		body := workerClaimBody(1)
		delete(body, "agentControlMode")
		assertProjectError(t, protocolRequest(h, http.MethodPost, workerHTTPPath(), jsonBody(t, body), "2"), http.StatusBadRequest, "invalid_input")
		if h.Tasks.TotalCalls() != 0 {
			t.Fatal("omitted mode reached service")
		}
	})
}

func TestWorkerHTTPRetiredFieldKeepsStrictDecoding(t *testing.T) {
	const unknown = "request body contains an unknown or read-only field"
	const duplicate = "request body contains a duplicate field"
	const invalid = "request body must be valid JSON"
	const retired = "Herdr is no longer supported. Upgrade your Daynight client."
	for _, tc := range []struct {
		name, method, suffix, body, message string
	}{
		{"escaped retired key", http.MethodPatch, "", `{"her\u0064r":null}`, retired},
		{"unknown first", http.MethodPatch, "", `{"other":null,"herdr":null}`, unknown},
		{"duplicate first", http.MethodPatch, "", `{"version":1,"version":1,"herdr":null}`, duplicate},
		{"invalid value first", http.MethodPatch, "", `{"version":,"herdr":null}`, invalid},
		{"ordinary unknown", http.MethodPost, "", `{"other":null}`, unknown},
		{"release remains unchanged", http.MethodPost, "/release", `{"herdr":null}`, unknown},
		{"withdraw remains unchanged", http.MethodPost, "/withdraw", `{"herdr":null}`, unknown},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			response := protocolRequest(h, tc.method, workerHTTPPath()+tc.suffix, tc.body, "2")
			assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
			if got := decodeResponse[api.ErrorResponse](t, response, http.StatusBadRequest).Error.Message; got != tc.message {
				t.Fatalf("message = %q, want %q", got, tc.message)
			}
			if h.Tasks.TotalCalls() != 0 {
				t.Fatal("invalid request reached service")
			}
		})
	}
	// An unrelated invalid mode retains the existing message and must not imply
	// that the request used the retired Herdr mode.
	h := newHTTPFixture(t, io.Discard)
	body := workerClaimBody(1)
	body["agentControlMode"] = "other"
	response := protocolRequest(h, http.MethodPost, workerHTTPPath(), jsonBody(t, body), "2")
	got := decodeResponse[api.ErrorResponse](t, response, http.StatusBadRequest).Error.Message
	if got != "agentControlMode must be web." || strings.Contains(got, "Herdr") || h.Tasks.TotalCalls() != 0 {
		t.Fatalf("unrelated mode: message=%q calls=%d", got, h.Tasks.TotalCalls())
	}
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
