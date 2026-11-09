//go:build integration

package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func TestServerAPIPromptNormalFlow(t *testing.T) {
	f := newFixture(t)
	project := createProject(t, f, "Personal prompt API")
	workerID := uuid.NewString()
	path := "/api/v1/me/workers/" + workerID + "/report"
	stamp := "2026-10-29T00:00:00Z"
	probe := func(value any) map[string]any {
		return map[string]any{"state": "ok", "checkedAt": stamp, "value": value}
	}
	body := map[string]any{
		"machine": map[string]any{"id": uuid.NewString(), "name": "Integration machine"}, "platform": "linux", "workingDirectory": "/work", "sampledAt": stamp,
		"os":     probe(map[string]any{"type": "Linux", "release": "6.8", "version": "kernel", "arch": "x64"}),
		"cpu":    probe(map[string]any{"model": "CPU", "logicalProcessors": 4, "usagePercent": 12.5}),
		"memory": probe(map[string]any{"usedBytes": 4, "totalBytes": 8}), "disk": probe(map[string]any{"availableBytes": 8, "totalBytes": 16}),
		"versions":      map[string]any{"daynight": "1.0.0", "herdr": probe("0.9.5"), "codex": map[string]any{"state": "not_installed", "checkedAt": stamp}, "copilot": map[string]any{"state": "error", "checkedAt": stamp, "code": "timeout"}},
		"taskInventory": nil, "configuration": map[string]any{"bootstrap": nil, "observation": nil},
	}
	report := func(selectors string) []model.PromptResult {
		t.Helper()
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequestWithContext(f.context, http.MethodPost, f.origin+path, bytes.NewReader(encoded))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Daynight-Worker-Configuration", "2")
		req.Header.Set("Daynight-Worker-Prompts", selectors)
		resp, err := f.client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		data, readErr := io.ReadAll(resp.Body)
		closeErr := resp.Body.Close()
		if readErr != nil || closeErr != nil || resp.StatusCode != http.StatusOK || resp.Header.Get("Daynight-Worker-Configuration") != "2" {
			t.Fatalf("report: status=%d body=%s read=%v close=%v", resp.StatusCode, data, readErr, closeErr)
		}
		var receipt struct {
			Configuration struct {
				Prompts []model.PromptResult `json:"prompts"`
			} `json:"configuration"`
		}
		if err := json.Unmarshal(data, &receipt); err != nil {
			t.Fatal(err)
		}
		return receipt.Configuration.Prompts
	}
	report(`[]`) // Registers the Worker through its normal configuration report.
	paths := []string{"/api/v1/me/worker-prompt", "/api/v1/me/projects/" + project.ID + "/worker-prompt", "/api/v1/me/workers/" + workerID + "/prompt"}
	texts := []string{"user text", "project text", "worker text"}
	scopes := []model.PromptScope{model.PromptScopeUser, model.PromptScopeProject, model.PromptScopeWorker}
	ids := []string{f.userID, project.ID, workerID}
	for i, resourcePath := range paths {
		saved := requestJSON[model.PromptResource](t, f, http.MethodPut, resourcePath, map[string]any{"expectedUserId": f.userID, "revision": "0", "text": texts[i]}, http.StatusOK)
		read := requestJSON[model.PromptResource](t, f, http.MethodGet, resourcePath, nil, http.StatusOK)
		if saved.Scope != scopes[i] || saved.ScopeID != ids[i] || saved.Revision != "1" || saved.Text != texts[i] || !reflect.DeepEqual(read, saved) {
			t.Fatalf("prompt save/read: %+v %+v", saved, read)
		}
	}
	selectors := `[{"key":{"scope":"user"},"knownRevision":null},{"key":{"scope":"project","projectId":"` + project.ID + `"},"knownRevision":null},{"key":{"scope":"worker"},"knownRevision":null}]`
	results := report(selectors)
	if len(results) != 3 {
		t.Fatalf("prompt count: %+v", results)
	}
	for i, result := range results {
		if result.Status != "value" || result.Value == nil || result.Value.Scope != scopes[i] || result.Value.ScopeID != ids[i] || result.Value.Revision != "1" || result.Value.Text != texts[i] {
			t.Fatalf("prompt result %d: %+v", i, result)
		}
	}
	known := `[{"key":{"scope":"user"},"knownRevision":"1"},{"key":{"scope":"project","projectId":"` + project.ID + `"},"knownRevision":"1"},{"key":{"scope":"worker"},"knownRevision":"1"}]`
	unchanged := report(known)
	if len(unchanged) != 3 {
		t.Fatalf("unchanged count: %+v", unchanged)
	}
	for _, result := range unchanged {
		if result.Status != "unchanged" || result.Revision != "1" {
			t.Fatalf("unchanged: %+v", result)
		}
	}
	cleared := requestJSON[model.PromptResource](t, f, http.MethodPut, paths[1], map[string]any{"expectedUserId": f.userID, "revision": "1", "text": ""}, http.StatusOK)
	results = report(known)
	if cleared.Revision != "2" || cleared.Text != "" || len(results) != 3 || results[1].Status != "value" || results[1].Value == nil || results[1].Value.Revision != "2" || results[1].Value.Text != "" {
		t.Fatalf("clear/sync: %+v %+v", cleared, results)
	}
}
