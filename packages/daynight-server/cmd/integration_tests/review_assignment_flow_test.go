//go:build integration

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

type reviewAssignmentResponse struct {
	Status     string `json:"status"`
	Assignment *struct {
		WorkerID      string    `json:"workerId"`
		AssignedAt    time.Time `json:"assignedAt"`
		Online        *bool     `json:"online"`
		ReviewEnabled *bool     `json:"reviewEnabled"`
	} `json:"assignment"`
}

// Exercise a saved PR and an independently enabled Worker through the real
// background reconciliation loop and public APIs.
func serverAPIReviewAssignmentFlow(t *testing.T, f *fixture, projectID string) {
	t.Helper()
	path := "/api/v1/projects/" + projectID + "/pull-requests/1/review-assignment"
	read := func() reviewAssignmentResponse {
		t.Helper()
		response, body := f.request(t, http.MethodGet, path, "", nil, http.StatusOK)
		if response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("assignment cache policy: %q", response.Header.Get("Cache-Control"))
		}
		var value reviewAssignmentResponse
		if err := json.Unmarshal(body, &value); err != nil {
			t.Fatalf("assignment response: %v", err)
		}
		return value
	}
	waiting := read()
	if waiting.Status != "waiting" || waiting.Assignment != nil {
		t.Fatalf("unassigned open PR: %+v", waiting)
	}

	workerID := uuid.NewString()
	workerBase := "/api/v1/me/workers/" + workerID
	headers := http.Header{"Daynight-Worker-Tool-Paths": {"2"}, "Daynight-Worker-Archive-Sessions": {"1"}}
	reportHeaders := headers.Clone()
	reportHeaders.Set("Daynight-Worker-Configuration", "1")
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	probe := func(value any) any { return map[string]any{"state": "ok", "checkedAt": stamp, "value": value} }
	paths := map[string]any{"codex": map[string]any{"kind": "auto"}, "copilot": map[string]any{"kind": "auto"}}
	bootstrap := map[string]any{
		"maxConcurrent": 1, "pollIntervalMs": 60000, "recoveryLimit": 3,
		"preferPlatformSpecificTasks": false, "enableSudoCleanup": false, "archiveSessions": true,
		"native":   map[string]any{"agent": "codex", "model": nil, "args": []string{}},
		"projects": []any{map[string]any{"projectId": projectID, "nativeOverrides": map[string]any{}}}, "toolPaths": paths,
	}
	report := map[string]any{
		"machine":  map[string]any{"id": uuid.NewString(), "name": "Review assignment integration"},
		"platform": "linux", "workingDirectory": "/work", "sampledAt": stamp,
		"os":     probe(map[string]any{"type": "Linux", "release": "6.8", "version": "kernel", "arch": "x64"}),
		"cpu":    probe(map[string]any{"model": "CPU", "logicalProcessors": 4, "usagePercent": 1}),
		"memory": probe(map[string]any{"usedBytes": 4, "totalBytes": 8}), "disk": probe(map[string]any{"availableBytes": 8, "totalBytes": 16}),
		"versions": map[string]any{"daynight": "1.0.0", "codex": probe("1.0.0"), "copilot": probe("1.0.0")}, "taskInventory": nil,
		"toolPaths":     map[string]any{"schemaVersion": 1, "observedAt": stamp, "entries": []any{}},
		"configuration": map[string]any{"bootstrap": bootstrap, "observation": nil, "toolPathsBootstrap": paths},
	}
	requestJSON[json.RawMessage](t, f, http.MethodPost, workerBase+"/report", report, http.StatusOK, reportHeaders)
	type participation struct {
		Enabled bool   `json:"enabled"`
		Version string `json:"version"`
	}
	initial := requestJSON[participation](t, f, http.MethodGet, workerBase+"/review-participation", nil, http.StatusOK)
	if initial.Enabled || initial.Version != "1" {
		t.Fatalf("initial participation: %+v", initial)
	}
	enabled := requestJSON[participation](t, f, http.MethodPut, workerBase+"/review-participation", map[string]any{"enabled": true, "expectedVersion": initial.Version}, http.StatusOK)
	if !enabled.Enabled || enabled.Version != "2" {
		t.Fatalf("enabled participation: %+v", enabled)
	}

	ctx, cancel := context.WithTimeout(f.context, 60*time.Second)
	defer cancel()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	var assigned reviewAssignmentResponse
	for {
		assigned = read()
		if assigned.Status == "assigned" {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("waiting for assignment: %+v\n%s", assigned, f.process.logs.String())
		case <-ticker.C:
		}
	}
	if assigned.Assignment == nil || assigned.Assignment.WorkerID != workerID || assigned.Assignment.AssignedAt.IsZero() || assigned.Assignment.Online == nil || !*assigned.Assignment.Online || assigned.Assignment.ReviewEnabled == nil || !*assigned.Assignment.ReviewEnabled {
		t.Fatalf("assignment differs: %+v", assigned)
	}
	disabled := requestJSON[participation](t, f, http.MethodPut, workerBase+"/review-participation", map[string]any{"enabled": false, "expectedVersion": enabled.Version}, http.StatusOK)
	if disabled.Enabled || disabled.Version != "3" {
		t.Fatalf("disabled participation: %+v", disabled)
	}
	retained := read()
	if retained.Status != "assigned" || retained.Assignment == nil || retained.Assignment.WorkerID != workerID || !retained.Assignment.AssignedAt.Equal(assigned.Assignment.AssignedAt) || retained.Assignment.ReviewEnabled == nil || *retained.Assignment.ReviewEnabled {
		t.Fatalf("retained assignment: %+v", retained)
	}
}
