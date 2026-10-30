package server

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
)

func reportSnapshotHTTP(t *testing.T, handler http.Handler, id string, body map[string]any) api.WorkerReportResponse {
	t.Helper()
	response := projectRequest(handler, http.MethodPost, "/api/v1/me/workers/"+id+"/report", jsonBody(t, body))
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") == "" {
		t.Fatal("worker report lacks private response admission headers")
	}
	return decodeResponse[api.WorkerReportResponse](t, response, http.StatusOK)
}

func snapshotDetailHTTP(t *testing.T, handler http.Handler, id string) api.WorkerDetailResponse {
	t.Helper()
	return decodeResponse[api.WorkerDetailResponse](t, projectRequest(handler, http.MethodGet, "/api/v1/me/workers/"+id, ""), http.StatusOK)
}

func TestWorkerSnapshotsHTTPReportReadAndPagination(t *testing.T) {
	var logs bytes.Buffer
	handler := projectTestHandler(t, projectTestStore(t), &logs)
	extendedWorkerTestHandler(handler)
	empty := decodeResponse[api.WorkerPage](t, projectRequest(handler, http.MethodGet, "/api/v1/me/workers", ""), http.StatusOK)
	if empty.Items == nil || len(empty.Items) != 0 || empty.NextCursor != nil || empty.ObservedAt.IsZero() {
		t.Fatal("invalid empty worker page")
	}
	id := uuid.NewString()
	body := workerSnapshotReportBody()
	body["taskInventory"] = nil
	reported := reportSnapshotHTTP(t, handler, strings.ToUpper(id), body)
	if reported.ObservedAt.IsZero() || reported.LastReportedAt.IsZero() {
		t.Fatal("report lacks server timestamps")
	}
	unknown := snapshotDetailHTTP(t, handler, id)
	if unknown.Worker.ActiveTaskCount != nil || unknown.Worker.TaskObservationState != "unavailable" || unknown.Worker.TaskObservedAt != nil || unknown.Worker.InventoryObservedAt != nil || unknown.Worker.Tasks == nil {
		t.Fatalf("unknown inventory became idle: %+v", unknown)
	}
	body = workerSnapshotReportBody()
	reportSnapshotHTTP(t, handler, id, body)
	idle := snapshotDetailHTTP(t, handler, id)
	if idle.Worker.ActiveTaskCount == nil || *idle.Worker.ActiveTaskCount != 0 || idle.Worker.TaskObservationState != "observed" || idle.Worker.TaskObservedAt == nil || idle.Worker.InventoryObservedAt == nil || idle.Worker.Telemetry.CPU.Value == nil || idle.Worker.Telemetry.Versions.Codex.State != "not_installed" || idle.Worker.Telemetry.Versions.Copilot.Code == nil {
		t.Fatalf("idle or telemetry shape incorrect: %+v", idle)
	}
	project := taskProject(t, handler)
	task := updateHTTPTask(t, handler, createHTTPTask(t, handler, project.ID, "Snapshot-owned task"), map[string]any{"allowAgents": true})
	claim := workerClaimBody(task.Version)
	claim["workerId"] = id
	claim["agent"] = "claude"
	task = claimHTTPWorker(t, handler, task, claim)
	task = updateHTTPTask(t, handler, task, map[string]any{"properties": api.TaskWritableProperties{"pullRequests": rawProperty(t, []api.PullRequestProperty{{URL: "opaque\x00", Title: "Opaque evidence"}})}})
	body["taskInventory"] = map[string]any{"observedAt": "2026-10-29T00:00:00Z", "claims": []any{map[string]any{"projectId": project.ID, "taskId": task.ID, "claimId": apiWorker(t, task.Properties).ClaimID}}}
	reportSnapshotHTTP(t, handler, id, body)
	active := snapshotDetailHTTP(t, handler, id)
	if active.Worker.ActiveTaskCount == nil || *active.Worker.ActiveTaskCount != 1 || len(active.Worker.Tasks) != 1 || active.Worker.Tasks[0].Agent != "claude" || active.Worker.Tasks[0].Title != task.Title {
		t.Fatalf("authorized task snapshot missing: %+v", active)
	}
	done := decodeResponse[api.Task](t, projectRequest(handler, http.MethodPut, taskPath(task)+"/status", jsonBody(t, map[string]any{"version": task.Version, "status": "done", "claimId": apiWorker(t, task.Properties).ClaimID})), http.StatusOK)
	if done.Status != "done" {
		t.Fatal("task not completed")
	}
	body["taskInventory"] = nil
	reportSnapshotHTTP(t, handler, id, body)
	stale := snapshotDetailHTTP(t, handler, id)
	if stale.Worker.TaskObservationState != "stale" || len(stale.Worker.Tasks) != 1 || stale.Worker.Tasks[0].Status != "in_progress" || stale.Worker.TaskObservedAt == nil || !stale.Worker.TaskObservedAt.Equal(*active.Worker.TaskObservedAt) {
		t.Fatalf("historical snapshot was overwritten by current task state: %+v", stale)
	}
	lastSeen := stale.Worker.LastReportedAt
	if next := snapshotDetailHTTP(t, handler, id); !next.Worker.LastReportedAt.Equal(lastSeen) {
		t.Fatal("GET refreshed liveness")
	}
	second := uuid.NewString()
	secondBody := workerSnapshotReportBody()
	secondBody["versions"].(map[string]any)["herdr"] = map[string]any{"state": "not_running", "checkedAt": "2026-10-29T00:00:00Z"}
	reportSnapshotHTTP(t, handler, second, secondBody)
	page := decodeResponse[api.WorkerPage](t, projectRequest(handler, http.MethodGet, "/api/v1/me/workers?limit=1", ""), http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].WorkerID != id || page.NextCursor == nil {
		t.Fatalf("first page incorrect: %+v", page)
	}
	next := decodeResponse[api.WorkerPage](t, projectRequest(handler, http.MethodGet, "/api/v1/me/workers?limit=1&cursor="+url.QueryEscape(*page.NextCursor), ""), http.StatusOK)
	if len(next.Items) != 1 || next.Items[0].WorkerID != second || next.NextCursor != nil {
		t.Fatalf("stable continuation incorrect: %+v", next)
	}
	if logsText := logs.String(); !strings.Contains(logsText, `"worker_id":"`+id+`"`) || !strings.Contains(logsText, `"component":"worker_report"`) || strings.Contains(logsText, "/private/work") || strings.Contains(logsText, "Private worker machine") || strings.Contains(logsText, "Snapshot-owned task") {
		t.Fatal("worker logs lack correlation or expose private content")
	}
}

func TestWorkerSnapshotsHTTPRejectsInvalidInputsAndMethods(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	id := uuid.NewString()
	path := "/api/v1/me/workers/" + id
	for _, body := range []string{"", `null`, `[]`, `{}`, `{"state":true}`, `{"machine":null,"machine":null}`, strings.Repeat(" ", maxJSONBody) + "{}", string([]byte{'{', 0xff, '}'})} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, path+"/report", body), http.StatusBadRequest, "invalid_input")
	}
	for _, mutate := range []func(map[string]any){
		func(b map[string]any) { b["userId"] = uuid.NewString() }, func(b map[string]any) { b["workingDirectory"] = "NUL\x00" }, func(b map[string]any) { b["platform"] = "unknown" },
		func(b map[string]any) { b["cpu"].(map[string]any)["value"].(map[string]any)["usagePercent"] = 101 },
		func(b map[string]any) { b["memory"].(map[string]any)["value"].(map[string]any)["usedBytes"] = 99 },
		func(b map[string]any) { b["versions"].(map[string]any)["copilot"].(map[string]any)["code"] = "unknown" },
		func(b map[string]any) {
			b["taskInventory"] = map[string]any{"observedAt": "2026-10-29T00:00:00Z", "claims": []any{map[string]any{"projectId": "bad", "taskId": uuid.NewString(), "claimId": uuid.NewString()}}}
		},
	} {
		body := workerSnapshotReportBody()
		mutate(body)
		assertProjectError(t, projectRequest(handler, http.MethodPost, path+"/report", jsonBody(t, body)), http.StatusBadRequest, "invalid_input")
	}
	for _, stamp := range []string{"2026-10-29T00:00:00+24:00", "2026-10-29T00:00:00+00:60", "2026-10-29T00:00:00,1Z"} {
		for _, field := range []string{"sampledAt", "checkedAt", "observedAt"} {
			body := workerSnapshotReportBody()
			switch field {
			case "sampledAt":
				body["sampledAt"] = stamp
			case "checkedAt":
				body["cpu"].(map[string]any)["checkedAt"] = stamp
			case "observedAt":
				body["taskInventory"].(map[string]any)["observedAt"] = stamp
			}
			assertProjectError(t, projectRequest(handler, http.MethodPost, path+"/report", jsonBody(t, body)), http.StatusBadRequest, "invalid_input")
		}
	}
	for _, target := range []string{"not-uuid/report", id + "/report?", id + "/report?x=1"} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, "/api/v1/me/workers/"+target, jsonBody(t, workerSnapshotReportBody())), http.StatusBadRequest, "invalid_input")
	}
	for _, target := range []string{"?limit=0", "?limit=101", "?limit=1&limit=2", "?cursor=bad", "?unknown=x", "?limit=%zz"} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/me/workers"+target, ""), http.StatusBadRequest, "invalid_input")
	}
	for _, target := range []string{"not-uuid", id + "?", id + "?x=1"} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/me/workers/"+target, ""), http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, projectRequest(handler, http.MethodGet, path, ""), http.StatusNotFound, "not_found")
	for _, test := range []struct{ path, method, allow string }{{"/api/v1/me/workers", http.MethodPost, "GET, HEAD"}, {path, http.MethodPatch, "GET, HEAD"}, {path + "/report", http.MethodGet, "POST"}} {
		response := projectRequest(handler, test.method, test.path, "")
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != test.allow {
			t.Fatal("incorrect allowed methods")
		}
	}
	request := httptest.NewRequest(http.MethodPost, path+"/report", strings.NewReader(jsonBody(t, workerSnapshotReportBody())))
	authorizeResourceRequest(handler, request)
	request.Header.Set("Content-Type", "text/plain")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatal("non-JSON report accepted")
	}
}
