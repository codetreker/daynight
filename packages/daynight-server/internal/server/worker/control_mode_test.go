package worker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

const controlModeHeader = "Daynight-Worker-Control-Mode"

func controlModeRequest(t *testing.T, f *capacityReportOperationFixture, method, suffix, body string, headers http.Header) *httptest.ResponseRecorder {
	t.Helper()
	f.authCalls = 0
	request := httptest.NewRequest(method, "/api/v1/me/workers/"+f.worker+suffix, strings.NewReader(body))
	authorizeResourceRequest(f.handler, request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(workerToolPathsHeader, "2")
	for name, values := range headers {
		request.Header[name] = values
	}
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	return response
}

func TestWorkerConfigurationRawHTTPProjection(t *testing.T) {
	raw := json.RawMessage(`{"maxConcurrent":"future","native":{"extension":{"count":900719925474099312345}},"projects":[],"agentControlMode":"herdr","toolPaths":{"codex":null,"copilot":null,"herdr":{"kind":"auto"}},"archiveSessions":true,"enableSudoCleanup":true,"future":{"number":123456789012345678901234567890}}`)
	for _, archive := range []bool{false, true} {
		f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
		enabled := false
		desired := &model.WorkerDesiredConfiguration{Revision: "5", UpdatedAt: capacityObservedAt, Raw: raw, ArchiveSessions: &enabled}
		f.operations.configuration = func(context.Context, model.Principal, string) (model.WorkerConfigurationResource, error) {
			return model.WorkerConfigurationResource{Desired: desired, ObservationRevision: "0"}, nil
		}
		f.operations.report = func(context.Context, model.Principal, string, model.WorkerReport) (workerservice.WorkerReportResult, error) {
			return workerservice.WorkerReportResult{Configuration: &model.WorkerConfigurationReceipt{Desired: desired, ObservationRevision: "0"}}, nil
		}
		headers := http.Header{}
		if archive {
			headers.Set(workerArchiveSessionsHeader, "1")
		}
		get := controlModeRequest(t, f, "GET", "/configuration", "", headers)
		getEnvelope := decodeResponse[map[string]json.RawMessage](t, get, http.StatusOK)
		headers.Set(workerConfigurationHeader, "1")
		post := controlModeRequest(t, f, "POST", "/report", jsonBody(t, configurationHTTPReportBody(nil, nil)), headers)
		postEnvelope := decodeResponse[map[string]json.RawMessage](t, post, http.StatusOK)
		var receipt map[string]json.RawMessage
		if err := json.Unmarshal(postEnvelope["configuration"], &receipt); err != nil {
			t.Fatal(err)
		}
		for _, encoded := range []json.RawMessage{getEnvelope["desired"], receipt["desired"]} {
			var result struct {
				Revision string                     `json:"revision"`
				Value    map[string]json.RawMessage `json:"value"`
			}
			if err := json.Unmarshal(encoded, &result); err != nil {
				t.Fatal(err)
			}
			if result.Revision != "5" || string(result.Value["agentControlMode"]) != `"herdr"` || !strings.Contains(string(result.Value["toolPaths"]), `"herdr"`) || string(result.Value["future"]) != `{"number":123456789012345678901234567890}` || !strings.Contains(string(result.Value["native"]), "900719925474099312345") || string(result.Value["enableSudoCleanup"]) != "true" {
				t.Fatalf("raw target changed: %s", encoded)
			}
			v, exists := result.Value["archiveSessions"]
			if exists != archive || archive && string(v) != "false" {
				t.Fatalf("archive column projection: %s", encoded)
			}
		}
		if string(desired.Raw) != string(raw) || *desired.ArchiveSessions {
			t.Fatal("projection changed stored target")
		}
	}
}

func TestWorkerConfigurationHistoricalRawProjection(t *testing.T) {
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	f.operations.configuration = func(context.Context, model.Principal, string) (model.WorkerConfigurationResource, error) {
		return model.WorkerConfigurationResource{Desired: &model.WorkerDesiredConfiguration{Revision: "1", Raw: json.RawMessage(`{"native":{},"projects":[]}`)}, ObservationRevision: "0"}, nil
	}
	response := controlModeRequest(t, f, "GET", "/configuration", "", http.Header{workerArchiveSessionsHeader: {"1"}})
	envelope := decodeResponse[map[string]json.RawMessage](t, response, http.StatusOK)
	var desired struct {
		Value map[string]json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(envelope["desired"], &desired); err != nil {
		t.Fatal(err)
	}
	if _, ok := desired.Value["agentControlMode"]; ok {
		t.Fatalf("invented mode: %s", envelope["desired"])
	}
	if _, ok := desired.Value["toolPaths"]; ok {
		t.Fatalf("invented tools: %s", envelope["desired"])
	}
	if string(desired.Value["archiveSessions"]) != `null` {
		t.Fatalf("archive column projection: %s", envelope["desired"])
	}
	if string(desired.Value["enableSudoCleanup"]) != `false` {
		t.Fatalf("historical sudo default: %s", envelope["desired"])
	}
}

func TestWorkerControlModeHTTPRefusesWrites(t *testing.T) {
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	calls := 0
	f.operations.put = func(_ context.Context, _ model.Principal, _ string, _ string, input model.WorkerConfiguration) (model.WorkerConfigurationResource, error) {
		calls++
		if input.PreserveToolPaths {
			t.Fatalf("replacement preserves removed fields: %+v", input)
		}
		return model.WorkerConfigurationResource{ObservationRevision: "0"}, nil
	}
	value := configurationHTTPValue()
	body := func() string { return jsonBody(t, map[string]any{"revision": "1", "value": value}) }
	response := controlModeRequest(t, f, "PUT", "/configuration", body(), nil)
	if response.Code != 200 || calls != 1 {
		t.Fatalf("replacement: %d %s", response.Code, response.Body)
	}
	value["agentControlMode"] = "web"
	response = controlModeRequest(t, f, "PUT", "/configuration", body(), nil)
	if response.Code != 400 || calls != 1 {
		t.Fatalf("mode accepted: %d %s", response.Code, response.Body)
	}
	report := configurationHTTPReportBody(nil, nil)
	report["configuration"].(map[string]any)["controlModeBootstrap"] = "web"
	response = controlModeRequest(t, f, "POST", "/report", jsonBody(t, report), http.Header{workerConfigurationHeader: {"1"}})
	if response.Code != 400 {
		t.Fatalf("mode bootstrap accepted: %d", response.Code)
	}
}

func TestWorkerRejectsRetiredControlModeHeader(t *testing.T) {
	for _, endpoint := range []struct{ method, suffix string }{{"GET", ""}, {"GET", "/configuration"}, {"PUT", "/configuration"}, {"POST", "/report"}} {
		for _, values := range [][]string{{"1"}, {""}, {"2"}, {"1", "1"}} {
			f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
			response := controlModeRequest(t, f, endpoint.method, endpoint.suffix, `{}`, http.Header{controlModeHeader: values})
			if response.Code != 400 || !strings.Contains(response.Body.String(), "upgrade") || response.Header().Get(controlModeHeader) != "" {
				t.Fatalf("%s %s header %v: %d %s", endpoint.method, endpoint.suffix, values, response.Code, response.Body)
			}
		}
	}
}
