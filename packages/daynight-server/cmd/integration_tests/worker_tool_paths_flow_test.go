//go:build integration

package main

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

func serverAPIWorkerToolPathsFlow(t *testing.T, f *fixture) {
	workerID := uuid.NewString()
	base := "/api/v1/me/workers/" + workerID
	headers := http.Header{"Daynight-Worker-Tool-Paths": {"2"}, "Daynight-Worker-Archive-Sessions": {"1"}}
	reportHeaders := headers.Clone()
	reportHeaders.Set("Daynight-Worker-Configuration", "1")
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	probe := func(value any) any { return map[string]any{"state": "ok", "checkedAt": stamp, "value": value} }
	paths := map[string]any{"codex": map[string]any{"kind": "path", "path": "/local/codex"}, "copilot": map[string]any{"kind": "auto"}}
	candidate := map[string]any{"maxConcurrent": 1, "pollIntervalMs": 60000, "recoveryLimit": 3, "preferPlatformSpecificTasks": false, "enableSudoCleanup": true, "archiveSessions": true, "native": map[string]any{"agent": "codex", "model": nil, "args": []string{}}, "projects": []any{}, "toolPaths": paths}
	report := map[string]any{
		"machine": map[string]any{"id": uuid.NewString(), "name": "Tool path integration"}, "platform": "linux", "workingDirectory": "/work", "sampledAt": stamp,
		"os":     probe(map[string]any{"type": "Linux", "release": "6.8", "version": "kernel", "arch": "x64"}),
		"cpu":    probe(map[string]any{"model": "CPU", "logicalProcessors": 4, "usagePercent": 1}),
		"memory": probe(map[string]any{"usedBytes": 4, "totalBytes": 8}), "disk": probe(map[string]any{"availableBytes": 8, "totalBytes": 16}),
		"versions": map[string]any{"daynight": "1.0.0", "codex": probe("1.0.0"), "copilot": probe("1.0.0")}, "taskInventory": nil,
		"toolPaths":     map[string]any{"schemaVersion": 1, "observedAt": stamp, "entries": []any{}},
		"configuration": map[string]any{"bootstrap": candidate, "observation": nil, "toolPathsBootstrap": paths},
	}
	requestJSON[json.RawMessage](t, f, http.MethodPost, base+"/report", report, http.StatusOK, reportHeaders)
	type desired struct {
		Desired struct {
			Revision string         `json:"revision"`
			Value    map[string]any `json:"value"`
		} `json:"desired"`
	}
	read := func() desired {
		t.Helper()
		return requestJSON[desired](t, f, http.MethodGet, base+"/configuration", nil, http.StatusOK, headers)
	}
	initial := read()
	if initial.Desired.Revision != "1" || initial.Desired.Value["archiveSessions"] != true || initial.Desired.Value["enableSudoCleanup"] != true {
		t.Fatalf("bootstrap lost settings: %+v", initial)
	}
	candidate["archiveSessions"] = false
	paths["codex"] = map[string]any{"kind": "path", "path": "/cloud/codex"}
	requestJSON[json.RawMessage](t, f, http.MethodPut, base+"/configuration", map[string]any{"revision": initial.Desired.Revision, "value": candidate}, http.StatusOK, headers)
	saved := read()
	gotPaths, ok := saved.Desired.Value["toolPaths"].(map[string]any)
	if saved.Desired.Revision != "2" || saved.Desired.Value["archiveSessions"] != false || saved.Desired.Value["enableSudoCleanup"] != true || !ok || len(gotPaths) != 2 || gotPaths["codex"].(map[string]any)["path"] != "/cloud/codex" || gotPaths["copilot"].(map[string]any)["kind"] != "auto" {
		t.Fatalf("saved target lost settings or choices: %+v", saved)
	}
	// A later bootstrap cannot replace an explicit cloud choice.
	report["configuration"] = map[string]any{"bootstrap": nil, "observation": nil, "toolPathsBootstrap": map[string]any{"codex": map[string]any{"kind": "path", "path": "/local/codex"}, "copilot": map[string]any{"kind": "auto"}}}
	requestJSON[json.RawMessage](t, f, http.MethodPost, base+"/report", report, http.StatusOK, reportHeaders)
	after := read()
	if after.Desired.Revision != saved.Desired.Revision || after.Desired.Value["toolPaths"].(map[string]any)["codex"].(map[string]any)["path"] != "/cloud/codex" {
		t.Fatalf("bootstrap changed the saved target: %+v", after)
	}
	serverAPIWorkerAliasFlow(t, f, workerID)
	serverAPIWorkerReviewParticipationFlow(t, f, workerID, report, candidate, headers, reportHeaders)
}
