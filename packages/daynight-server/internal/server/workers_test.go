package server

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
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
	f := newWorkerHTTPFixture(t, &logs)
	handler := f.handler
	empty := f.list(t, "/api/v1/me/workers", store.Page{Limit: 50}, nil)
	if empty.Items == nil || len(empty.Items) != 0 || empty.NextCursor != nil || empty.ObservedAt.IsZero() {
		t.Fatal("invalid empty worker page")
	}
	id := "c3333333-3333-4333-8333-333333333333"
	body := workerSnapshotReportBody()
	body["taskInventory"] = nil
	unknownSnapshot := model.WorkerSnapshot{UserID: handler.principal.UserID, WorkerID: id, CreatedAt: f.now, LastReportedAt: f.now, Telemetry: workerHTTPTelemetry(t, body), TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}}}
	reported := f.report(t, strings.ToUpper(id), body, nil, nil, unknownSnapshot)
	if reported.ObservedAt.IsZero() || reported.LastReportedAt.IsZero() {
		t.Fatal("report lacks server timestamps")
	}
	unknown := f.detail(t, id, unknownSnapshot)
	if unknown.Worker.ActiveTaskCount != nil || unknown.Worker.TaskObservationState != "unavailable" || unknown.Worker.TaskObservedAt != nil || unknown.Worker.InventoryObservedAt != nil || unknown.Worker.Tasks == nil {
		t.Fatalf("unknown inventory became idle: %+v", unknown)
	}
	body = workerSnapshotReportBody()
	inventoryAt := time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC)
	idleSnapshot := model.WorkerSnapshot{UserID: handler.principal.UserID, WorkerID: id, CreatedAt: f.now, LastReportedAt: f.now, Telemetry: workerHTTPTelemetry(t, body), TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &f.now, InventoryObservedAt: &inventoryAt, Items: []model.WorkerObservedTask{}}}
	f.report(t, id, body, nil, []model.WorkerObservedTask{}, idleSnapshot)
	idle := f.detail(t, id, idleSnapshot)
	if idle.Worker.ActiveTaskCount == nil || *idle.Worker.ActiveTaskCount != 0 || idle.Worker.TaskObservationState != "observed" || idle.Worker.TaskObservedAt == nil || idle.Worker.InventoryObservedAt == nil || idle.Worker.Telemetry.CPU.Value == nil || idle.Worker.Telemetry.Versions.Codex.State != "not_installed" || idle.Worker.Telemetry.Versions.Copilot.Code == nil {
		t.Fatalf("idle or telemetry shape incorrect: %+v", idle)
	}
	projectID, taskID, claimID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	claim := map[string]any{"claimId": claimID, "state": "active", "userId": handler.principal.UserID, "workerId": id, "machine": map[string]any{"id": uuid.NewString(), "name": "Worker"}, "platform": "linux", "agent": "claude", "agentControlMode": "web", "worktreeId": uuid.NewString(), "phase": "preparing", "herdr": nil, "nativeSessionId": nil, "claimedAt": f.now.Format(time.RFC3339Nano)}
	task := model.Task{ID: taskID, ProjectID: projectID, Title: "Snapshot-owned task", Status: model.TaskInProgress, Properties: model.TaskProperties{"worker": json.RawMessage(jsonBody(t, claim)), "pullRequests": json.RawMessage(`[{"url":"opaque\u0000","title":"Opaque evidence"}]`)}}
	body["taskInventory"] = map[string]any{"observedAt": "2026-10-29T00:00:00Z", "claims": []any{map[string]any{"projectId": projectID, "taskId": taskID, "claimId": claimID}}}
	expectedItems := []model.WorkerObservedTask{{ProjectID: projectID, TaskID: taskID, ClaimID: claimID, Title: task.Title, ProjectName: "Project", Status: model.TaskInProgress, Phase: model.WorkerPreparing, Agent: model.AgentClaude}}
	activeSnapshot := model.WorkerSnapshot{UserID: handler.principal.UserID, WorkerID: id, CreatedAt: f.now, LastReportedAt: f.now, Telemetry: workerHTTPTelemetry(t, body), TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &f.now, InventoryObservedAt: &inventoryAt, Items: expectedItems}}
	f.report(t, id, body, []store.WorkerTaskSource{{Task: task, ProjectName: "Project"}}, expectedItems, activeSnapshot)
	active := f.detail(t, id, activeSnapshot)
	if active.Worker.ActiveTaskCount == nil || *active.Worker.ActiveTaskCount != 1 || len(active.Worker.Tasks) != 1 || active.Worker.Tasks[0].Agent != "claude" || active.Worker.Tasks[0].Title != task.Title {
		t.Fatalf("authorized task snapshot missing: %+v", active)
	}
	body["taskInventory"] = nil
	staleSnapshot := activeSnapshot
	staleSnapshot.TaskSnapshot.State = model.WorkerTasksStale
	f.report(t, id, body, nil, nil, staleSnapshot)
	stale := f.detail(t, id, staleSnapshot)
	if stale.Worker.TaskObservationState != "stale" || len(stale.Worker.Tasks) != 1 || stale.Worker.Tasks[0].Status != "in_progress" || stale.Worker.TaskObservedAt == nil || !stale.Worker.TaskObservedAt.Equal(*active.Worker.TaskObservedAt) {
		t.Fatalf("historical snapshot was overwritten by current task state: %+v", stale)
	}
	lastSeen := stale.Worker.LastReportedAt
	if next := f.detail(t, id, staleSnapshot); !next.Worker.LastReportedAt.Equal(lastSeen) {
		t.Fatal("GET refreshed liveness")
	}
	second := "d4444444-4444-4444-8444-444444444444"
	secondBody := workerSnapshotReportBody()
	secondBody["versions"].(map[string]any)["herdr"] = map[string]any{"state": "not_running", "checkedAt": "2026-10-29T00:00:00Z"}
	secondSnapshot := model.WorkerSnapshot{UserID: handler.principal.UserID, WorkerID: second, CreatedAt: f.now, LastReportedAt: f.now, Telemetry: workerHTTPTelemetry(t, secondBody), TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &f.now, InventoryObservedAt: &inventoryAt, Items: []model.WorkerObservedTask{}}}
	f.report(t, second, secondBody, nil, []model.WorkerObservedTask{}, secondSnapshot)
	count := 1
	summaries := []store.WorkerSummary{{WorkerID: id, CreatedAt: staleSnapshot.CreatedAt, LastReportedAt: lastSeen, Machine: staleSnapshot.Telemetry.Machine, Platform: model.PlatformLinux, TaskObservationState: model.WorkerTasksStale, TaskObservedAt: &f.now, ActiveTaskCount: &count}, {WorkerID: second, CreatedAt: secondSnapshot.CreatedAt, LastReportedAt: secondSnapshot.LastReportedAt, Machine: secondSnapshot.Telemetry.Machine, Platform: model.PlatformLinux, TaskObservationState: model.WorkerTasksObserved}}
	page := f.list(t, "/api/v1/me/workers?limit=1", store.Page{Limit: 1}, summaries)
	if len(page.Items) != 1 || page.Items[0].WorkerID != id || page.NextCursor == nil {
		t.Fatalf("first page incorrect: %+v", page)
	}
	next := f.list(t, "/api/v1/me/workers?limit=1&cursor="+url.QueryEscape(*page.NextCursor), store.Page{Limit: 1, After: &store.Position{CreatedAt: staleSnapshot.CreatedAt, ID: id}}, summaries[1:])
	if len(next.Items) != 1 || next.Items[0].WorkerID != second || next.NextCursor != nil {
		t.Fatalf("stable continuation incorrect: %+v", next)
	}
	if text := logs.String(); !strings.Contains(text, `"worker_id":"`+id+`"`) || !strings.Contains(text, `"component":"worker_report"`) || strings.Contains(text, "/private/work") || strings.Contains(text, "Private worker machine") || strings.Contains(text, "Snapshot-owned task") {
		t.Fatal("worker logs lack correlation or expose private content")
	}
}

func TestWorkerSnapshotsHTTPRejectsInvalidInputsAndMethods(t *testing.T) {
	f := newWorkerHTTPFixture(t, io.Discard)
	handler := f.handler
	id := uuid.NewString()
	path := "/api/v1/me/workers/" + id
	for _, body := range []string{"", `null`, `[]`, `{}`, `{"state":true}`, `{"machine":null,"machine":null}`, string([]byte{'{', 0xff, '}'})} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, path+"/report", body), http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPost, path+"/report", strings.Repeat(" ", httpx.MaxJSONBody)+"{}"), http.StatusRequestEntityTooLarge, "payload_too_large")
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
	calls := 0
	f.read(t, &workerHTTPReader{t: t, WorkerCall: func(_ context.Context, u, w string, now time.Time) (model.WorkerSnapshot, error) {
		calls++
		if u != handler.principal.UserID || w != id || now != f.now {
			t.Fatal("wrong missing-worker query")
		}
		return model.WorkerSnapshot{}, model.ErrNotFound
	}}, func() {
		assertProjectError(t, projectRequest(handler, http.MethodGet, path, ""), http.StatusNotFound, "not_found")
	})
	if calls != 1 {
		t.Fatalf("missing-worker calls: %d", calls)
	}
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
