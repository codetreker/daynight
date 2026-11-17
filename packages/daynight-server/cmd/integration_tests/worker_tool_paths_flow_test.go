//go:build integration

package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func serverAPIWorkerToolPathsFlow(t *testing.T, f *fixture) {
	workerID := uuid.NewString()
	base := "/api/v1/me/workers/" + workerID
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	probe := func(value any) any { return map[string]any{"state": "ok", "checkedAt": stamp, "value": value} }
	choice := map[string]any{"kind": "auto"}
	target := map[string]any{"maxConcurrent": 1, "pollIntervalMs": 60000, "recoveryLimit": 3, "preferPlatformSpecificTasks": false, "native": map[string]any{"agent": "codex", "model": nil, "args": []string{}}, "projects": []any{}, "toolPaths": map[string]any{"codex": choice, "copilot": choice}}
	report := map[string]any{"machine": map[string]any{"id": uuid.NewString(), "name": "Tool path integration"}, "platform": "linux", "workingDirectory": "/work", "sampledAt": stamp, "os": probe(map[string]any{"type": "Linux", "release": "6.8", "version": "kernel", "arch": "x64"}), "cpu": probe(map[string]any{"model": "CPU", "logicalProcessors": 4, "usagePercent": 1}), "memory": probe(map[string]any{"usedBytes": 4, "totalBytes": 8}), "disk": probe(map[string]any{"availableBytes": 8, "totalBytes": 16}), "versions": map[string]any{"daynight": "1.0.0", "codex": probe("1.0.0"), "copilot": probe("1.0.0")}, "taskInventory": nil, "configuration": map[string]any{"bootstrap": target, "observation": nil, "toolPathsBootstrap": nil}}
	encode := func(value any) []byte {
		t.Helper()
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	sendReport := func() {
		t.Helper()
		req, err := http.NewRequestWithContext(f.context, http.MethodPost, f.origin+base+"/report", bytes.NewReader(encode(report)))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Daynight-Worker-Configuration", "1")
		response, err := f.client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK || response.Header.Get("Daynight-Worker-Tool-Paths") != "2" {
			t.Fatalf("report: %s", response.Status)
		}
	}
	read := func() model.WorkerConfigurationResource {
		t.Helper()
		return requestJSON[model.WorkerConfigurationResource](t, f, http.MethodGet, base+"/configuration", nil, http.StatusOK)
	}
	sendReport()
	initial := read()
	if initial.Desired == nil || initial.Desired.Revision != "1" {
		t.Fatalf("initial: %+v", initial)
	}
	paths := target["toolPaths"].(map[string]any)
	paths["codex"] = map[string]any{"kind": "path", "path": "/cloud/codex"}
	saved := requestJSON[model.WorkerConfigurationResource](t, f, http.MethodPut, base+"/configuration", map[string]any{"revision": "1", "value": target}, http.StatusOK)
	if saved.Desired == nil || saved.Desired.Revision != "2" || saved.Desired.Value.ToolPaths.Codex.Path != "/cloud/codex" {
		t.Fatalf("saved target: %+v", saved)
	}
	f.request(t, http.MethodPut, base+"/configuration", "application/json", encode(map[string]any{"revision": "1", "value": target}), http.StatusConflict)
	report["configuration"] = map[string]any{"bootstrap": nil, "observation": nil, "toolPathsBootstrap": map[string]any{"codex": map[string]any{"kind": "path", "path": "/local/codex"}, "copilot": choice}}
	sendReport()
	after := read()
	if after.Desired.Revision != "2" || after.Desired.Value.ToolPaths.Codex.Path != "/cloud/codex" {
		t.Fatalf("report replaced explicit choice: %+v", after)
	}
}
