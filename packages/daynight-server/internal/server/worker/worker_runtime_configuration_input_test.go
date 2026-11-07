package worker

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
)

func runtimeConfigurationBody() map[string]any {
	return map[string]any{"schemaVersion": 1, "native": map[string]any{"agent": "codex", "model": map[string]any{"value": "gpt-model", "source": "local"}, "reasoningEffort": map[string]any{"value": nil, "source": "native"}}, "projects": []any{map[string]any{"projectId": "11111111-1111-4111-8111-111111111111", "native": nil}}}
}

func TestWorkerRuntimeConfigurationInputRejectsMalformedFields(t *testing.T) {
	for name, mutate := range map[string]func(map[string]any){
		"null":          func(b map[string]any) { b["runtimeConfiguration"] = nil },
		"schema type":   func(b map[string]any) { b["runtimeConfiguration"].(map[string]any)["schemaVersion"] = "1" },
		"native type":   func(b map[string]any) { b["runtimeConfiguration"].(map[string]any)["native"] = false },
		"projects type": func(b map[string]any) { b["runtimeConfiguration"].(map[string]any)["projects"] = nil },
		"project type":  func(b map[string]any) { b["runtimeConfiguration"].(map[string]any)["projects"] = []any{false} },
		"project ID type": func(b map[string]any) {
			b["runtimeConfiguration"].(map[string]any)["projects"] = []any{map[string]any{"projectId": nil, "native": nil}}
		},
		"project native type": func(b map[string]any) {
			b["runtimeConfiguration"].(map[string]any)["projects"] = []any{map[string]any{"projectId": "id", "native": false}}
		},
		"agent type": func(b map[string]any) {
			b["runtimeConfiguration"].(map[string]any)["native"].(map[string]any)["agent"] = nil
		},
		"model type": func(b map[string]any) {
			b["runtimeConfiguration"].(map[string]any)["native"].(map[string]any)["model"] = nil
		},
		"value type": func(b map[string]any) {
			b["runtimeConfiguration"].(map[string]any)["native"].(map[string]any)["model"] = map[string]any{"value": false, "source": "local"}
		},
		"source type": func(b map[string]any) {
			b["runtimeConfiguration"].(map[string]any)["native"].(map[string]any)["model"] = map[string]any{"value": "x", "source": nil}
		},
	} {
		t.Run(name, func(t *testing.T) {
			body := workerSnapshotReportBody()
			body["runtimeConfiguration"] = runtimeConfigurationBody()
			mutate(body)
			fields, err := jsonobject.Decode([]byte(jsonBody(t, body)), "report", workerReportFields...)
			if err == nil {
				_, err = workerReportInput(fields)
			}
			if err == nil {
				t.Fatal("malformed runtime configuration accepted")
			}
		})
	}
	for _, key := range []string{"schemaVersion", "agent", "value", "source", "projectId"} {
		body := workerSnapshotReportBody()
		body["runtimeConfiguration"] = runtimeConfigurationBody()
		raw := jsonBody(t, body)
		needle := `"` + key + `":`
		raw = strings.Replace(raw, needle, needle+`null,`+needle, 1)
		fields, err := jsonobject.Decode([]byte(raw), "report", workerReportFields...)
		if err == nil {
			_, err = workerReportInput(fields)
		}
		if err == nil {
			t.Fatal("duplicate runtime field accepted", key)
		}
	}
}

func TestWorkerRuntimeConfigurationInputPreservesReport(t *testing.T) {
	body := workerSnapshotReportBody()
	body["runtimeConfiguration"] = runtimeConfigurationBody()
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
	if len(result["runtimeConfiguration"]) == 0 {
		t.Fatal("effective configuration discarded")
	}
	var actual, expected any
	if err := json.Unmarshal(result["runtimeConfiguration"], &actual); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(jsonBody(t, runtimeConfigurationBody())), &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("configuration changed: %v", actual)
	}
	response := workerDetailResponse(model.WorkerSnapshot{Telemetry: report.Telemetry})
	encoded, err = json.Marshal(response.Telemetry.RuntimeConfiguration)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &actual); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("response changed configuration: %v", actual)
	}
	report.Telemetry.RuntimeConfiguration = nil
	if workerDetailResponse(model.WorkerSnapshot{Telemetry: report.Telemetry}).Telemetry.RuntimeConfiguration != nil {
		t.Fatal("legacy response acquired a configuration")
	}
}
