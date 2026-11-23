package worker

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

const toolPathsHeader = "Daynight-Worker-Tool-Paths"

func TestWorkerToolPathsHTTPPreservesForeignPlatformTargetFailure(t *testing.T) {
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	body := configurationHTTPReportBody(nil, nil)
	revision, count := "7", int64(0)
	body["toolPaths"] = &model.ToolPathTelemetry{SchemaVersion: 1, ObservedAt: capacityObservedAt, Entries: []model.ToolPathObservation{{Tool: "codex", Context: "web", ConfigurationSource: "cloud", TargetRevision: &revision, Target: model.ToolPathChoice{Kind: "path", Path: `C:\tools\codex.exe`}, State: "error", Error: &model.ToolPathError{Code: "invalid_path", OccurredAt: capacityObservedAt}, ActiveSelectionCount: &count, ActiveSelectionsComplete: true, ActiveSelections: []model.ToolPathActiveSelection{}}}}
	want := capacityDecode[model.WorkerTelemetry](t, body)
	calls := 0
	f.operations.report = func(ctx context.Context, p model.Principal, id string, input model.WorkerReport) (workerservice.WorkerReportResult, error) {
		calls++
		if calls != 1 || ctx != f.requestContext || p != f.handler.principal || id != f.worker || !reflect.DeepEqual(input.Telemetry, want) {
			t.Fatalf("target failure lost: %+v", input)
		}
		return workerservice.WorkerReportResult{ObservedAt: capacityObservedAt, LastReportedAt: capacityObservedAt}, nil
	}
	response := controlModeRequest(t, f, "POST", "/report", jsonBody(t, body), http.Header{workerConfigurationHeader: {"1"}})
	if response.Code != 200 || response.Header().Get(toolPathsHeader) != "2" || calls != 1 {
		t.Fatalf("target failure: %d %s calls=%d", response.Code, response.Body, calls)
	}
}

func TestWorkerToolPathsHTTPReportProtocols(t *testing.T) {
	for _, version := range []string{"1", "2"} {
		t.Run(version, func(t *testing.T) {
			f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
			body := configurationHTTPReportBody(nil, nil)
			body["configuration"].(map[string]any)["toolPathsBootstrap"] = map[string]any{"codex": map[string]any{"kind": "path", "path": "/opt/codex"}, "copilot": map[string]any{"kind": "auto"}}
			body["toolPaths"] = map[string]any{"schemaVersion": 1, "observedAt": "2026-11-08T00:00:00Z", "entries": []any{}}
			headers := http.Header{workerConfigurationHeader: {version}}
			if version == "2" {
				headers.Set(workerPromptsHeader, "[]")
			}
			calls := 0
			check := func(ctx context.Context, p model.Principal, id string, input model.WorkerReport) workerservice.WorkerReportResult {
				calls++
				if ctx != f.requestContext || p != f.handler.principal || id != f.worker || input.Configuration.ToolPathsBootstrap == nil || input.Telemetry.ToolPaths == nil {
					t.Fatalf("input lost: %+v", input)
				}
				return workerservice.WorkerReportResult{Configuration: &model.WorkerConfigurationReceipt{Desired: &model.WorkerDesiredConfiguration{Revision: "2", UpdatedAt: capacityObservedAt, Value: configurationHTTPModel(t, configurationHTTPValue())}, ObservationRevision: "0"}}
			}
			f.operations.report = func(ctx context.Context, p model.Principal, id string, input model.WorkerReport) (workerservice.WorkerReportResult, error) {
				if version != "1" {
					t.Fatal("wrong report operation")
				}
				return check(ctx, p, id, input), nil
			}
			f.operations.sync = func(ctx context.Context, p model.Principal, id string, input model.WorkerReport, selectors []model.PromptSelector) (workerservice.ConfigurationSyncResult, error) {
				if version != "2" || len(selectors) != 0 {
					t.Fatal("wrong prompt protocol")
				}
				return workerservice.ConfigurationSyncResult{Native: check(ctx, p, id, input), Prompts: []model.PromptResult{}}, nil
			}
			response := controlModeRequest(t, f, "POST", "/report", jsonBody(t, body), headers)
			if response.Code != 200 || calls != 1 || response.Header().Get(toolPathsHeader) != "2" || !strings.Contains(response.Body.String(), `"toolPaths"`) {
				t.Fatalf("protocol: %d %s %v", response.Code, response.Body, response.Header())
			}
		})
	}
}

func TestWorkerToolPathsHTTPStrictRefusalBeforeBusiness(t *testing.T) {
	for _, suffix := range []string{"", "/configuration", "/report"} {
		for _, version := range []string{"", "1", "3", "2, 2"} {
			t.Run(fmt.Sprintf("%s/%s", suffix, version), func(t *testing.T) {
				f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
				method := "GET"
				if suffix == "/report" {
					method = "POST"
				}
				request := httptest.NewRequest(method, "/api/v1/me/workers/"+f.worker+suffix, strings.NewReader(`{}`))
				authorizeResourceRequest(f.handler, request)
				if version != "" {
					request.Header.Set(toolPathsHeader, version)
				}
				response := httptest.NewRecorder()
				f.handler.ServeHTTP(response, request)
				if response.Code != 400 || !strings.Contains(response.Body.String(), "upgrade") {
					t.Fatalf("missing upgrade refusal: %d %s", response.Code, response.Body)
				}
			})
		}
	}
	for _, values := range [][]string{{""}, {"1"}, {"2", "2"}, {"2, 2"}} {
		f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
		response := controlModeRequest(t, f, "GET", "/configuration", "", http.Header{toolPathsHeader: values})
		if response.Code != 400 {
			t.Fatalf("invalid tool header reached business %v: %d", values, response.Code)
		}
	}
	for _, bad := range []map[string]any{{"codex": nil, "copilot": nil, "herdr": nil}, {"codex": nil}, {"codex": nil, "copilot": nil, "extra": nil}} {
		f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
		value := configurationHTTPValue()
		value["toolPaths"] = bad
		response := controlModeRequest(t, f, "PUT", "/configuration", jsonBody(t, map[string]any{"revision": "1", "value": value}), nil)
		if response.Code != 400 {
			t.Fatalf("invalid tools accepted %v: %d %s", bad, response.Code, response.Body)
		}
	}
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	body := workerSnapshotReportBody()
	body["versions"].(map[string]any)["herdr"] = map[string]any{"state": "not_running", "checkedAt": "2026-10-29T00:00:00Z"}
	response := controlModeRequest(t, f, "POST", "/report", jsonBody(t, body), nil)
	if response.Code != 400 {
		t.Fatalf("obsolete version accepted: %d %s", response.Code, response.Body)
	}
	observation := configurationHTTPObservation(configurationHTTPItem("agentControlMode", "web"))
	response = controlModeRequest(t, f, "POST", "/report", jsonBody(t, configurationHTTPReportBody(nil, observation)), http.Header{workerConfigurationHeader: {"1"}})
	if response.Code != 400 {
		t.Fatalf("obsolete observation accepted: %d %s", response.Code, response.Body)
	}
}

func TestWorkerSummaryHasNoToolProtocolGate(t *testing.T) {
	for _, version := range []string{"", "1", "2", "unknown"} {
		f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
		calls := 0
		f.operations.list = func(_ context.Context, principal model.Principal, page model.PageRequest) (workerservice.WorkerPage, error) {
			calls++
			if principal != f.handler.principal || page.Limit != 50 {
				t.Fatalf("list identity or pagination changed: %+v %+v", principal, page)
			}
			return workerservice.WorkerPage{Items: []api.WorkerSummary{}}, nil
		}
		request := httptest.NewRequest("GET", "/api/v1/me/workers", nil)
		authorizeResourceRequest(f.handler, request)
		if version != "" {
			request.Header.Set(toolPathsHeader, version)
		}
		response := httptest.NewRecorder()
		f.handler.ServeHTTP(response, request)
		if response.Code != 200 || calls != 1 {
			t.Fatalf("summary version %q: %d %s", version, response.Code, response.Body)
		}
	}
}

func TestWorkerToolPathsHTTPDetailAndPut(t *testing.T) {
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	telemetry := &model.ToolPathTelemetry{SchemaVersion: 1, ObservedAt: capacityObservedAt, Entries: []model.ToolPathObservation{}}
	f.operations.get = func(_ context.Context, p model.Principal, id string) (workerservice.WorkerDetailResult, error) {
		if p != f.handler.principal || id != f.worker {
			t.Fatal("owner lost")
		}
		return workerservice.WorkerDetailResult{Worker: model.WorkerSnapshot{WorkerID: id, Telemetry: model.WorkerTelemetry{ToolPaths: telemetry}}}, nil
	}
	response := controlModeRequest(t, f, "GET", "", "", nil)
	if response.Code != 200 || response.Header().Get(toolPathsHeader) != "2" || !strings.Contains(response.Body.String(), `"toolPaths"`) || telemetry.Entries == nil {
		t.Fatalf("detail: %d %s", response.Code, response.Body)
	}
	value := configurationHTTPValue()
	value["toolPaths"] = map[string]any{"codex": map[string]any{"kind": "path", "path": "/cloud/codex"}, "copilot": nil}
	calls := 0
	f.operations.put = func(ctx context.Context, p model.Principal, id, revision string, input model.WorkerConfiguration) (model.WorkerConfigurationResource, error) {
		calls++
		if ctx != f.requestContext || p != f.handler.principal || id != f.worker || revision != "7" || input.PreserveToolPaths || input.ToolPaths.Codex == nil || input.ToolPaths.Codex.Path != "/cloud/codex" {
			t.Fatalf("PUT propagation: %+v", input)
		}
		return model.WorkerConfigurationResource{}, &model.Fault{Code: "version_conflict", Message: "Worker configuration revision does not match."}
	}
	response = controlModeRequest(t, f, "PUT", "/configuration", jsonBody(t, map[string]any{"revision": "7", "value": value}), nil)
	if response.Code != http.StatusConflict || calls != 1 || !strings.Contains(response.Body.String(), `"version_conflict"`) {
		t.Fatalf("conflict mapping: %d %s calls=%d", response.Code, response.Body, calls)
	}
	f.operations.configuration = func(context.Context, model.Principal, string) (model.WorkerConfigurationResource, error) {
		return model.WorkerConfigurationResource{}, &model.Fault{Code: "not_found", Message: "missing", Cause: model.ErrNotFound}
	}
	response = controlModeRequest(t, f, "GET", "/configuration", "", nil)
	if response.Code != 404 || response.Header().Get(toolPathsHeader) != "2" {
		t.Fatalf("404 discovery: %d %v", response.Code, response.Header())
	}
}
