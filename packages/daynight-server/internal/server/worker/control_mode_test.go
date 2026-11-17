package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

const controlModeHeader = "Daynight-Worker-Control-Mode"

func TestWorkerConfigurationRawHTTPProjection(t *testing.T) {
	raw := json.RawMessage(`{"maxConcurrent":"future","pollIntervalMs":60000,"recoveryLimit":3,"preferPlatformSpecificTasks":false,"native":{"agent":"codex","model":null,"args":[],"extension":{"count":900719925474099312345}},"projects":[],"agentControlMode":"future","toolPaths":{"codex":{"kind":"future","other":[1,2]},"copilot":null,"herdr":null,"extension":true},"archiveSessions":true,"enableSudoCleanup":true,"future":{"number":123456789012345678901234567890}}`)
	for _, mode := range []bool{false, true} {
		for _, tools := range []bool{false, true} {
			for _, archive := range []bool{false, true} {
				t.Run(fmt.Sprintf("mode=%v/tools=%v/archive=%v", mode, tools, archive), func(t *testing.T) {
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
					body := configurationHTTPReportBody(nil, nil)
					exchange := body["configuration"].(map[string]any)
					if mode {
						headers.Set(controlModeHeader, "1")
						exchange["controlModeBootstrap"] = nil
					}
					if tools {
						headers.Set(toolPathsHeader, "1")
						exchange["toolPathsBootstrap"] = nil
					}
					if archive {
						headers.Set(workerArchiveSessionsHeader, "1")
					}
					get := controlModeRequest(t, f, http.MethodGet, "/configuration", "", headers)
					getEnvelope := decodeResponse[map[string]json.RawMessage](t, get, http.StatusOK)
					headers.Set(workerConfigurationHeader, "1")
					post := controlModeRequest(t, f, http.MethodPost, "/report", jsonBody(t, body), headers)
					postEnvelope := decodeResponse[map[string]json.RawMessage](t, post, http.StatusOK)
					var report map[string]json.RawMessage
					if err := json.Unmarshal(postEnvelope["configuration"], &report); err != nil {
						t.Fatal(err)
					}
					for _, encoded := range []json.RawMessage{getEnvelope["desired"], report["desired"]} {
						var result struct {
							Revision string                     `json:"revision"`
							Value    map[string]json.RawMessage `json:"value"`
						}
						if err := json.Unmarshal(encoded, &result); err != nil {
							t.Fatal(err)
						}
						if result.Revision != "5" || string(result.Value["maxConcurrent"]) != `"future"` || string(result.Value["enableSudoCleanup"]) != `true` || string(result.Value["future"]) != `{"number":123456789012345678901234567890}` || !strings.Contains(string(result.Value["native"]), `900719925474099312345`) {
							t.Fatalf("raw target changed: %s", encoded)
						}
						if got, exists := result.Value["agentControlMode"]; exists != mode || mode && string(got) != `"future"` {
							t.Fatalf("mode projection: %s", encoded)
						}
						if got, exists := result.Value["toolPaths"]; exists != tools || tools && (!strings.Contains(string(got), `"extension":true`) || !strings.Contains(string(got), `"kind":"future"`)) {
							t.Fatalf("tool projection: %s", encoded)
						}
						if got, exists := result.Value["archiveSessions"]; exists != archive || archive && string(got) != `false` {
							t.Fatalf("archive column projection: %s", encoded)
						}
					}
					if string(desired.Raw) != string(raw) || *desired.ArchiveSessions {
						t.Fatal("projection changed the stored target")
					}
				})
			}
		}
	}
}

func TestWorkerConfigurationHistoricalRawProjection(t *testing.T) {
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	f.operations.configuration = func(context.Context, model.Principal, string) (model.WorkerConfigurationResource, error) {
		return model.WorkerConfigurationResource{Desired: &model.WorkerDesiredConfiguration{Revision: "1", Raw: json.RawMessage(`{"native":{},"projects":[]}`)}, ObservationRevision: "0"}, nil
	}
	headers := http.Header{controlModeHeader: {"1"}, toolPathsHeader: {"1"}, workerArchiveSessionsHeader: {"1"}}
	response := controlModeRequest(t, f, http.MethodGet, "/configuration", "", headers)
	envelope := decodeResponse[map[string]json.RawMessage](t, response, http.StatusOK)
	var desired struct {
		Value map[string]json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(envelope["desired"], &desired); err != nil {
		t.Fatal(err)
	}
	if string(desired.Value["agentControlMode"]) != `null` || string(desired.Value["toolPaths"]) != `{"codex":null,"copilot":null,"herdr":null}` || string(desired.Value["archiveSessions"]) != `null` || string(desired.Value["enableSudoCleanup"]) != `false` {
		t.Fatalf("historical capability projection: %s", envelope["desired"])
	}
}

func controlModeRequest(t *testing.T, f *capacityReportOperationFixture, method, suffix, body string, headers http.Header) *httptest.ResponseRecorder {
	t.Helper()
	f.authCalls = 0
	request := httptest.NewRequest(method, "/api/v1/me/workers/"+f.worker+suffix, strings.NewReader(body))
	authorizeResourceRequest(f.handler, request)
	request.Header.Set("Content-Type", "application/json")
	for name, values := range headers {
		request.Header[name] = values
	}
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	return response
}

func TestWorkerControlModeHTTPProjectionAndDiscovery(t *testing.T) {
	for _, aware := range []bool{false, true} {
		t.Run(map[bool]string{true: "current", false: "legacy"}[aware], func(t *testing.T) {
			f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
			web := model.AgentControlModeWeb
			value := configurationHTTPModel(t, configurationHTTPValue())
			value.AgentControlMode = &web
			resource := model.WorkerConfigurationResource{Desired: &model.WorkerDesiredConfiguration{Revision: "2", UpdatedAt: capacityObservedAt, Value: value}, ObservationRevision: "1", Observation: &model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "2", Items: []model.WorkerConfigurationItem{{Key: model.WorkerConfigurationItemKey{Kind: "agentControlMode"}, TargetRevision: "2", AppliedValue: json.RawMessage(`"web"`), State: "applied"}, {Key: model.WorkerConfigurationItemKey{Kind: "maxConcurrent"}, TargetRevision: "2", AppliedValue: json.RawMessage(`3`), State: "applied"}}}, ReportedAt: capacityObservedAt}}
			calls := 0
			f.operations.configuration = func(ctx context.Context, principal model.Principal, worker string) (model.WorkerConfigurationResource, error) {
				calls++
				if ctx != f.requestContext || principal != f.handler.principal || worker != f.worker {
					t.Fatal("wrong request identity")
				}
				return resource, nil
			}
			headers := http.Header{}
			if aware {
				headers.Set(controlModeHeader, "1")
			}
			response := controlModeRequest(t, f, "GET", "/configuration", "", headers)
			if response.Code != 200 || calls != 1 {
				t.Fatalf("read: %d %s calls=%d", response.Code, response.Body, calls)
			}
			contains := strings.Contains(response.Body.String(), `"agentControlMode"`)
			if contains != aware || (response.Header().Get(controlModeHeader) == "1") != aware {
				t.Fatalf("capability projection: %s %v", response.Body, response.Header())
			}
			if strings.Contains(response.Body.String(), `"controlModeObservation"`) {
				t.Fatalf("private storage slot leaked through HTTP: %s", response.Body)
			}
			if len(resource.Observation.Items) != 2 || resource.Desired.Value.AgentControlMode == nil {
				t.Fatal("projection mutated shared resource")
			}
			resource.Desired.Value.AgentControlMode = nil
			response = controlModeRequest(t, f, "GET", "/configuration", "", headers)
			if aware && !strings.Contains(response.Body.String(), `"agentControlMode":null`) {
				t.Fatalf("unadopted mode not explicit: %s", response.Body)
			}
			f.operations.configuration = func(context.Context, model.Principal, string) (model.WorkerConfigurationResource, error) {
				return model.WorkerConfigurationResource{}, &model.Fault{Code: "not_found", Message: "missing", Cause: model.ErrNotFound}
			}
			response = controlModeRequest(t, f, "GET", "/configuration", "", headers)
			if response.Code != 404 || (response.Header().Get(controlModeHeader) == "1") != aware {
				t.Fatalf("missing worker discovery: %d %v", response.Code, response.Header())
			}
		})
	}
}

func TestWorkerControlModeHTTPWriteContracts(t *testing.T) {
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	value := configurationHTTPValue()
	calls := 0
	f.operations.put = func(_ context.Context, _ model.Principal, _ string, _ string, input model.WorkerConfiguration) (model.WorkerConfigurationResource, error) {
		calls++
		if calls == 1 && !input.PreserveAgentControlMode {
			t.Fatal("legacy replacement does not preserve mode")
		}
		if calls == 2 && (input.PreserveAgentControlMode || input.AgentControlMode == nil || *input.AgentControlMode != model.AgentControlModeWeb) {
			t.Fatalf("new mode input: %+v", input)
		}
		return model.WorkerConfigurationResource{ObservationRevision: "0"}, nil
	}
	body := func() string { return jsonBody(t, map[string]any{"revision": "1", "value": value}) }
	response := controlModeRequest(t, f, "PUT", "/configuration", body(), nil)
	if response.Code != 200 {
		t.Fatalf("legacy PUT: %s", response.Body)
	}
	value["agentControlMode"] = "web"
	response = controlModeRequest(t, f, "PUT", "/configuration", body(), http.Header{controlModeHeader: {"1"}})
	if response.Code != 200 || calls != 2 {
		t.Fatalf("new PUT: %s calls=%d", response.Body, calls)
	}
	f.operations.put = nil
	response = controlModeRequest(t, f, "PUT", "/configuration", body(), nil)
	if response.Code != 400 {
		t.Fatalf("legacy accepted mode: %s", response.Body)
	}
	delete(value, "agentControlMode")
	response = controlModeRequest(t, f, "PUT", "/configuration", body(), http.Header{controlModeHeader: {"1"}})
	if response.Code != 400 {
		t.Fatalf("current accepted missing mode: %s", response.Body)
	}
	for _, versions := range [][]string{{"2"}, {"1", "1"}, {""}, {"1, 1"}} {
		response = controlModeRequest(t, f, "GET", "/configuration", "", http.Header{controlModeHeader: versions})
		if response.Code != 400 {
			t.Fatalf("unsupported capability accepted: %v %s", versions, response.Body)
		}
	}
}

func TestWorkerControlModeHTTPReportContracts(t *testing.T) {
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	body := configurationHTTPReportBody(nil, nil)
	exchange := body["configuration"].(map[string]any)
	exchange["controlModeBootstrap"] = "web"
	calls := 0
	f.operations.report = func(_ context.Context, _ model.Principal, _ string, input model.WorkerReport) (workerservice.WorkerReportResult, error) {
		calls++
		if input.Configuration.ControlModeBootstrap == nil || *input.Configuration.ControlModeBootstrap != model.AgentControlModeWeb {
			t.Fatalf("candidate lost: %+v", input.Configuration)
		}
		return workerservice.WorkerReportResult{Configuration: &model.WorkerConfigurationReceipt{ObservationRevision: "0"}}, nil
	}
	headers := http.Header{workerConfigurationHeader: {"1"}, controlModeHeader: {"1"}}
	response := controlModeRequest(t, f, "POST", "/report", jsonBody(t, body), headers)
	if response.Code != 200 || calls != 1 || response.Header().Get(controlModeHeader) != "1" {
		t.Fatalf("mode report: %d %s", response.Code, response.Body)
	}
	f.operations.report = nil
	response = controlModeRequest(t, f, "POST", "/report", jsonBody(t, body), http.Header{workerConfigurationHeader: {"1"}})
	if response.Code != 400 {
		t.Fatalf("legacy accepted candidate: %s", response.Body)
	}
	delete(exchange, "controlModeBootstrap")
	response = controlModeRequest(t, f, "POST", "/report", jsonBody(t, body), headers)
	if response.Code != 400 {
		t.Fatalf("new report missing candidate: %s", response.Body)
	}
	exchange["controlModeBootstrap"] = nil
	exchange["bootstrap"] = configurationHTTPValue()
	response = controlModeRequest(t, f, "POST", "/report", jsonBody(t, body), headers)
	if response.Code != 400 {
		t.Fatalf("new bootstrap missing mode: %s", response.Body)
	}
	exchange["bootstrap"].(map[string]any)["agentControlMode"] = nil
	response = controlModeRequest(t, f, "POST", "/report", jsonBody(t, body), headers)
	if response.Code != 400 {
		t.Fatalf("new bootstrap accepted unadopted mode: %s", response.Body)
	}
	response = controlModeRequest(t, f, "POST", "/report", jsonBody(t, body), http.Header{controlModeHeader: {"1"}})
	if response.Code != 400 {
		t.Fatalf("mode capability without configuration accepted: %s", response.Body)
	}
}

func TestWorkerControlModeHTTPDoesNotInventAbsentReceipt(t *testing.T) {
	for _, aware := range []bool{false, true} {
		f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
		calls := 0
		f.operations.report = func(_ context.Context, _ model.Principal, _ string, input model.WorkerReport) (workerservice.WorkerReportResult, error) {
			calls++
			if input.Configuration == nil {
				t.Fatal("configuration exchange was lost")
			}
			return workerservice.WorkerReportResult{ObservedAt: capacityObservedAt, LastReportedAt: capacityObservedAt}, nil
		}
		body := configurationHTTPReportBody(nil, nil)
		headers := http.Header{workerConfigurationHeader: {"1"}}
		if aware {
			headers.Set(controlModeHeader, "1")
			body["configuration"].(map[string]any)["controlModeBootstrap"] = nil
		}
		response := controlModeRequest(t, f, http.MethodPost, "/report", jsonBody(t, body), headers)
		fields := decodeResponse[map[string]json.RawMessage](t, response, http.StatusOK)
		if calls != 1 || string(fields["configuration"]) != "null" || len(fields) != 3 || (response.Header().Get(controlModeHeader) == "1") != aware {
			t.Fatalf("absent receipt projection: %s %v calls=%d", response.Body, response.Header(), calls)
		}
	}
}
