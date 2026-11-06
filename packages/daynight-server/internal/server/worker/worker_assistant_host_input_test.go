package worker

import (
	"encoding/json"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"strings"
	"testing"
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
