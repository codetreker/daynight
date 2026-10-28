package server

import (
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
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
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := updateHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Web execution"), map[string]any{"allowAgents": true})
	body := workerClaimBody(task.Version)
	body["agent"], body["agentControlMode"] = "claude", "web"
	task = claimHTTPWorker(t, handler, task, body)
	assertHTTPWorkerMode(t, task, "web")
	claimPath := taskPath(task) + "/worker-claim"
	for _, patch := range []map[string]any{
		{"version": task.Version, "claimId": task.Properties.Worker.ClaimID, "agentControlMode": "herdr"},
		{"version": task.Version, "claimId": task.Properties.Worker.ClaimID, "agentControlMode": "web", "phase": "executing"},
		{"version": task.Version, "claimId": task.Properties.Worker.ClaimID, "herdr": map[string]any{"session": "s", "workspaceId": "w", "paneId": "p"}},
	} {
		assertProjectError(t, projectRequest(handler, http.MethodPatch, claimPath, jsonBody(t, patch)), http.StatusBadRequest, "invalid_input")
	}
	if !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
		t.Fatal("rejected mode or resource patch changed the frozen execution")
	}
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPatch, claimPath, jsonBody(t, map[string]any{
		"version": task.Version, "claimId": task.Properties.Worker.ClaimID, "phase": "executing", "nativeSessionId": "claude-session", "herdr": nil,
	})), http.StatusOK)
	assertHTTPWorkerMode(t, readHTTPTask(t, handler, task), "web")
	oldClaim := task.Properties.Worker.ClaimID
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, claimPath+"/release", jsonBody(t, map[string]any{
		"version": task.Version, "claimId": oldClaim, "stoppedConfirmed": true,
	})), http.StatusOK)
	assertHTTPWorkerMode(t, task, "web")
	resume := workerClaimBody(task.Version)
	resume["previousClaimId"] = oldClaim
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, claimPath+"/resume", jsonBody(t, resume)), http.StatusOK)
	assertHTTPWorkerMode(t, task, "herdr")
	// Withdrawal releases the server claim without asserting a native stop.
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, claimPath+"/withdraw", jsonBody(t, map[string]any{"version": task.Version, "claimId": task.Properties.Worker.ClaimID})), http.StatusOK)
	if task.Properties.Worker != nil || task.AllowAgents {
		t.Fatal("withdrawal retained claim or automatic execution")
	}
	task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": true})
	next := workerClaimBody(task.Version)
	next["agentControlMode"] = "web"
	task = claimHTTPWorker(t, handler, task, next)
	assertHTTPWorkerMode(t, task, "web")
	if task.Properties.Worker.ClaimID != next["claimId"] || task.Properties.Worker.Herdr != nil || task.Properties.Worker.NativeSessionID != nil {
		t.Fatal("new execution inherited old resource identity")
	}
	claimID := task.Properties.Worker.ClaimID
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPut, taskPath(task)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: task.Version, Status: "done", ClaimID: &claimID})), http.StatusOK)
	assertHTTPWorkerMode(t, task, "web")
}

func TestWorkerHTTPModeLegacyDefaultAndInvalidInputs(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := updateHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Mode validation"), map[string]any{"allowAgents": true})
	for _, mode := range []any{nil, false, "", "WEB", "other", "web "} {
		body := workerClaimBody(task.Version)
		body["agentControlMode"] = mode
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim", jsonBody(t, body)), http.StatusBadRequest, "invalid_input")
	}
	body := workerClaimBody(task.Version)
	body["agentControlMode"], body["agent"] = "web", "unsupported"
	assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim", jsonBody(t, body)), http.StatusBadRequest, "invalid_input")
	task = claimHTTPWorker(t, handler, task, workerClaimBody(task.Version))
	assertHTTPWorkerMode(t, task, "herdr")
	oldClaim := task.Properties.Worker.ClaimID
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim/release", jsonBody(t, map[string]any{"version": task.Version, "claimId": oldClaim, "stoppedConfirmed": true})), http.StatusOK)
	for _, mode := range []any{nil, "", "unknown"} {
		resume := workerClaimBody(task.Version)
		resume["previousClaimId"], resume["agentControlMode"] = oldClaim, mode
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim/resume", jsonBody(t, resume)), http.StatusBadRequest, "invalid_input")
	}
	if !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
		t.Fatal("invalid resume mode changed the released claim")
	}

}

func TestWorkerHTTPCopilotWebClaimAndResume(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := updateHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Copilot Web execution"), map[string]any{"allowAgents": true})
	body := workerClaimBody(task.Version)
	body["agentControlMode"], body["agent"] = "web", "copilot"
	task = claimHTTPWorker(t, handler, task, body)
	assertHTTPWorkerMode(t, task, "web")
	oldClaim := task.Properties.Worker.ClaimID
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim/release", jsonBody(t, map[string]any{"version": task.Version, "claimId": oldClaim, "stoppedConfirmed": true})), http.StatusOK)
	resume := workerClaimBody(task.Version)
	resume["previousClaimId"], resume["agentControlMode"], resume["agent"] = oldClaim, "web", "copilot"
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim/resume", jsonBody(t, resume)), http.StatusOK)
	assertHTTPWorkerMode(t, readHTTPTask(t, handler, task), "web")
	if string(task.Properties.Worker.Agent) != "copilot" {
		t.Fatal("Copilot provider changed during resume")
	}
}
