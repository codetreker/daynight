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
	if _, exists := decodeResponse[api.Task](t, read, http.StatusOK).Properties["worker"]; exists {
		t.Fatal("unclaimed task contains a worker property")
	}
	body := workerClaimBody(task.Version)
	assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim", jsonBody(t, body)), http.StatusConflict, "invalid_transition")
	task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": true})
	claimed := claimHTTPWorker(t, handler, task, body)
	worker := apiWorker(t, claimed.Properties)
	if worker == nil || worker.State != "active" || worker.ClaimID != body["claimId"] || worker.WorkerID != body["workerId"] || worker.UserID != handler.principal.UserID || worker.Agent != "codex" || worker.Platform != "linux" || worker.Phase != "preparing" || worker.Herdr != nil || worker.NativeSessionID != nil || worker.ClaimedAt.IsZero() || claimed.StartedAt == nil || claimed.Status != "in_progress" || claimed.Version != task.Version+1 {
		t.Fatalf("claim response lost ownership or server timestamps: %+v", claimed)
	}
	claimed = updateHTTPTask(t, handler, claimed, map[string]any{"properties": api.TaskWritableProperties{"pullRequests": rawProperty(t, []api.PullRequestProperty{{URL: "opaque\x00", Title: "Existing evidence"}})}})
	if !reflect.DeepEqual(apiWorker(t, claimed.Properties), worker) {
		t.Fatal("ordinary PR update replaced the worker claim")
	}
	claimPath := taskPath(claimed) + "/worker-claim"
	updated := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPatch, claimPath, jsonBody(t, map[string]any{
		"version": claimed.Version, "claimId": worker.ClaimID, "phase": "executing", "herdr": map[string]any{"session": "w", "workspaceId": "workspace", "paneId": "pane"}, "nativeSessionId": "native-session",
	})), http.StatusOK)
	if apiWorker(t, updated.Properties).Herdr == nil || apiWorker(t, updated.Properties).Herdr.PaneID != "pane" || apiWorker(t, updated.Properties).NativeSessionID == nil || *apiWorker(t, updated.Properties).NativeSessionID != "native-session" || apiWorker(t, updated.Properties).Phase != "executing" || !reflect.DeepEqual(apiPullRequests(t, updated.Properties), apiPullRequests(t, claimed.Properties)) || !reflect.DeepEqual(updated.StartedAt, claimed.StartedAt) {
		t.Fatal("claim session update lost resources, task timing, or PR properties")
	}
	cleared := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPatch, claimPath, jsonBody(t, map[string]any{
		"version": updated.Version, "claimId": worker.ClaimID, "herdr": nil, "nativeSessionId": nil,
	})), http.StatusOK)
	if apiWorker(t, cleared.Properties).Herdr != nil || apiWorker(t, cleared.Properties).NativeSessionID != nil {
		t.Fatal("explicit null session update did not clear its supplied fields")
	}
	for _, test := range []struct{ target, code string }{{"todo", "invalid_transition"}, {"done", "claim_conflict"}} {
		assertProjectError(t, projectRequest(handler, http.MethodPut, taskPath(cleared)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: cleared.Version, Status: test.target})), http.StatusConflict, test.code)
	}
	wrong := uuid.NewString()
	assertProjectError(t, projectRequest(handler, http.MethodPut, taskPath(cleared)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: cleared.Version, Status: "done", ClaimID: &wrong})), http.StatusConflict, "claim_conflict")
	done := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPut, taskPath(cleared)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: cleared.Version, Status: "done", ClaimID: &worker.ClaimID})), http.StatusOK)
	if done.Status != "done" || apiWorker(t, done.Properties).State != "completed" || done.CompletedAt == nil || !reflect.DeepEqual(done.StartedAt, cleared.StartedAt) {
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
		{"agent", true}, {"agent", "other"}, {"worktreeId", nil}, {"worktreeId", "invalid"}, {"continuityConfirmed", nil}, {"continuityConfirmed", false}, {"continuityConfirmed", true}, {"continuityConfirmed", "true"}, {"userId", uuid.NewString()},
	} {
		body := workerClaimBody(task.Version)
		body[test.key] = test.value
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim", jsonBody(t, body)), http.StatusBadRequest, "invalid_input")
	}
	for _, body := range []string{`null`, `{}`, `{"version":1,"version":1}`, `{"ClaimId":"x"}`, `{"version":1.0}`, `{"version":9223372036854775808}`} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim", body), http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim?", jsonBody(t, base)), http.StatusBadRequest, "invalid_input")
	for _, path := range []string{"worker-claim", "worker-claim/release", "worker-claim/withdraw", "worker-claim/resume"} {
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
	for _, body := range []string{`{}`, `{"version":null,"claimId":"` + base["claimId"].(string) + `"}`, `{"version":1}`, `{"version":1,"claimId":null}`, `{"version":1,"claimId":"invalid"}`, `{"version":1,"claimId":"` + base["claimId"].(string) + `","stoppedConfirmed":true}`, `{"version":1,"version":1,"claimId":"` + base["claimId"].(string) + `"}`} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim/withdraw", body), http.StatusBadRequest, "invalid_input")
	}
	if response := projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim/transfer", `{}`); response.Code != http.StatusNotFound {
		t.Fatalf("removed worker action still routed: %d %s", response.Code, response.Body)
	}
	for _, suffix := range []string{"release", "withdraw", "resume"} {
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
	old := apiWorker(t, task.Properties).ClaimID
	for _, confirmation := range []any{nil, "true", false} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim/release", jsonBody(t, map[string]any{"version": task.Version, "claimId": old, "stoppedConfirmed": confirmation})), http.StatusBadRequest, "invalid_input")
	}
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim/release", jsonBody(t, map[string]any{"version": task.Version, "claimId": old, "stoppedConfirmed": true})), http.StatusOK)
	if task.Status != "todo" || apiWorker(t, task.Properties).State != "released" || apiWorker(t, task.Properties).WorktreeID != body["worktreeId"] || task.StartedAt != nil || task.CompletedAt != nil {
		t.Fatal("release lost historical resource identity or failed to reset task timing")
	}
	task = updateHTTPTask(t, handler, task, map[string]any{"allowAgents": false, "requiredPlatform": "windows"})
	body["version"], body["claimId"], body["previousClaimId"], body["worktreeId"], body["agent"] = task.Version, uuid.NewString(), old, uuid.NewString(), "copilot"
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim/resume", jsonBody(t, body)), http.StatusOK)
	if task.Status != "in_progress" || apiWorker(t, task.Properties).State != "active" || apiWorker(t, task.Properties).ClaimID != body["claimId"] || apiWorker(t, task.Properties).WorktreeID != body["worktreeId"] || apiWorker(t, task.Properties).Agent != "copilot" || task.AllowAgents || task.RequiredPlatform == nil || *task.RequiredPlatform != "windows" || apiWorker(t, task.Properties).Platform != "linux" {
		t.Fatal("explicit manual resume incorrectly applied automatic eligibility filters")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task)+"/worker-claim", jsonBody(t, map[string]any{"version": task.Version, "claimId": old, "phase": "executing"})), http.StatusConflict, "claim_conflict")
}

func TestWorkerHTTPRejectsDeprecatedContinuityInputs(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := updateHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Fresh worker execution"), map[string]any{"allowAgents": true})
	claim := workerClaimBody(task.Version)
	rejectContinuity := func(path string, body map[string]any) {
		t.Helper()
		for _, value := range []any{nil, false, true, "true"} {
			body["continuityConfirmed"] = value
			assertProjectError(t, projectRequest(handler, http.MethodPost, path, jsonBody(t, body)), http.StatusBadRequest, "invalid_input")
		}
		delete(body, "continuityConfirmed")
		if !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
			t.Fatal("deprecated input mutated the task")
		}
	}
	rejectContinuity(taskPath(task)+"/worker-claim", claim)
	task = claimHTTPWorker(t, handler, task, claim)
	rejectContinuity(taskPath(task)+"/worker-claim/withdraw", map[string]any{"version": task.Version, "claimId": claim["claimId"]})
	task = decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskPath(task)+"/worker-claim/release", jsonBody(t, map[string]any{"version": task.Version, "claimId": claim["claimId"], "stoppedConfirmed": true})), http.StatusOK)
	resume := workerClaimBody(task.Version)
	resume["previousClaimId"] = claim["claimId"]
	rejectContinuity(taskPath(task)+"/worker-claim/resume", resume)
}

func TestWorkerHTTPWithdrawalReturnsClearedClaim(t *testing.T) {
	var logs bytes.Buffer
	handler := projectTestHandler(t, projectTestStore(t), &logs)
	project := taskProject(t, handler)
	task := updateHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Force withdrawal"), map[string]any{"allowAgents": true})
	body := workerClaimBody(task.Version)
	task = claimHTTPWorker(t, handler, task, body)
	claimID := apiWorker(t, task.Properties).ClaimID
	path := taskPath(task) + "/worker-claim/withdraw"
	assertProjectError(t, projectRequest(handler, http.MethodPost, path, jsonBody(t, map[string]any{"version": task.Version - 1, "claimId": claimID})), http.StatusConflict, "version_conflict")
	assertProjectError(t, projectRequest(handler, http.MethodPost, path, jsonBody(t, map[string]any{"version": task.Version, "claimId": uuid.NewString()})), http.StatusConflict, "claim_conflict")
	response := projectRequest(handler, http.MethodPost, path, jsonBody(t, map[string]any{"version": task.Version, "claimId": claimID}))
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("withdrawal response can be cached")
	}
	withdrawn := decodeResponse[api.Task](t, response, http.StatusOK)
	if withdrawn.Status != "todo" || withdrawn.AllowAgents || apiWorker(t, withdrawn.Properties) != nil || withdrawn.StartedAt != nil || withdrawn.CompletedAt != nil || withdrawn.Version != task.Version+1 {
		t.Fatalf("withdrawal response retained execution state: %#v", withdrawn)
	}
	if _, exists := withdrawn.Properties["worker"]; exists || !reflect.DeepEqual(readHTTPTask(t, handler, withdrawn), withdrawn) {
		t.Fatal("withdrawal did not persist its complete task response with absent worker")
	}
	if !strings.Contains(logs.String(), `"phase":"withdraw"`) || !strings.Contains(logs.String(), `"claim_id":"`+claimID+`"`) {
		t.Fatal("withdrawal log lost execution correlation")
	}
}
