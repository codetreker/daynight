package server

import (
	"bytes"
	"encoding/json"
	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/jsonobject"
)

func assistantHostBody() map[string]any {
	return map[string]any{"protocolVersion": 1, "observedAt": "2026-11-04T12:00:00Z", "defaultCwd": "/workspace", "defaultProvider": "copilot", "providers": []any{
		map[string]any{"provider": "codex", "available": true, "reason": nil, "model": nil, "args": []any{}},
		map[string]any{"provider": "claude", "available": false, "reason": "not_found", "model": nil, "args": []any{}},
		map[string]any{"provider": "copilot", "available": true, "reason": nil, "model": "gpt-5", "args": []any{"--effort", "high"}},
	}}
}

func TestWorkerAssistantHostInputPreservesOptionalReport(t *testing.T) {
	body := workerSnapshotReportBody()
	body["assistantHost"] = assistantHostBody()
	fields, err := jsonobject.Decode([]byte(jsonBody(t, body)), "report", workerReportFields...)
	if err != nil {
		t.Fatal(err)
	}
	report, err := workerReportInput(fields)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(report.Telemetry)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &result); err != nil {
		t.Fatal(err)
	}
	if len(result["assistantHost"]) == 0 {
		t.Fatal("assistant hosting report was discarded")
	}
	delete(body, "assistantHost")
	fields, err = jsonobject.Decode([]byte(jsonBody(t, body)), "report", workerReportFields...)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := workerReportInput(fields); err != nil {
		t.Fatal("legacy report rejected", err)
	}
}

func TestWorkerAssistantHostRejectsMalformedJSONFields(t *testing.T) {
	for name, mutate := range map[string]func(map[string]any){
		"null":             func(b map[string]any) { b["assistantHost"] = nil },
		"array":            func(b map[string]any) { b["assistantHost"] = []any{} },
		"missing":          func(b map[string]any) { delete(b["assistantHost"].(map[string]any), "observedAt") },
		"unknown":          func(b map[string]any) { b["assistantHost"].(map[string]any)["token"] = "secret" },
		"protocol type":    func(b map[string]any) { b["assistantHost"].(map[string]any)["protocolVersion"] = "1" },
		"time":             func(b map[string]any) { b["assistantHost"].(map[string]any)["observedAt"] = "bad" },
		"cwd type":         func(b map[string]any) { b["assistantHost"].(map[string]any)["defaultCwd"] = false },
		"provider type":    func(b map[string]any) { b["assistantHost"].(map[string]any)["defaultProvider"] = false },
		"providers null":   func(b map[string]any) { b["assistantHost"].(map[string]any)["providers"] = nil },
		"providers object": func(b map[string]any) { b["assistantHost"].(map[string]any)["providers"] = map[string]any{} },
	} {
		t.Run(name, func(t *testing.T) {
			body := workerSnapshotReportBody()
			body["assistantHost"] = assistantHostBody()
			mutate(body)
			fields, err := jsonobject.Decode([]byte(jsonBody(t, body)), "report", workerReportFields...)
			if err == nil {
				_, err = workerReportInput(fields)
			}
			if err == nil {
				t.Fatal("malformed hosting report accepted")
			}
		})
	}
	for _, key := range []string{"provider", "available", "reason", "model", "args"} {
		for _, value := range []any{true, 42, map[string]any{}, nil} {
			if key == "available" && value == true || (key == "reason" || key == "model") && value == nil {
				continue
			}
			body := workerSnapshotReportBody()
			host := assistantHostBody()
			body["assistantHost"] = host
			host["providers"].([]any)[0].(map[string]any)[key] = value
			fields, err := jsonobject.Decode([]byte(jsonBody(t, body)), "report", workerReportFields...)
			if err == nil {
				_, err = workerReportInput(fields)
			}
			if err == nil {
				t.Fatalf("malformed %s accepted: %v", key, value)
			}
		}
	}
	for _, args := range []any{[]any{nil}, []any{true}, []any{1}} {
		body := workerSnapshotReportBody()
		host := assistantHostBody()
		body["assistantHost"] = host
		host["providers"].([]any)[0].(map[string]any)["args"] = args
		fields, _ := jsonobject.Decode([]byte(jsonBody(t, body)), "report", workerReportFields...)
		if _, err := workerReportInput(fields); err == nil {
			t.Fatal("non-string argument accepted")
		}
	}
	body := workerSnapshotReportBody()
	body["assistantHost"] = assistantHostBody()
	for _, key := range []string{"protocolVersion", "provider", "reason"} {
		raw := jsonBody(t, body)
		needle := `"` + key + `":`
		raw = strings.Replace(raw, needle, needle+`null,`+needle, 1)
		fields, err := jsonobject.Decode([]byte(raw), "report", workerReportFields...)
		if err == nil {
			_, err = workerReportInput(fields)
		}
		if err == nil {
			t.Fatal("duplicate nested field accepted", key)
		}
	}
}

func TestWorkerAssistantHostHTTPPersistenceAndLegacyReplacement(t *testing.T) {
	var logs bytes.Buffer
	handler := projectTestHandler(t, projectTestStore(t), &logs)
	id := uuid.NewString()
	body := workerSnapshotReportBody()
	host := assistantHostBody()
	host["observedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	host["defaultCwd"] = "/private/assistant-host-marker"
	body["assistantHost"] = host
	reportSnapshotHTTP(t, handler, id, body)
	response := snapshotDetailHTTP(t, handler, id)
	if response.Worker.Telemetry.AssistantHost == nil {
		t.Fatal("stored assistant hosting report missing from detail")
	}
	encoded, err := json.Marshal(response.Worker.Telemetry.AssistantHost)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err = json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	expectedJSON, err := json.Marshal(host)
	if err != nil {
		t.Fatal(err)
	}
	var want map[string]any
	if err = json.Unmarshal(expectedJSON, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("report changed across storage and API: %s", encoded)
	}
	// Failed observations replace success instead of retaining an old promise.
	providers := host["providers"].([]any)
	for _, value := range providers {
		p := value.(map[string]any)
		p["available"] = false
		p["reason"] = "timeout"
	}
	reportSnapshotHTTP(t, handler, id, body)
	failed := snapshotDetailHTTP(t, handler, id)
	if failed.Worker.Telemetry.AssistantHost.Providers[0].Available || *failed.Worker.Telemetry.AssistantHost.Providers[0].Reason != "timeout" {
		t.Fatal("failed preflight retained previous availability")
	}
	delete(body, "assistantHost")
	reportSnapshotHTTP(t, handler, id, body)
	legacy := snapshotDetailHTTP(t, handler, id)
	if legacy.Worker.Telemetry.AssistantHost != nil {
		t.Fatal("legacy replacement retained obsolete hosting capability")
	}
	raw := projectRequest(handler, http.MethodGet, "/api/v1/me/workers/"+id, "")
	if strings.Contains(raw.Body.String(), `"assistantHost"`) {
		t.Fatal("absent legacy hosting field was serialized")
	}
	body["assistantHost"] = assistantHostBody()
	body["assistantHost"].(map[string]any)["protocolVersion"] = 2
	assertProjectError(t, projectRequest(handler, http.MethodPost, "/api/v1/me/workers/"+id+"/report", jsonBody(t, body)), http.StatusBadRequest, "invalid_input")
	if strings.Contains(logs.String(), "assistant-host-marker") || strings.Contains(logs.String(), "gpt-5") {
		t.Fatal("worker logs exposed hosting configuration")
	}
	page := decodeResponse[api.WorkerPage](t, projectRequest(handler, http.MethodGet, "/api/v1/me/workers", ""), http.StatusOK)
	if len(page.Items) != 1 {
		t.Fatal("assistant reporting changed worker listing")
	}
}
