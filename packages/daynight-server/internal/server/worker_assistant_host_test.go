package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
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

func TestWorkerAssistantHostHTTPConfigurationExchangeCompatibility(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), &bytes.Buffer{})
	id := uuid.NewString()
	path := "/api/v1/me/workers/" + id
	host := assistantHostBody()
	value := configurationHTTPValue()
	body := configurationHTTPReportBody(value, nil)
	body["assistantHost"] = host
	var wantHost api.WorkerAssistantHost
	if err := json.Unmarshal([]byte(jsonBody(t, host)), &wantHost); err != nil {
		t.Fatal(err)
	}
	var wantConfiguration model.WorkerConfiguration
	if err := json.Unmarshal([]byte(jsonBody(t, value)), &wantConfiguration); err != nil {
		t.Fatal(err)
	}

	response := configurationHTTPRequest(handler, http.MethodPost, path+"/report", jsonBody(t, body), "1")
	receipt := decodeResponse[configurationHTTPReceipt](t, response, http.StatusOK)
	if response.Header().Get(workerConfigurationHeader) != "1" || receipt.Configuration.Desired == nil || receipt.Configuration.Desired.Revision != "1" || !reflect.DeepEqual(receipt.Configuration.Desired.Value, wantConfiguration) {
		t.Fatalf("combined report did not negotiate and bootstrap configuration: %s", response.Body)
	}
	detail := snapshotDetailHTTP(t, handler, id)
	if !reflect.DeepEqual(detail.Worker.Telemetry.AssistantHost, &wantHost) {
		t.Fatalf("configuration exchange changed the stored assistant host: %+v", detail.Worker.Telemetry.AssistantHost)
	}
	configuration := decodeResponse[model.WorkerConfigurationResource](t, projectRequest(handler, http.MethodGet, path+"/configuration", ""), http.StatusOK)
	if !reflect.DeepEqual(configuration.Desired, receipt.Configuration.Desired) || configuration.Observation != nil || configuration.ObservationRevision != "0" {
		t.Fatalf("combined report configuration was not persisted independently: %+v", configuration)
	}
	rejectedHost := assistantHostBody()
	rejectedHost["defaultCwd"] = "/rejected-assistant-host"
	rejected := configurationHTTPReportBody(nil, map[string]any{"baseRevision": "0", "desiredRevision": "2", "items": []any{}})
	rejected["assistantHost"] = rejectedHost
	assertProjectError(t, configurationHTTPRequest(handler, http.MethodPost, path+"/report", jsonBody(t, rejected), "1"), http.StatusBadRequest, "invalid_input")
	if after := snapshotDetailHTTP(t, handler, id); !reflect.DeepEqual(after.Worker, detail.Worker) {
		t.Fatalf("refused configuration exchange committed a partial worker report: %+v", after.Worker)
	}
	if after := decodeResponse[model.WorkerConfigurationResource](t, projectRequest(handler, http.MethodGet, path+"/configuration", ""), http.StatusOK); !reflect.DeepEqual(after, configuration) {
		t.Fatalf("refused configuration exchange changed the stored configuration: %+v", after)
	}

	delete(body, "assistantHost")
	delete(body, "configuration")
	legacy := projectRequest(handler, http.MethodPost, path+"/report", jsonBody(t, body))
	fields := decodeResponse[map[string]json.RawMessage](t, legacy, http.StatusOK)
	if len(fields) != 2 || fields["observedAt"] == nil || fields["lastReportedAt"] == nil || legacy.Header().Get(workerConfigurationHeader) != "" {
		t.Fatalf("legacy heartbeat received an extended report receipt: %s", legacy.Body)
	}
	if snapshotDetailHTTP(t, handler, id).Worker.Telemetry.AssistantHost != nil {
		t.Fatal("legacy replacement retained obsolete assistant hosting capability")
	}
	retained := decodeResponse[model.WorkerConfigurationResource](t, projectRequest(handler, http.MethodGet, path+"/configuration", ""), http.StatusOK)
	if !reflect.DeepEqual(retained, configuration) {
		t.Fatalf("legacy heartbeat changed the stored cloud configuration: %+v", retained)
	}
}
