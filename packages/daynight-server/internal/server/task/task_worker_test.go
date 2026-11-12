package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

const (
	workerHTTPClaimID    = "abcdefab-1111-4111-8111-111111111111"
	workerHTTPWorkerID   = "abcdefab-2222-4222-8222-222222222222"
	workerHTTPMachineID  = "abcdefab-3333-4333-8333-333333333333"
	workerHTTPWorktreeID = "abcdefab-4444-4444-8444-444444444444"
)

func workerClaimBody(version int64) map[string]any {
	return map[string]any{"version": version, "claimId": workerHTTPClaimID, "workerId": workerHTTPWorkerID,
		"machine": map[string]any{"id": workerHTTPMachineID, "name": "Worker machine"}, "platform": "linux", "agent": "codex", "worktreeId": workerHTTPWorktreeID}
}

func workerHTTPDescriptor(body map[string]any) taskcore.WorkerDescriptor {
	machine := body["machine"].(map[string]any)
	mode := model.AgentControlModeHerdr
	if value, present := body["agentControlMode"]; present {
		mode = model.WorkerAgentControlMode(value.(string))
	}
	return taskcore.WorkerDescriptor{ClaimID: body["claimId"].(string), WorkerID: body["workerId"].(string),
		Machine:  model.WorkerMachine{ID: machine["id"].(string), Name: machine["name"].(string)},
		Platform: model.TaskPlatform(body["platform"].(string)), Agent: model.WorkerAgent(body["agent"].(string)), AgentControlMode: mode, WorktreeID: body["worktreeId"].(string)}
}

func workerHTTPTask(t *testing.T, agent model.WorkerAgent, mode model.WorkerAgentControlMode, state model.WorkerState) (model.Task, model.WorkerClaim) {
	t.Helper()
	current := testTask("Worker content must remain private")
	current.Version = 9007199254740993
	current.AllowAgents = true
	worker := model.WorkerClaim{ClaimID: workerHTTPClaimID, WorkerID: workerHTTPWorkerID, UserID: testUserID,
		Machine: model.WorkerMachine{ID: workerHTTPMachineID, Name: "Worker machine"}, Platform: model.PlatformLinux,
		Agent: agent, AgentControlMode: mode, WorktreeID: workerHTTPWorktreeID, State: state, Phase: model.WorkerPreparing, ClaimedAt: current.CreatedAt}
	if state == model.WorkerActive {
		current.Status, current.Ready, current.StartedAt = model.TaskInProgress, false, &worker.ClaimedAt
	}
	if state == model.WorkerCompleted {
		current.Status, current.Ready, current.StartedAt, current.CompletedAt = model.TaskDone, false, &worker.ClaimedAt, &current.UpdatedAt
	}
	return workerHTTPResult(t, current, worker), worker
}

func workerHTTPResult(t *testing.T, current model.Task, worker model.WorkerClaim) model.Task {
	t.Helper()
	raw, err := taskproperty.EncodeWorker(&worker)
	if err != nil {
		t.Fatal(err)
	}
	properties := make(model.TaskProperties, len(current.Properties)+1)
	for key, value := range current.Properties {
		properties[key] = append(json.RawMessage(nil), value...)
	}
	properties["worker"] = raw
	current.Properties = properties
	return current
}

func workerHTTPPath() string {
	return taskCollection(testProjectID) + "/" + testTaskID + "/worker-claim"
}

func assertWorkerHTTPCall(t *testing.T, ctx context.Context, principal model.Principal, projectID, taskID string) {
	t.Helper()
	if ctx.Err() != nil || !reflect.DeepEqual(principal, testPrincipal()) || projectID != testProjectID || taskID != testTaskID {
		t.Fatalf("worker call lost context or identity: principal=%+v project=%s task=%s err=%v", principal, projectID, taskID, ctx.Err())
	}
}

func TestWorkerHTTPClaimUpdatesAndCompletion(t *testing.T) {
	t.Run("claim", func(t *testing.T) {
		var logs bytes.Buffer
		h := newHTTPFixture(t, &logs)
		returned, worker := workerHTTPTask(t, model.AgentCodex, model.AgentControlModeHerdr, model.WorkerActive)
		body := workerClaimBody(returned.Version - 1)
		want := taskcore.ClaimWorker{Version: returned.Version - 1, WorkerDescriptor: workerHTTPDescriptor(body)}
		h.Tasks.ClaimWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.ClaimWorker) (model.Task, error) {
			assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
			if !reflect.DeepEqual(input, want) {
				t.Fatalf("claim input: %+v", input)
			}
			return returned, nil
		}
		response := projectRequest(h, http.MethodPost, workerHTTPPath(), jsonBody(t, body))
		got := decodeResponse[api.Task](t, response, http.StatusOK)
		claim := apiWorker(t, got.Properties)
		if got.ID != returned.ID || got.Version != returned.Version || got.Status != "in_progress" || got.StartedAt == nil || claim == nil || claim.ClaimID != worker.ClaimID || claim.WorkerID != worker.WorkerID || claim.UserID != worker.UserID || claim.Machine.ID != worker.Machine.ID || claim.Platform != string(worker.Platform) || claim.Agent != string(worker.Agent) || claim.Phase != string(worker.Phase) || claim.ClaimedAt != worker.ClaimedAt || claim.Herdr != nil || claim.NativeSessionID != nil {
			t.Fatalf("claim response lost service facts: %+v", got)
		}
		if response.Header().Get("Cache-Control") != "no-store" || !strings.Contains(logs.String(), `"claim_id":"`+worker.ClaimID+`"`) || !strings.Contains(logs.String(), `"component":"worker_claim"`) || strings.Contains(logs.String(), returned.Title) {
			t.Fatalf("worker diagnostics/cache: headers=%v logs=%s", response.Header(), &logs)
		}
	})
	t.Run("session update", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		returned, worker := workerHTTPTask(t, model.AgentCodex, model.AgentControlModeHerdr, model.WorkerActive)
		worker.Phase = model.WorkerExecuting
		worker.Herdr = &model.WorkerHerdr{Session: "w", WorkspaceID: "workspace", PaneID: "pane"}
		native := "native-session"
		worker.NativeSessionID = &native
		returned.Properties["pullRequests"] = rawProperty(t, []api.PullRequestProperty{{URL: "opaque\x00", Title: "Existing evidence"}})
		returned = workerHTTPResult(t, returned, worker)
		h.Tasks.UpdateWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.UpdateWorker) (model.Task, error) {
			assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
			if input.Version != returned.Version-1 || input.ClaimID != worker.ClaimID || input.Phase == nil || *input.Phase != worker.Phase || input.Herdr == nil || !reflect.DeepEqual(*input.Herdr, worker.Herdr) || input.NativeSessionID == nil || *input.NativeSessionID == nil || **input.NativeSessionID != native || input.StartupReport != nil {
				t.Fatalf("session update input: %+v", input)
			}
			return returned, nil
		}
		got := decodeResponse[api.Task](t, projectRequest(h, http.MethodPatch, workerHTTPPath(), jsonBody(t, map[string]any{"version": returned.Version - 1, "claimId": worker.ClaimID, "phase": "executing", "herdr": map[string]any{"session": "w", "workspaceId": "workspace", "paneId": "pane"}, "nativeSessionId": native})), http.StatusOK)
		claim := apiWorker(t, got.Properties)
		if claim.Herdr == nil || claim.Herdr.PaneID != "pane" || claim.NativeSessionID == nil || *claim.NativeSessionID != native || claim.Phase != "executing" || !reflect.DeepEqual(apiPullRequests(t, got.Properties), apiPullRequests(t, api.TaskProperties(returned.Properties))) || !reflect.DeepEqual(got.StartedAt, returned.StartedAt) {
			t.Fatal("worker response lost sessions, task timing or unrelated properties")
		}
	})
	t.Run("explicit null", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		returned, worker := workerHTTPTask(t, model.AgentCodex, model.AgentControlModeHerdr, model.WorkerActive)
		h.Tasks.UpdateWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.UpdateWorker) (model.Task, error) {
			assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
			if input.Version != returned.Version-1 || input.ClaimID != worker.ClaimID || input.Herdr == nil || *input.Herdr != nil || input.NativeSessionID == nil || *input.NativeSessionID != nil || input.Phase != nil {
				t.Fatalf("null patch collapsed into omission: %+v", input)
			}
			return returned, nil
		}
		got := decodeResponse[api.Task](t, projectRequest(h, http.MethodPatch, workerHTTPPath(), jsonBody(t, map[string]any{"version": returned.Version - 1, "claimId": worker.ClaimID, "herdr": nil, "nativeSessionId": nil})), http.StatusOK)
		claim := apiWorker(t, got.Properties)
		if claim.Herdr != nil || claim.NativeSessionID != nil {
			t.Fatal("service null sessions were not preserved")
		}
	})
	t.Run("completion", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		returned, worker := workerHTTPTask(t, model.AgentCodex, model.AgentControlModeHerdr, model.WorkerCompleted)
		h.Tasks.SetStatusFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.SetTaskStatus) (model.Task, error) {
			assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
			if input.Version != returned.Version-1 || input.Status != model.TaskDone || input.ClaimID == nil || *input.ClaimID != worker.ClaimID {
				t.Fatalf("claim completion input: %+v", input)
			}
			return returned, nil
		}
		got := decodeResponse[api.Task](t, projectRequest(h, http.MethodPut, strings.TrimSuffix(workerHTTPPath(), "/worker-claim")+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: returned.Version - 1, Status: "done", ClaimID: &worker.ClaimID})), http.StatusOK)
		if got.Status != "done" || apiWorker(t, got.Properties).State != "completed" || !reflect.DeepEqual(got.StartedAt, returned.StartedAt) || !reflect.DeepEqual(got.CompletedAt, returned.CompletedAt) {
			t.Fatal("completion service facts were changed")
		}
	})
}

func TestWorkerHTTPStrictInputsAndMethods(t *testing.T) {
	for _, tc := range []struct {
		key     string
		value   any
		service bool
	}{
		{"version", nil, false}, {"version", "1", false}, {"version", 0, false}, {"claimId", nil, false}, {"claimId", "invalid", true}, {"workerId", false, false},
		{"machine", nil, false}, {"machine", []any{}, false}, {"machine", map[string]any{"id": workerHTTPMachineID}, false}, {"machine", map[string]any{"id": true, "name": "x"}, false},
		{"machine", map[string]any{"id": workerHTTPMachineID, "name": "x", "unknown": true}, false}, {"platform", nil, false}, {"platform", "freebsd", true},
		{"agent", true, false}, {"agent", "other", true}, {"worktreeId", nil, false}, {"worktreeId", "invalid", true}, {"continuityConfirmed", nil, false}, {"continuityConfirmed", false, false}, {"continuityConfirmed", true, false}, {"continuityConfirmed", "true", false}, {"userId", testUserID, false},
	} {
		t.Run("claim/"+tc.key+"/"+jsonBody(t, tc.value), func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			body := workerClaimBody(9007199254740993)
			body[tc.key] = tc.value
			if tc.service {
				want := taskcore.ClaimWorker{Version: 9007199254740993, WorkerDescriptor: workerHTTPDescriptor(body)}
				h.Tasks.ClaimWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.ClaimWorker) (model.Task, error) {
					assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
					if !reflect.DeepEqual(input, want) {
						t.Fatalf("domain-invalid descriptor changed: %+v", input)
					}
					return model.Task{}, &model.Fault{Code: "invalid_input", Message: "Invalid worker descriptor"}
				}
			}
			assertProjectError(t, projectRequest(h, http.MethodPost, workerHTTPPath(), jsonBody(t, body)), http.StatusBadRequest, "invalid_input")
			if !tc.service && h.Tasks.TotalCalls() != 0 {
				t.Fatal("protocol rejection invoked business service")
			}
		})
	}
	for _, body := range []string{`null`, `{}`, `{"version":1,"version":1}`, `{"ClaimId":"x"}`, `{"version":1.0}`, `{"version":9223372036854775808}`} {
		t.Run("JSON/"+body, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			assertProjectError(t, projectRequest(h, http.MethodPost, workerHTTPPath(), body), http.StatusBadRequest, "invalid_input")
			if h.Tasks.TotalCalls() != 0 {
				t.Fatal("malformed JSON invoked service")
			}
		})
	}
	for _, path := range []string{"", "/release", "/withdraw"} {
		t.Run("method/"+path, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			response := projectRequest(h, http.MethodGet, workerHTTPPath()+path, "")
			allow := "POST"
			if path == "" {
				allow = "POST, PATCH"
			}
			assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
			if response.Header().Get("Allow") != allow || response.Header().Get("Cache-Control") != "no-store" || h.Tasks.TotalCalls() != 0 {
				t.Fatal("worker method admission changed")
			}
		})
	}
	for _, tc := range []struct {
		body    map[string]any
		service bool
	}{
		{map[string]any{"version": 1, "claimId": workerHTTPClaimID}, true},
		{map[string]any{"version": 1, "claimId": workerHTTPClaimID, "phase": nil}, false},
		{map[string]any{"version": 1, "claimId": workerHTTPClaimID, "phase": "unknown"}, true},
		{map[string]any{"version": 1, "claimId": workerHTTPClaimID, "herdr": false}, false},
		{map[string]any{"version": 1, "claimId": workerHTTPClaimID, "herdr": map[string]any{"session": "w"}}, false},
		{map[string]any{"version": 1, "claimId": workerHTTPClaimID, "herdr": map[string]any{"session": "w", "workspaceId": "x", "paneId": true}}, false},
		{map[string]any{"version": 1, "claimId": workerHTTPClaimID, "nativeSessionId": true}, false},
		{map[string]any{"version": 1, "claimId": workerHTTPClaimID, "workerId": workerHTTPWorkerID}, false},
		{map[string]any{}, false}, {map[string]any{"version": 1, "phase": "executing"}, false},
	} {
		t.Run("update/"+jsonBody(t, tc.body), func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			if tc.service {
				h.Tasks.UpdateWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.UpdateWorker) (model.Task, error) {
					assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
					if input.Version != 1 || input.ClaimID != workerHTTPClaimID {
						t.Fatalf("worker update input: %+v", input)
					}
					if phase, present := tc.body["phase"]; present && (input.Phase == nil || string(*input.Phase) != phase) {
						t.Fatalf("phase input: %+v", input)
					}
					return model.Task{}, &model.Fault{Code: "invalid_input", Message: "Invalid worker update"}
				}
			}
			assertProjectError(t, projectRequest(h, http.MethodPatch, workerHTTPPath(), jsonBody(t, tc.body)), http.StatusBadRequest, "invalid_input")
			if !tc.service && h.Tasks.TotalCalls() != 0 {
				t.Fatal("update protocol rejection invoked service")
			}
		})
	}
	for _, body := range []string{`{}`, `{"version":null,"claimId":"` + workerHTTPClaimID + `"}`, `{"version":1}`, `{"version":1,"claimId":null}`, `{"version":1,"claimId":"` + workerHTTPClaimID + `","stoppedConfirmed":true}`, `{"version":1,"version":1,"claimId":"` + workerHTTPClaimID + `"}`} {
		t.Run("withdraw/"+body, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			assertProjectError(t, projectRequest(h, http.MethodPost, workerHTTPPath()+"/withdraw", body), http.StatusBadRequest, "invalid_input")
			if h.Tasks.TotalCalls() != 0 {
				t.Fatal("withdraw protocol rejection invoked service")
			}
		})
	}
	for _, suffix := range []string{"", "/release", "/withdraw"} {
		t.Run("query/"+suffix, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			for _, q := range []string{"?", "?unexpected=1"} {
				assertProjectError(t, projectRequest(h, http.MethodPost, workerHTTPPath()+suffix+q, jsonBody(t, workerClaimBody(1))), http.StatusBadRequest, "invalid_input")
			}
			if h.Tasks.TotalCalls() != 0 {
				t.Fatal("worker query invoked service")
			}
		})
	}
	for _, tc := range []struct {
		suffix string
		body   map[string]any
	}{
		{"/release", map[string]any{"version": 1, "claimId": workerHTTPClaimID}},
		{"/release", map[string]any{"version": 1}},
	} {
		t.Run("missing action field/"+tc.suffix+jsonBody(t, tc.body), func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			assertProjectError(t, projectRequest(h, http.MethodPost, workerHTTPPath()+tc.suffix, jsonBody(t, tc.body)), http.StatusBadRequest, "invalid_input")
			if h.Tasks.TotalCalls() != 0 {
				t.Fatal("incomplete worker action reached service")
			}
		})
	}
	t.Run("invalid withdrawal claim", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		h.Tasks.WithdrawWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.WithdrawWorker) (model.Task, error) {
			assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
			if input.Version != 1 || input.ClaimID != "invalid" {
				t.Fatalf("invalid withdrawal input changed: %+v", input)
			}
			return model.Task{}, &model.Fault{Code: "invalid_input", Message: "Invalid claim ID"}
		}
		assertProjectError(t, projectRequest(h, http.MethodPost, workerHTTPPath()+"/withdraw", `{"version":1,"claimId":"invalid"}`), http.StatusBadRequest, "invalid_input")
	})
	t.Run("removed transfer", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		if response := projectRequest(h, http.MethodPost, workerHTTPPath()+"/transfer", `{}`); response.Code != http.StatusNotFound || h.Tasks.TotalCalls() != 0 {
			t.Fatalf("removed worker action still routed: %d", response.Code)
		}
	})
}

func TestWorkerHTTPReleaseAndExplicitManualResume(t *testing.T) {
	for _, confirmation := range []any{nil, "true", false} {
		t.Run("confirmation/"+jsonBody(t, confirmation), func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			if confirmation == false {
				h.Tasks.ReleaseWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.ReleaseWorker) (model.Task, error) {
					assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
					if input.StoppedConfirmed || input.ClaimID != workerHTTPClaimID || input.Version != 1 {
						t.Fatalf("release confirmation: %+v", input)
					}
					return model.Task{}, &model.Fault{Code: "invalid_input", Message: "Stop not confirmed"}
				}
			}
			assertProjectError(t, projectRequest(h, http.MethodPost, workerHTTPPath()+"/release", jsonBody(t, map[string]any{"version": 1, "claimId": workerHTTPClaimID, "stoppedConfirmed": confirmation})), http.StatusBadRequest, "invalid_input")
		})
	}
	t.Run("release", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		returned, worker := workerHTTPTask(t, model.AgentCodex, model.AgentControlModeHerdr, model.WorkerReleased)
		h.Tasks.ReleaseWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.ReleaseWorker) (model.Task, error) {
			assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
			if input.Version != returned.Version-1 || input.ClaimID != worker.ClaimID || !input.StoppedConfirmed {
				t.Fatalf("release input: %+v", input)
			}
			return returned, nil
		}
		got := decodeResponse[api.Task](t, projectRequest(h, http.MethodPost, workerHTTPPath()+"/release", jsonBody(t, map[string]any{"version": returned.Version - 1, "claimId": worker.ClaimID, "stoppedConfirmed": true})), http.StatusOK)
		if got.Status != "todo" || apiWorker(t, got.Properties).State != "released" || apiWorker(t, got.Properties).WorktreeID != worker.WorktreeID || got.StartedAt != nil || got.CompletedAt != nil {
			t.Fatal("released service facts changed")
		}
	})
}

func TestWorkerHTTPRejectsDeprecatedContinuityInputs(t *testing.T) {
	for _, suffix := range []string{"", "/withdraw"} {
		for _, value := range []any{nil, false, true, "true"} {
			t.Run(suffix+"/"+jsonBody(t, value), func(t *testing.T) {
				h := newHTTPFixture(t, io.Discard)
				body := workerClaimBody(1)
				body["previousClaimId"] = workerHTTPClaimID
				body["continuityConfirmed"] = value
				assertProjectError(t, projectRequest(h, http.MethodPost, workerHTTPPath()+suffix, jsonBody(t, body)), http.StatusBadRequest, "invalid_input")
				if h.Tasks.TotalCalls() != 0 {
					t.Fatal("deprecated input invoked service")
				}
			})
		}
	}
}

func TestWorkerHTTPWithdrawalReturnsClearedClaim(t *testing.T) {
	for _, code := range []string{"version_conflict", "claim_conflict", ""} {
		t.Run("outcome/"+code, func(t *testing.T) {
			var logs bytes.Buffer
			h := newHTTPFixture(t, &logs)
			returned := testTask("withdrawal private content")
			returned.Version = 9007199254740993
			returned.AllowAgents = false
			h.Tasks.WithdrawWorkerFunc = func(ctx context.Context, p model.Principal, projectID, taskID string, input taskcore.WithdrawWorker) (model.Task, error) {
				assertWorkerHTTPCall(t, ctx, p, projectID, taskID)
				if input.Version != returned.Version-1 || input.ClaimID != workerHTTPClaimID {
					t.Fatalf("withdraw input: %+v", input)
				}
				if code != "" {
					return model.Task{}, &model.Fault{Code: code, Message: "Cannot withdraw claim"}
				}
				return returned, nil
			}
			response := projectRequest(h, http.MethodPost, workerHTTPPath()+"/withdraw", jsonBody(t, map[string]any{"version": returned.Version - 1, "claimId": workerHTTPClaimID}))
			if code != "" {
				assertProjectError(t, response, http.StatusConflict, code)
				return
			}
			got := decodeResponse[api.Task](t, response, http.StatusOK)
			if got.Status != "todo" || got.AllowAgents || apiWorker(t, got.Properties) != nil || got.StartedAt != nil || got.CompletedAt != nil || got.Version != returned.Version {
				t.Fatalf("withdrawal response: %+v", got)
			}
			if _, exists := got.Properties["worker"]; exists || response.Header().Get("Cache-Control") != "no-store" || !strings.Contains(logs.String(), `"phase":"withdraw"`) || !strings.Contains(logs.String(), `"claim_id":"`+workerHTTPClaimID+`"`) {
				t.Fatalf("withdrawal correlation: %s", &logs)
			}
		})
	}
}

func TestWorkerHTTPResumeRouteRemoved(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	response := projectRequest(h, http.MethodPost, workerHTTPPath()+"/resume", jsonBody(t, workerClaimBody(1)))
	if response.Code != http.StatusNotFound || h.Tasks.TotalCalls() != 0 {
		t.Fatalf("removed route: status=%d calls=%d", response.Code, h.Tasks.TotalCalls())
	}
}
