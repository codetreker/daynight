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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
	"github.com/google/uuid"
)

func assistantHostBody() map[string]any {
	return map[string]any{"protocolVersion": 1, "observedAt": "2026-11-04T12:00:00Z", "defaultCwd": "/workspace", "defaultProvider": "copilot", "providers": []any{
		map[string]any{"provider": "codex", "available": true, "reason": nil, "model": nil, "args": []any{}},
		map[string]any{"provider": "claude", "available": false, "reason": "not_found", "model": nil, "args": []any{}},
		map[string]any{"provider": "copilot", "available": true, "reason": nil, "model": "gpt-5", "args": []any{"--effort", "high"}},
	}}
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
	f := newCapacityHTTPFixture(t, uuid.NewString(), &bytes.Buffer{})
	path := "/api/v1/me/workers/" + f.worker
	host := assistantHostBody()
	value := configurationHTTPValue()
	body := configurationHTTPReportBody(value, nil)
	body["assistantHost"] = host
	wantHost := capacityDecode[api.WorkerAssistantHost](t, host)
	wantConfiguration := capacityDecode[model.WorkerConfiguration](t, value)
	desired := model.WorkerDesiredConfiguration{Revision: "1", UpdatedAt: capacityObservedAt, Value: wantConfiguration}
	configuration := model.WorkerConfigurationResource{Desired: &desired, ObservationRevision: "0"}
	stored := capacityExpectedSnapshot(t, f.handler.principal.UserID, f.worker, body)
	plan := f.write([]string{"dao", "admit", "upsert", "configuration", "set_configuration", "observed"}, store.TransactionCommitted, func(d *capacityWorkerDAO) {
		f.reportDAO(d, body, stored)
		d.configuration = func(user, worker string) (model.WorkerConfigurationResource, error) {
			f.workerAddress(user, worker)
			return model.WorkerConfigurationResource{ObservationRevision: "0"}, nil
		}
		d.setConfiguration = func(user, worker string, revision int64, actual model.WorkerConfiguration) (model.WorkerDesiredConfiguration, error) {
			f.workerAddress(user, worker)
			if revision != 1 || !reflect.DeepEqual(actual, wantConfiguration) {
				t.Fatal("configuration bootstrap arguments differ")
			}
			return capacityDecode[model.WorkerDesiredConfiguration](t, desired), nil
		}
	})
	response := configurationHTTPRequest(f.handler, http.MethodPost, path+"/report", jsonBody(t, body), "1")
	receipt := decodeResponse[configurationHTTPReceipt](t, response, http.StatusOK)
	plan.check()
	if response.Header().Get(workerConfigurationHeader) != "1" || !reflect.DeepEqual(receipt.Configuration.Desired, &desired) || receipt.Configuration.ObservationRevision != "0" || receipt.Configuration.ObservationAccepted {
		t.Fatalf("combined report did not negotiate bootstrap: %s", response.Body)
	}
	plan = f.readWorker(stored)
	detail := snapshotDetailHTTP(t, f.handler, f.worker)
	plan.check()
	if !reflect.DeepEqual(detail.Worker.Telemetry.AssistantHost, &wantHost) {
		t.Fatalf("configuration exchange changed assistant host: %+v", detail.Worker.Telemetry.AssistantHost)
	}
	plan = f.readConfiguration(configuration)
	readConfiguration := decodeResponse[model.WorkerConfigurationResource](t, projectRequest(f.handler, http.MethodGet, path+"/configuration", ""), http.StatusOK)
	plan.check()
	if !reflect.DeepEqual(readConfiguration, configuration) {
		t.Fatalf("combined report configuration differs: %+v", readConfiguration)
	}
	rejectedHost := assistantHostBody()
	rejectedHost["defaultCwd"] = "/rejected-assistant-host"
	rejected := configurationHTTPReportBody(nil, map[string]any{"baseRevision": "0", "desiredRevision": "2", "items": []any{}})
	rejected["assistantHost"] = rejectedHost
	rejectedSnapshot := capacityExpectedSnapshot(t, f.handler.principal.UserID, f.worker, rejected)
	plan = f.write([]string{"dao", "admit", "upsert", "configuration"}, store.TransactionNotCommitted, func(d *capacityWorkerDAO) {
		f.reportDAO(d, rejected, rejectedSnapshot)
		d.configuration = func(user, worker string) (model.WorkerConfigurationResource, error) {
			f.workerAddress(user, worker)
			return capacityDecode[model.WorkerConfigurationResource](t, configuration), nil
		}
	})
	assertProjectError(t, configurationHTTPRequest(f.handler, http.MethodPost, path+"/report", jsonBody(t, rejected), "1"), http.StatusBadRequest, "invalid_input")
	plan.check()
	plan = f.readWorker(stored)
	after := snapshotDetailHTTP(t, f.handler, f.worker)
	plan.check()
	if !reflect.DeepEqual(after.Worker, detail.Worker) {
		t.Fatalf("refused exchange response changed: %+v", after.Worker)
	}
	plan = f.readConfiguration(configuration)
	afterConfiguration := decodeResponse[model.WorkerConfigurationResource](t, projectRequest(f.handler, http.MethodGet, path+"/configuration", ""), http.StatusOK)
	plan.check()
	if !reflect.DeepEqual(afterConfiguration, configuration) {
		t.Fatal("refused exchange configuration response changed")
	}
	delete(body, "assistantHost")
	delete(body, "configuration")
	legacySnapshot := capacityExpectedSnapshot(t, f.handler.principal.UserID, f.worker, body)
	plan = f.report(body, legacySnapshot)
	legacy := projectRequest(f.handler, http.MethodPost, path+"/report", jsonBody(t, body))
	plan.check()
	fields := decodeResponse[map[string]json.RawMessage](t, legacy, http.StatusOK)
	if len(fields) != 2 || fields["observedAt"] == nil || fields["lastReportedAt"] == nil || legacy.Header().Get(workerConfigurationHeader) != "" {
		t.Fatalf("legacy heartbeat received extended receipt: %s", legacy.Body)
	}
	plan = f.readWorker(legacySnapshot)
	legacyDetail := snapshotDetailHTTP(t, f.handler, f.worker)
	plan.check()
	if legacyDetail.Worker.Telemetry.AssistantHost != nil {
		t.Fatal("legacy replacement retained obsolete assistant capability")
	}
	plan = f.readConfiguration(configuration)
	retained := decodeResponse[model.WorkerConfigurationResource](t, projectRequest(f.handler, http.MethodGet, path+"/configuration", ""), http.StatusOK)
	plan.check()
	if !reflect.DeepEqual(retained, configuration) {
		t.Fatal("legacy heartbeat configuration response changed")
	}
}
