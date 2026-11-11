package worker

import (
	"bytes"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"github.com/google/uuid"
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

func TestWorkerAssistantHostCreationConfigurationCapabilityIsOptionalAndStrict(t *testing.T) {
	for _, value := range []any{1, 2, 0, nil, "1", 1.5} {
		body := assistantHostBody()
		body["creationConfigurationVersion"] = value
		raw, _ := json.Marshal(body)
		host, err := workerAssistantHostInput(raw)
		if value == 1 {
			if err != nil || host.CreationConfigurationVersion != 1 {
				t.Fatalf("supported capability: %+v %v", host, err)
			}
		} else if err == nil {
			t.Fatalf("accepted unsupported capability: %v", value)
		}
	}
}

func TestWorkerAssistantHostHTTPReportingAndLegacyReplacement(t *testing.T) {
	var logs bytes.Buffer
	f := newCapacityReportOperationFixtureWithOutput(t, uuid.NewString(), &logs)
	body := workerSnapshotReportBody()
	host := assistantHostBody()
	host["observedAt"] = time.Now().UTC().Format(time.RFC3339Nano)
	host["defaultCwd"] = "/private/assistant-host-marker"
	body["assistantHost"] = host
	f.success(body)
	stored := capacityExpectedSnapshot(t, f.handler.principal.UserID, f.worker, body)
	response := decodeResponse[api.WorkerDetailResponse](t, f.getRequest(workerservice.WorkerDetailResult{ObservedAt: capacityObservedAt, Worker: stored}), http.StatusOK)
	if response.Worker.Telemetry.AssistantHost == nil {
		t.Fatal("assistant hosting report missing from detail")
	}
	got := capacityDecode[map[string]any](t, response.Worker.Telemetry.AssistantHost)
	want := capacityDecode[map[string]any](t, host)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("assistant-host response changed: %+v", got)
	}
	for _, value := range host["providers"].([]any) {
		provider := value.(map[string]any)
		provider["available"] = false
		provider["reason"] = "timeout"
	}
	f.success(body)
	failedSnapshot := capacityExpectedSnapshot(t, f.handler.principal.UserID, f.worker, body)
	failed := decodeResponse[api.WorkerDetailResponse](t, f.getRequest(workerservice.WorkerDetailResult{ObservedAt: capacityObservedAt, Worker: failedSnapshot}), http.StatusOK)
	if failed.Worker.Telemetry.AssistantHost == nil || !reflect.DeepEqual(capacityDecode[map[string]any](t, failed.Worker.Telemetry.AssistantHost), capacityDecode[map[string]any](t, host)) {
		t.Fatal("failed preflight changed complete hosting configuration")
	}
	if failed.Worker.Telemetry.AssistantHost.Providers[0].Available || *failed.Worker.Telemetry.AssistantHost.Providers[0].Reason != "timeout" {
		t.Fatal("failed preflight retained previous availability")
	}
	delete(body, "assistantHost")
	f.success(body)
	legacySnapshot := capacityExpectedSnapshot(t, f.handler.principal.UserID, f.worker, body)
	legacy := decodeResponse[api.WorkerDetailResponse](t, f.getRequest(workerservice.WorkerDetailResult{ObservedAt: capacityObservedAt, Worker: legacySnapshot}), http.StatusOK)
	if legacy.Worker.Telemetry.AssistantHost != nil {
		t.Fatal("legacy replacement retained obsolete hosting capability")
	}
	raw := f.getRequest(workerservice.WorkerDetailResult{ObservedAt: capacityObservedAt, Worker: capacityExpectedSnapshot(t, f.handler.principal.UserID, f.worker, body)})
	if strings.Contains(raw.Body.String(), `"assistantHost"`) {
		t.Fatal("absent legacy hosting field was serialized")
	}
	body["assistantHost"] = assistantHostBody()
	body["assistantHost"].(map[string]any)["protocolVersion"] = 2
	assertProjectError(t, f.request(body, 1, &model.Fault{Code: "invalid_input", Message: "Assistant host protocol is unsupported."}), http.StatusBadRequest, "invalid_input")
	zero := 0
	observed := capacityObservedAt
	summary := api.WorkerSummary{WorkerID: f.worker, Machine: api.WorkerMachine{ID: legacySnapshot.Telemetry.Machine.ID, Name: legacySnapshot.Telemetry.Machine.Name}, Platform: string(model.PlatformLinux), LastReportedAt: capacityObservedAt,
		TaskObservationState: string(model.WorkerTasksObserved), TaskObservedAt: &observed, ActiveTaskCount: &zero}
	wantPage := api.WorkerPage{ObservedAt: capacityObservedAt, Items: []api.WorkerSummary{summary}}
	page := decodeResponse[api.WorkerPage](t, f.listRequest(workerservice.WorkerPage{ObservedAt: capacityObservedAt, Items: []api.WorkerSummary{summary}}), http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].WorkerID != f.worker || page.NextCursor != nil || !reflect.DeepEqual(page, wantPage) {
		t.Fatal("assistant reporting changed worker listing")
	}
	if strings.Contains(logs.String(), "assistant-host-marker") || strings.Contains(logs.String(), "gpt-5") {
		t.Fatal("worker logs exposed hosting configuration")
	}
}

func TestWorkerAssistantHostHTTPConfigurationExchangeCompatibility(t *testing.T) {
	f := newCapacityReportOperationFixtureWithOutput(t, uuid.NewString(), &bytes.Buffer{})
	host := assistantHostBody()
	body := configurationHTTPReportBody(configurationHTTPValue(), nil)
	body["assistantHost"] = host
	wantHost := capacityDecode[api.WorkerAssistantHost](t, host)
	desired := func() *model.WorkerDesiredConfiguration {
		return &model.WorkerDesiredConfiguration{Revision: "1", UpdatedAt: capacityObservedAt, Value: capacityDecode[model.WorkerConfiguration](t, configurationHTTPValue())}
	}
	configuration := func() model.WorkerConfigurationResource {
		return model.WorkerConfigurationResource{Desired: desired(), ObservationRevision: "0"}
	}
	configurationReceipt := func() *model.WorkerConfigurationReceipt {
		return &model.WorkerConfigurationReceipt{Desired: desired(), ObservationRevision: "0", ObservationAccepted: false}
	}
	response := f.reportRequest(body, 1, workerservice.WorkerReportResult{ObservedAt: capacityObservedAt, LastReportedAt: capacityObservedAt, Configuration: configurationReceipt()}, nil, "1")
	receipt := decodeResponse[configurationHTTPReceipt](t, response, http.StatusOK)
	wantReceipt := configurationHTTPReceipt{ObservedAt: capacityObservedAt, LastReportedAt: capacityObservedAt, Configuration: *configurationReceipt()}
	if response.Header().Get(workerConfigurationHeader) != "1" || !reflect.DeepEqual(receipt, wantReceipt) {
		t.Fatalf("combined report did not negotiate bootstrap: %s", response.Body)
	}
	detail := decodeResponse[api.WorkerDetailResponse](t, f.getRequest(workerservice.WorkerDetailResult{ObservedAt: capacityObservedAt, Worker: capacityExpectedSnapshot(t, f.handler.principal.UserID, f.worker, body)}), http.StatusOK)
	if !reflect.DeepEqual(detail.Worker.Telemetry.AssistantHost, &wantHost) {
		t.Fatalf("configuration exchange changed assistant host: %+v", detail.Worker.Telemetry.AssistantHost)
	}
	readConfiguration := decodeResponse[model.WorkerConfigurationResource](t, f.configurationRequest(configuration()), http.StatusOK)
	if !reflect.DeepEqual(readConfiguration, configuration()) {
		t.Fatalf("combined report configuration differs: %+v", readConfiguration)
	}
	rejectedHost := assistantHostBody()
	rejectedHost["defaultCwd"] = "/rejected-assistant-host"
	rejected := configurationHTTPReportBody(nil, map[string]any{"baseRevision": "0", "desiredRevision": "2", "items": []any{}})
	rejected["assistantHost"] = rejectedHost
	refusal := &model.Fault{Code: "invalid_input", Message: "Worker observation references a future desired revision."}
	assertProjectError(t, f.reportRequest(rejected, 1, workerservice.WorkerReportResult{}, refusal, "1"), http.StatusBadRequest, "invalid_input")
	after := decodeResponse[api.WorkerDetailResponse](t, f.getRequest(workerservice.WorkerDetailResult{ObservedAt: capacityObservedAt, Worker: capacityExpectedSnapshot(t, f.handler.principal.UserID, f.worker, body)}), http.StatusOK)
	if !reflect.DeepEqual(after.Worker, detail.Worker) {
		t.Fatalf("refused exchange response changed: %+v", after.Worker)
	}
	afterConfiguration := decodeResponse[model.WorkerConfigurationResource](t, f.configurationRequest(configuration()), http.StatusOK)
	if !reflect.DeepEqual(afterConfiguration, configuration()) {
		t.Fatal("refused exchange configuration response changed")
	}
	delete(body, "assistantHost")
	delete(body, "configuration")
	legacy := f.reportRequest(body, 1, workerservice.WorkerReportResult{ObservedAt: capacityObservedAt, LastReportedAt: capacityObservedAt}, nil, "")
	fields := decodeResponse[map[string]json.RawMessage](t, legacy, http.StatusOK)
	if len(fields) != 2 || fields["observedAt"] == nil || fields["lastReportedAt"] == nil || legacy.Header().Get(workerConfigurationHeader) != "" {
		t.Fatalf("legacy heartbeat received extended receipt: %s", legacy.Body)
	}
	legacyDetail := decodeResponse[api.WorkerDetailResponse](t, f.getRequest(workerservice.WorkerDetailResult{ObservedAt: capacityObservedAt, Worker: capacityExpectedSnapshot(t, f.handler.principal.UserID, f.worker, body)}), http.StatusOK)
	if legacyDetail.Worker.Telemetry.AssistantHost != nil {
		t.Fatal("legacy replacement retained obsolete assistant capability")
	}
	retained := decodeResponse[model.WorkerConfigurationResource](t, f.configurationRequest(configuration()), http.StatusOK)
	if !reflect.DeepEqual(retained, configuration()) {
		t.Fatal("legacy heartbeat configuration response changed")
	}
}
