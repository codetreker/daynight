package server

import (
	"bytes"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
)

func workerClaimBody(version int64) map[string]any {
	return map[string]any{"version": version, "claimId": uuid.NewString(), "workerId": uuid.NewString(),
		"machine": map[string]any{"id": uuid.NewString(), "name": "Worker machine"}, "platform": "linux", "agent": "codex", "worktreeId": uuid.NewString()}
}

func claimHTTPWorker(t *testing.T, handler http.Handler, task api.Task, body map[string]any) api.Task {
	t.Helper()
	body["version"] = task.Version
	response := projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim", jsonBody(t, body))
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("worker claim response can be cached")
	}
	return decodeResponse[api.Task](t, response, http.StatusOK)
}

func TestWorkerHTTPClaimUpdatesAndCompletion(t *testing.T) {
	var logs bytes.Buffer
	handler := projectTestHandler(t, projectTestStore(t), &logs)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Worker task")
	read := projectRequest(handler, http.MethodGet, taskPath(task), "")
	if !strings.Contains(read.Body.String(), `"worker":null`) {
		t.Fatal("task properties do not declare the unclaimed worker value")
	}
	body := workerClaimBody(task.Version)
	assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim", jsonBody(t, body)), http.StatusConflict, "invalid_transition")
	task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": true})
	claimed := claimHTTPWorker(t, handler, task, body)
	worker := claimed.Properties.Worker
	if worker == nil || worker.State != "active" || worker.ClaimID != body["claimId"] || worker.WorkerID != body["workerId"] || worker.UserID != handler.principal.UserID || worker.Agent != "codex" || worker.Platform != "linux" || worker.Phase != "preparing" || worker.Herdr != nil || worker.NativeSessionID != nil || worker.ClaimedAt.IsZero() || claimed.StartedAt == nil || claimed.Status != "in_progress" || claimed.Version != task.Version+1 {
		t.Fatalf("claim response lost ownership or server timestamps: %+v", claimed)
	}
	claimed = updateHTTPTask(t, handler, claimed, map[string]any{"properties": api.TaskWritableProperties{PullRequests: []api.PullRequestProperty{{URL: "opaque\x00", Title: "Existing evidence"}}}})
	if !reflect.DeepEqual(claimed.Properties.Worker, worker) {
		t.Fatal("ordinary PR update replaced the worker claim")
	}
	claimPath := taskPath(claimed) + "/worker-claim"
	updated := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPatch, claimPath, jsonBody(t, map[string]any{
		"version": claimed.Version, "claimId": worker.ClaimID, "phase": "executing", "herdr": map[string]any{"session": "w", "workspaceId": "workspace", "paneId": "pane"}, "nativeSessionId": "native-session",
	})), http.StatusOK)
	if updated.Properties.Worker.Herdr == nil || updated.Properties.Worker.Herdr.PaneID != "pane" || updated.Properties.Worker.NativeSessionID == nil || *updated.Properties.Worker.NativeSessionID != "native-session" || updated.Properties.Worker.Phase != "executing" || !reflect.DeepEqual(updated.Properties.PullRequests, claimed.Properties.PullRequests) || !reflect.DeepEqual(updated.StartedAt, claimed.StartedAt) {
		t.Fatal("claim session update lost resources, task timing, or PR properties")
	}
	cleared := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPatch, claimPath, jsonBody(t, map[string]any{
		"version": updated.Version, "claimId": worker.ClaimID, "herdr": nil, "nativeSessionId": nil,
	})), http.StatusOK)
	if cleared.Properties.Worker.Herdr != nil || cleared.Properties.Worker.NativeSessionID != nil {
		t.Fatal("explicit null session update did not clear its supplied fields")
	}
	for _, test := range []struct{ target, code string }{{"todo", "invalid_transition"}, {"done", "claim_conflict"}} {
		assertProjectError(t, projectRequest(handler, http.MethodPut, taskPath(cleared)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: cleared.Version, Status: test.target})), http.StatusConflict, test.code)
	}
	wrong := uuid.NewString()
	assertProjectError(t, projectRequest(handler, http.MethodPut, taskPath(cleared)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: cleared.Version, Status: "done", ClaimID: &wrong})), http.StatusConflict, "claim_conflict")
	done := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPut, taskPath(cleared)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: cleared.Version, Status: "done", ClaimID: &worker.ClaimID})), http.StatusOK)
	if done.Status != "done" || done.Properties.Worker.State != "completed" || done.CompletedAt == nil || !reflect.DeepEqual(done.StartedAt, cleared.StartedAt) {
		t.Fatal("claim-bound status completion did not finish the current execution")
	}
	if !strings.Contains(logs.String(), `"claim_id":"`+worker.ClaimID+`"`) || !strings.Contains(logs.String(), `"component":"worker_claim"`) || strings.Contains(logs.String(), "native-session") || strings.Contains(logs.String(), "Existing evidence") {
		t.Fatal("worker operation diagnostics lack correlation or expose execution content")
	}
}

func TestWorkerHTTPStrictInputsAndMethods(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := updateHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Strict worker task"), map[string]any{"allowAgents": true})
	base := workerClaimBody(task.Version)
	for _, test := range []struct {
		key   string
		value any
	}{
		{"version", nil}, {"version", "1"}, {"version", 0}, {"claimId", nil}, {"claimId", "invalid"}, {"workerId", false},
		{"machine", nil}, {"machine", []any{}}, {"machine", map[string]any{"id": uuid.NewString()}}, {"machine", map[string]any{"id": true, "name": "x"}},
		{"machine", map[string]any{"id": uuid.NewString(), "name": "x", "unknown": true}}, {"platform", nil}, {"platform", "freebsd"},
		{"agent", true}, {"agent", "other"}, {"worktreeId", nil}, {"worktreeId", "invalid"}, {"continuityConfirmed", nil}, {"continuityConfirmed", "true"}, {"userId", uuid.NewString()},
	} {
		body := workerClaimBody(task.Version)
		body[test.key] = test.value
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim", jsonBody(t, body)), http.StatusBadRequest, "invalid_input")
	}
	for _, body := range []string{`null`, `{}`, `{"version":1,"version":1}`, `{"ClaimId":"x"}`, `{"version":1.0}`, `{"version":9223372036854775808}`} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim", body), http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim?", jsonBody(t, base)), http.StatusBadRequest, "invalid_input")
	for _, path := range []string{"worker-claim", "worker-claim/release", "worker-claim/transfer", "worker-claim/resume"} {
		response := projectRequest(handler, http.MethodGet, taskPath(task)+"/"+path, "")
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Allow") == "" {
			t.Fatalf("worker action method response changed: %s %d %s", path, response.Code, response.Body)
		}
	}
	task = claimHTTPWorker(t, handler, task, base)
	for _, body := range []map[string]any{
		{"version": task.Version, "claimId": base["claimId"]},
		{"version": task.Version, "claimId": base["claimId"], "phase": nil},
		{"version": task.Version, "claimId": base["claimId"], "phase": "unknown"},
		{"version": task.Version, "claimId": base["claimId"], "herdr": false},
		{"version": task.Version, "claimId": base["claimId"], "herdr": map[string]any{"session": "w"}},
		{"version": task.Version, "claimId": base["claimId"], "herdr": map[string]any{"session": "w", "workspaceId": "x", "paneId": true}},
		{"version": task.Version, "claimId": base["claimId"], "nativeSessionId": true},
		{"version": task.Version, "claimId": base["claimId"], "workerId": uuid.NewString()},
	} {
		assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task)+"/worker-claim", jsonBody(t, body)), http.StatusBadRequest, "invalid_input")
	}
	for _, action := range []struct {
		method, suffix string
		body           map[string]any
	}{
		{http.MethodPatch, "", map[string]any{}},
		{http.MethodPatch, "", map[string]any{"version": task.Version, "phase": "executing"}},
		{http.MethodPost, "/release", map[string]any{"version": task.Version}},
		{http.MethodPost, "/release", map[string]any{"version": task.Version, "claimId": base["claimId"]}},
		{http.MethodPost, "/resume", workerClaimBody(task.Version)},
	} {
		assertProjectError(t, projectRequest(handler, action.method, taskPath(task)+"/worker-claim"+action.suffix, jsonBody(t, action.body)), http.StatusBadRequest, "invalid_input")
	}
	for _, field := range []string{"version", "claimId", "target", "userId", "workerId", "machine", "platform", "agent", "stoppedConfirmed", "continuityConfirmed"} {
		target := map[string]any{"userId": handler.principal.UserID, "workerId": uuid.NewString(), "machine": base["machine"], "platform": "linux", "agent": "codex"}
		body := map[string]any{"version": task.Version, "claimId": base["claimId"], "newClaimId": uuid.NewString(), "target": target, "worktreeId": base["worktreeId"], "stoppedConfirmed": true, "continuityConfirmed": true}
		if field == "userId" || field == "workerId" || field == "machine" || field == "platform" || field == "agent" {
			target[field] = nil
		} else {
			body[field] = nil
		}
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim/transfer", jsonBody(t, body)), http.StatusBadRequest, "invalid_input")
	}
	for _, suffix := range []string{"release", "transfer", "resume"} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim/"+suffix, `{}`), http.StatusBadRequest, "invalid_input")
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim/"+suffix+"?unexpected=1", `{}`), http.StatusBadRequest, "invalid_input")
	}
	for _, body := range []string{`{"worker":null}`, jsonBody(t, task.Properties)} {
		assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), `{"version":`+jsonBody(t, task.Version)+`,"properties":`+body+`}`), http.StatusBadRequest, "invalid_input")
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), `{"title":"Reject worker","properties":`+body+`}`), http.StatusBadRequest, "invalid_input")
	}
	if !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
		t.Fatal("rejected worker operations changed the task")
	}
}

func TestWorkerHTTPReleaseAndExplicitManualResume(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := updateHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Resume worker task"), map[string]any{"allowAgents": true})
	body := workerClaimBody(task.Version)
	task = claimHTTPWorker(t, handler, task, body)
	old := task.Properties.Worker.ClaimID
	for _, confirmation := range []any{nil, "true", false} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim/release", jsonBody(t, map[string]any{"version": task.Version, "claimId": old, "stoppedConfirmed": confirmation})), http.StatusBadRequest, "invalid_input")
	}
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim/release", jsonBody(t, map[string]any{"version": task.Version, "claimId": old, "stoppedConfirmed": true})), http.StatusOK)
	if task.Status != "todo" || task.Properties.Worker.State != "released" || task.Properties.Worker.WorktreeID != body["worktreeId"] || task.StartedAt != nil || task.CompletedAt != nil {
		t.Fatal("release lost retained work or failed to reset task timing")
	}
	task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": false, "requiredPlatform": "windows"})
	body["version"], body["claimId"], body["previousClaimId"], body["continuityConfirmed"] = task.Version, uuid.NewString(), old, true
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim/resume", jsonBody(t, body)), http.StatusOK)
	if task.Status != "in_progress" || task.Properties.Worker.State != "active" || task.Properties.Worker.ClaimID != body["claimId"] || task.AllowAgents || task.RequiredPlatform == nil || *task.RequiredPlatform != "windows" || task.Properties.Worker.Platform != "linux" {
		t.Fatal("explicit manual resume incorrectly applied automatic eligibility filters")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task)+"/worker-claim", jsonBody(t, map[string]any{"version": task.Version, "claimId": old, "phase": "executing"})), http.StatusConflict, "claim_conflict")
}
