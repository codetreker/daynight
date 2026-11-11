//go:build integration

package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func serverAPIWorkerToolPathsFlow(t *testing.T, f *fixture) {
	for _, webFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "bootstrap before web PUT", true: "web PUT before bootstrap"}[webFirst], func(t *testing.T) {
			workerID := uuid.NewString()
			base := "/api/v1/me/workers/" + workerID
			request := func(method, path string, body any, tools, configuration bool, status int) []byte {
				t.Helper()
				var encoded []byte
				var err error
				if body != nil {
					encoded, err = json.Marshal(body)
					if err != nil {
						t.Fatal(err)
					}
				}
				req, err := http.NewRequestWithContext(f.context, method, f.origin+path, bytes.NewReader(encoded))
				if err != nil {
					t.Fatal(err)
				}
				req.Header.Set("Content-Type", "application/json")
				if tools {
					req.Header.Set("Daynight-Worker-Tool-Paths", "1")
				}
				if configuration {
					req.Header.Set("Daynight-Worker-Configuration", "1")
				}
				response, err := f.client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				data, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
				closeErr := response.Body.Close()
				if readErr != nil || closeErr != nil || response.StatusCode != status {
					t.Fatalf("%s %s: status=%d body=%s read=%v close=%v", method, path, response.StatusCode, data, readErr, closeErr)
				}
				if status == http.StatusOK && tools && response.Header.Get("Daynight-Worker-Tool-Paths") != "1" {
					t.Fatal("tool capability not acknowledged")
				}
				return data
			}
			read := func() model.WorkerConfigurationResource {
				t.Helper()
				var result model.WorkerConfigurationResource
				if err := json.Unmarshal(request(http.MethodGet, base+"/configuration", nil, true, false, http.StatusOK), &result); err != nil {
					t.Fatal(err)
				}
				return result
			}
			stamp := time.Now().UTC().Format(time.RFC3339Nano)
			probe := func(value any) any { return map[string]any{"state": "ok", "checkedAt": stamp, "value": value} }
			report := map[string]any{"machine": map[string]any{"id": uuid.NewString(), "name": "Tool path integration"}, "platform": "linux", "workingDirectory": "/work", "sampledAt": stamp, "os": probe(map[string]any{"type": "Linux", "release": "6.8", "version": "kernel", "arch": "x64"}), "cpu": probe(map[string]any{"model": "CPU", "logicalProcessors": 4, "usagePercent": 1}), "memory": probe(map[string]any{"usedBytes": 4, "totalBytes": 8}), "disk": probe(map[string]any{"availableBytes": 8, "totalBytes": 16}), "versions": map[string]any{"daynight": "1.0.0", "herdr": probe("1.0.0"), "codex": probe("1.0.0"), "copilot": probe("1.0.0")}, "taskInventory": nil}
			// Existing Workers have an initialized target whose tool choices are unadopted.
			legacy := map[string]any{"maxConcurrent": 1, "pollIntervalMs": 60000, "recoveryLimit": 3, "preferPlatformSpecificTasks": false, "native": map[string]any{"agent": "codex", "model": nil, "args": []string{}}, "projects": []any{}}
			report["configuration"] = map[string]any{"bootstrap": legacy, "observation": nil}
			request(http.MethodPost, base+"/report", report, false, true, http.StatusOK)
			initial := read()
			if initial.Desired.Revision != "1" || initial.Desired.Value.ToolPaths != (model.WorkerToolPaths{}) {
				t.Fatalf("initial choices invented: %+v", initial)
			}
			local := model.WorkerToolPaths{Codex: &model.ToolPathChoice{Kind: "path", Path: "/local/codex"}, Copilot: &model.ToolPathChoice{Kind: "path", Path: "/local/copilot"}, Herdr: &model.ToolPathChoice{Kind: "auto"}}
			web := initial.Desired.Value
			web.ToolPaths.Codex = &model.ToolPathChoice{Kind: "path", Path: "/cloud/codex"}
			webBody := func(revision string) map[string]any {
				raw, _ := json.Marshal(web)
				var value map[string]any
				if err := json.Unmarshal(raw, &value); err != nil {
					t.Fatal(err)
				}
				delete(value, "agentControlMode")
				return map[string]any{"revision": revision, "value": value}
			}
			bootstrap := func() {
				report["configuration"] = map[string]any{"bootstrap": nil, "observation": nil, "toolPathsBootstrap": local}
				report["toolPaths"] = map[string]any{"schemaVersion": 1, "observedAt": stamp, "entries": []any{}}
				request(http.MethodPost, base+"/report", report, true, true, http.StatusOK)
			}
			if webFirst {
				request(http.MethodPut, base+"/configuration", webBody("1"), true, false, http.StatusOK)
				bootstrap()
			} else {
				bootstrap()
				adopted := read()
				web = adopted.Desired.Value
				web.ToolPaths.Codex = &model.ToolPathChoice{Kind: "path", Path: "/cloud/codex"}
				request(http.MethodPut, base+"/configuration", webBody(adopted.Desired.Revision), true, false, http.StatusOK)
			}
			current := read()
			expected := local
			expected.Codex = web.ToolPaths.Codex
			if current.Desired.Revision != "3" || !reflect.DeepEqual(current.Desired.Value.ToolPaths, expected) {
				t.Fatalf("committed adoption order lost choices: %+v want=%+v", current, expected)
			}
			legacy["maxConcurrent"] = 2
			request(http.MethodPut, base+"/configuration", map[string]any{"revision": current.Desired.Revision, "value": legacy}, false, false, http.StatusOK)
			saved := read()
			if !reflect.DeepEqual(saved.Desired.Value.ToolPaths, expected) || saved.Desired.Value.MaxConcurrent != 2 {
				t.Fatalf("legacy save erased adopted choices: %+v", saved)
			}
			// Explicit auto survives another local bootstrap, including the former path.
			reset := saved.Desired.Value
			reset.ToolPaths.Codex = &model.ToolPathChoice{Kind: "auto"}
			raw, _ := json.Marshal(reset)
			var resetBody map[string]any
			if err := json.Unmarshal(raw, &resetBody); err != nil {
				t.Fatal(err)
			}
			delete(resetBody, "agentControlMode")
			request(http.MethodPut, base+"/configuration", map[string]any{"revision": saved.Desired.Revision, "value": resetBody}, true, false, http.StatusOK)
			before := read()
			bootstrap()
			after := read()
			if after.Desired.Revision != before.Desired.Revision || after.Desired.Value.ToolPaths.Codex.Kind != "auto" {
				t.Fatalf("local path resurrected after explicit auto: before=%+v after=%+v", before, after)
			}
		})
	}
}
