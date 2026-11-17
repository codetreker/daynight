//go:build integration

package main

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/monitoring"
	"github.com/google/uuid"
)

func serverAPIWorkerMonitoringFlow(t *testing.T, f *fixture) {
	stamp := time.Now().UTC().Truncate(time.Millisecond).Format(time.RFC3339Nano)
	probe := func(value any) any { return map[string]any{"state": "ok", "checkedAt": stamp, "value": value} }
	ids := []string{uuid.NewString(), uuid.NewString()}
	for _, id := range ids {
		report := map[string]any{
			"machine": map[string]any{"id": uuid.NewString(), "name": "Monitoring integration"}, "platform": "linux", "workingDirectory": "/work", "sampledAt": stamp,
			"os":     probe(map[string]any{"type": "Linux", "release": "6.8", "version": "kernel", "arch": "x64"}),
			"cpu":    probe(map[string]any{"model": "CPU", "logicalProcessors": 4, "usagePercent": 1}),
			"memory": probe(map[string]any{"usedBytes": 4, "totalBytes": 8}), "disk": probe(map[string]any{"availableBytes": 8, "totalBytes": 16}),
			"versions": map[string]any{"daynight": "1.0.0", "codex": probe("1.0.0"), "copilot": probe("1.0.0")}, "taskInventory": nil,
		}
		requestJSON[map[string]any](t, f, http.MethodPost, "/api/v1/me/workers/"+id+"/report", report, http.StatusOK, http.Header{"Daynight-Worker-Tool-Paths": {"2"}})
	}
	observation := func(occupied int, lifecycle string) map[string]any {
		return map[string]any{
			"capturedAt": stamp, "lifecycle": lifecycle,
			"scheduler":    map[string]any{"phase": "waiting-poll", "coverage": "complete", "cycleId": nil, "lastCompletedAt": nil, "lastSuccessfulAt": nil, "lastOutcome": nil, "nextPollAt": nil},
			"capacity":     map[string]any{"observedAt": stamp, "quality": "current", "limit": 4, "occupied": occupied, "available": 4 - occupied, "detailCoverage": "complete", "breakdown": map[string]any{"active": occupied - 1, "retained": 1}},
			"admission":    map[string]any{"observedAt": stamp, "coverage": "complete", "reasons": []any{}},
			"reservations": []any{}, "activities": []any{}, "currentFailures": []any{}, "lastRecovery": nil, "detailCoverage": "complete", "delivery": map[string]any{"lastSucceededAt": nil, "lastFailure": nil},
		}
	}
	path := func(id string) string { return "/api/v1/me/workers/" + id + "/monitoring" }
	legacy := observation(2, "running")
	runID := uuid.NewString()
	legacy["runId"], legacy["sequence"] = runID, "1"
	before := requestJSON[monitoring.DetailResponse](t, f, http.MethodGet, path(ids[0]), nil, http.StatusOK)
	if before.State != "absent" {
		t.Fatalf("new monitoring: %+v", before)
	}
	oldReceipt := requestJSON[monitoring.Receipt](t, f, http.MethodPut, path(ids[0]), map[string]any{"expectedRevision": nil, "observation": legacy}, http.StatusOK)
	directReceipt := requestJSON[map[string]json.RawMessage](t, f, http.MethodPost, path(ids[1]), observation(3, "stopping"), http.StatusOK)
	if len(directReceipt) != 2 || directReceipt["receivedAt"] == nil || directReceipt["expiresAt"] == nil {
		t.Fatalf("direct receipt: %v", directReceipt)
	}
	var received, expires time.Time
	if json.Unmarshal(directReceipt["receivedAt"], &received) != nil || json.Unmarshal(directReceipt["expiresAt"], &expires) != nil || expires.Sub(received) != time.Hour {
		t.Fatalf("direct receipt times: %s %s", directReceipt["receivedAt"], directReceipt["expiresAt"])
	}
	for i, id := range ids {
		detail := requestJSON[monitoring.DetailResponse](t, f, http.MethodGet, path(id), nil, http.StatusOK)
		if detail.State != "available" || detail.RunID == nil || detail.Revision == nil || detail.Sequence == nil || *detail.Sequence != "1" || detail.Data["runId"] != *detail.RunID || detail.Data["sequence"] != "1" || detail.Data["capturedAt"] != stamp || detail.ExpiresAt.Sub(*detail.ReceivedAt) != time.Hour {
			t.Fatalf("detail %d: %+v", i, detail)
		}
		capacity := detail.Data["capacity"].(map[string]any)
		breakdown := capacity["breakdown"].(map[string]any)
		if capacity["occupied"] != float64(i+2) || breakdown["active"] != float64(i+1) || breakdown["retained"] != float64(1) {
			t.Fatalf("capacity %d: %v", i, capacity)
		}
		if i == 0 && (*detail.RunID != runID || *detail.Revision != oldReceipt.Revision) {
			t.Fatalf("legacy identity: %+v", detail)
		}
		if i == 1 && (*detail.RunID == runID || !detail.ReceivedAt.Equal(received) || !detail.ExpiresAt.Equal(expires) || detail.Data["lifecycle"] != "stopping") {
			t.Fatalf("direct identity: %+v", detail)
		}
	}
	query := requestJSON[monitoring.QueryResponse](t, f, http.MethodPost, "/api/v1/me/workers/monitoring/query", map[string]any{"workerIds": ids}, http.StatusOK)
	if len(query.Items) != 2 {
		t.Fatalf("query: %+v", query)
	}
	for i, item := range query.Items {
		var summary struct {
			Capacity struct {
				Occupied  int                            `json:"occupied"`
				Breakdown struct{ Active, Retained int } `json:"breakdown"`
			} `json:"capacity"`
		}
		if item.WorkerID != ids[i] || item.State != "available" || json.Unmarshal(item.Summary, &summary) != nil || summary.Capacity.Occupied != i+2 || summary.Capacity.Breakdown.Active != i+1 || summary.Capacity.Breakdown.Retained != 1 {
			t.Fatalf("summary %d: %+v %s", i, item, item.Summary)
		}
	}
}
