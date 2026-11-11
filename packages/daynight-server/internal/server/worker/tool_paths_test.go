package worker

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

const toolPathsHeader = "Daynight-Worker-Tool-Paths"

func TestWorkerToolPathsHTTPPreservesForeignPlatformTargetFailure(t *testing.T) {
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	body := configurationHTTPReportBody(nil, nil)
	body["configuration"].(map[string]any)["toolPathsBootstrap"] = nil
	body["platform"] = "linux"
	revision, count := "7", int64(0)
	body["toolPaths"] = &model.ToolPathTelemetry{
		SchemaVersion: 1, ObservedAt: capacityObservedAt,
		Entries: []model.ToolPathObservation{{
			Tool: "codex", Context: "web", ConfigurationSource: "cloud", TargetRevision: &revision,
			Target: model.ToolPathChoice{Kind: "path", Path: `C:\tools\codex.exe`}, State: "error",
			Error:                &model.ToolPathError{Code: "invalid_path", OccurredAt: capacityObservedAt},
			ActiveSelectionCount: &count, ActiveSelectionsComplete: true, ActiveSelections: []model.ToolPathActiveSelection{},
		}},
	}
	want := capacityDecode[model.WorkerTelemetry](t, body)
	calls := 0
	f.operations.report = func(ctx context.Context, p model.Principal, id string, input model.WorkerReport) (workerservice.WorkerReportResult, error) {
		calls++
		if calls != 1 || ctx != f.requestContext || p != f.handler.principal || id != f.worker || !reflect.DeepEqual(input.Telemetry, want) {
			t.Fatalf("target failure or ordinary report changed: %+v", input)
		}
		return workerservice.WorkerReportResult{ObservedAt: capacityObservedAt, LastReportedAt: capacityObservedAt}, nil
	}
	response := controlModeRequest(t, f, "POST", "/report", jsonBody(t, body), http.Header{workerConfigurationHeader: {"1"}, toolPathsHeader: {"1"}})
	if response.Code != http.StatusOK || calls != 1 {
		t.Fatalf("target failure refused: %d %s calls=%d", response.Code, response.Body, calls)
	}
}

func TestWorkerToolPathsHTTPDiscoveryAndLegacyProjection(t *testing.T) {
	for _, aware := range []bool{false, true} {
		f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
		f.operations.configuration = func(context.Context, model.Principal, string) (model.WorkerConfigurationResource, error) {
			return model.WorkerConfigurationResource{Desired: &model.WorkerDesiredConfiguration{Revision: "1", UpdatedAt: capacityObservedAt, Value: configurationHTTPModel(t, configurationHTTPValue())}, ObservationRevision: "0"}, nil
		}
		headers := http.Header{}
		if aware {
			headers.Set(toolPathsHeader, "1")
		}
		response := controlModeRequest(t, f, "GET", "/configuration", "", headers)
		if response.Code != 200 || strings.Contains(response.Body.String(), `"toolPaths"`) != aware || (response.Header().Get(toolPathsHeader) == "1") != aware {
			t.Fatalf("tool capability projection aware=%v: %d %s %v", aware, response.Code, response.Body, response.Header())
		}
	}
}

func TestWorkerToolPathsHTTPReportHeaderMatrix(t *testing.T) {
	for _, version := range []string{"1", "2"} {
		for _, mode := range []bool{false, true} {
			for _, tools := range []bool{false, true} {
				t.Run(fmt.Sprintf("v%s/mode=%v/tools=%v", version, mode, tools), func(t *testing.T) {
					f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
					body := configurationHTTPReportBody(nil, nil)
					exchange := body["configuration"].(map[string]any)
					headers := http.Header{workerConfigurationHeader: {version}}
					if version == "2" {
						headers.Set("Daynight-Worker-Prompts", "[]")
					}
					if mode {
						headers.Set(controlModeHeader, "1")
						exchange["controlModeBootstrap"] = "web"
					}
					if tools {
						headers.Set(toolPathsHeader, "1")
						exchange["toolPathsBootstrap"] = map[string]any{"codex": map[string]any{"kind": "path", "path": "/opt/codex"}, "copilot": map[string]any{"kind": "auto"}, "herdr": map[string]any{"kind": "auto"}}
						body["toolPaths"] = map[string]any{"schemaVersion": 1, "observedAt": "2026-11-08T00:00:00Z", "entries": []any{}}
					}
					calls := 0
					check := func(ctx context.Context, p model.Principal, id string, input model.WorkerReport) workerservice.WorkerReportResult {
						calls++
						if ctx != f.requestContext || p != f.handler.principal || id != f.worker || (input.Configuration.ToolPathsBootstrap != nil) != tools || (input.Configuration.ControlModeBootstrap != nil) != mode || (input.Telemetry.ToolPaths != nil) != tools {
							t.Fatalf("capabilities or owner lost: %+v", input)
						}
						value := configurationHTTPModel(t, configurationHTTPValue())
						value.ToolPaths.Codex = &model.ToolPathChoice{Kind: "path", Path: "/saved/codex"}
						return workerservice.WorkerReportResult{Configuration: &model.WorkerConfigurationReceipt{Desired: &model.WorkerDesiredConfiguration{Revision: "2", UpdatedAt: capacityObservedAt, Value: value}, ObservationRevision: "0"}}
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
					if response.Code != 200 || calls != 1 || (response.Header().Get(toolPathsHeader) == "1") != tools || (response.Header().Get(controlModeHeader) == "1") != mode || strings.Contains(response.Body.String(), `"toolPaths"`) != tools {
						t.Fatalf("header matrix: %d %s %v", response.Code, response.Body, response.Header())
					}
				})
			}
		}
	}
}

func TestWorkerToolPathsHTTPStrictRefusalBeforeBusiness(t *testing.T) {
	for _, method := range []string{"GET", "HEAD", "PUT", "POST"} {
		for _, values := range [][]string{{""}, {"2"}, {"1", "1"}, {"1, 1"}} {
			f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
			suffix := "/configuration"
			if method == "POST" {
				suffix = "/report"
			}
			response := controlModeRequest(t, f, method, suffix, `{}`, http.Header{toolPathsHeader: values})
			if response.Code != 400 {
				t.Fatalf("invalid tool header reached business %s %v: %d", method, values, response.Code)
			}
		}
	}
	for _, path := range []string{"/api/v1/me/workers", "/api/v1/me/workers/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"} {
		for _, method := range []string{"GET", "HEAD"} {
			f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
			request := httptest.NewRequest(method, path, nil)
			authorizeResourceRequest(f.handler, request)
			request.Header.Set(toolPathsHeader, "invalid")
			response := httptest.NewRecorder()
			f.handler.ServeHTTP(response, request)
			if response.Code != 400 {
				t.Fatalf("invalid list/detail header reached business: %d", response.Code)
			}
		}
	}
	for _, aware := range []bool{false, true} {
		f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
		value := configurationHTTPValue()
		headers := http.Header{}
		if aware {
			headers.Set(toolPathsHeader, "1")
		} else {
			value["toolPaths"] = map[string]any{"codex": nil, "copilot": nil, "herdr": nil}
		}
		response := controlModeRequest(t, f, "PUT", "/configuration", jsonBody(t, map[string]any{"revision": "1", "value": value}), headers)
		if response.Code != 400 {
			t.Fatalf("mismatched tool value accepted: %d %s", response.Code, response.Body)
		}
	}
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	response := controlModeRequest(t, f, "POST", "/report", jsonBody(t, configurationHTTPReportBody(nil, nil)), http.Header{toolPathsHeader: {"1"}})
	if response.Code != 400 {
		t.Fatalf("tool extension without configuration accepted: %d", response.Code)
	}
	body := configurationHTTPReportBody(nil, nil)
	body["toolPaths"] = map[string]any{"schemaVersion": 1, "observedAt": "2026-11-08T00:00:00Z", "entries": []any{}}
	response = controlModeRequest(t, f, "POST", "/report", jsonBody(t, body), http.Header{workerConfigurationHeader: {"1"}})
	if response.Code != 400 {
		t.Fatalf("legacy telemetry accepted tool fields: %d", response.Code)
	}
}

func TestWorkerToolPathsHTTPDetailAndPutProjection(t *testing.T) {
	for _, aware := range []bool{false, true} {
		f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
		headers := http.Header{}
		if aware {
			headers.Set(toolPathsHeader, "1")
		}
		telemetry := &model.ToolPathTelemetry{SchemaVersion: 1, ObservedAt: capacityObservedAt, Entries: []model.ToolPathObservation{}}
		f.operations.get = func(ctx context.Context, p model.Principal, id string) (workerservice.WorkerDetailResult, error) {
			if p != f.handler.principal || id != f.worker {
				t.Fatal("owner lost")
			}
			return workerservice.WorkerDetailResult{Worker: model.WorkerSnapshot{WorkerID: id, Telemetry: model.WorkerTelemetry{ToolPaths: telemetry}}}, nil
		}
		response := controlModeRequest(t, f, "GET", "", "", headers)
		if response.Code != 200 || strings.Contains(response.Body.String(), `"toolPaths"`) != aware {
			t.Fatalf("detail projection: %d %s", response.Code, response.Body)
		}
		if telemetry.Entries == nil {
			t.Fatal("projection mutated source")
		}
		value := configurationHTTPValue()
		if aware {
			value["toolPaths"] = map[string]any{"codex": map[string]any{"kind": "auto"}, "copilot": nil, "herdr": nil}
		}
		f.operations.put = func(ctx context.Context, p model.Principal, id, revision string, input model.WorkerConfiguration) (model.WorkerConfigurationResource, error) {
			if input.PreserveToolPaths == aware || !input.PreserveAgentControlMode || revision != "7" || p != f.handler.principal {
				t.Fatalf("PUT propagation: %+v", input)
			}
			return model.WorkerConfigurationResource{ObservationRevision: "0"}, nil
		}
		response = controlModeRequest(t, f, "PUT", "/configuration", jsonBody(t, map[string]any{"revision": "7", "value": value}), headers)
		if response.Code != 200 {
			t.Fatalf("PUT: %d %s", response.Code, response.Body)
		}
		f.operations.configuration = func(context.Context, model.Principal, string) (model.WorkerConfigurationResource, error) {
			return model.WorkerConfigurationResource{}, &model.Fault{Code: "not_found", Message: "missing", Cause: model.ErrNotFound}
		}
		response = controlModeRequest(t, f, "GET", "/configuration", "", headers)
		if response.Code != 404 || (response.Header().Get(toolPathsHeader) == "1") != aware {
			t.Fatalf("404 discovery: %d %v", response.Code, response.Header())
		}
	}
}

func TestWorkerToolPathsHTTPConflictPreservesSubmittedRevision(t *testing.T) {
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	value := configurationHTTPValue()
	value["toolPaths"] = map[string]any{"codex": map[string]any{"kind": "path", "path": "/cloud/codex"}, "copilot": nil, "herdr": nil}
	calls := 0
	f.operations.put = func(ctx context.Context, p model.Principal, id, revision string, input model.WorkerConfiguration) (model.WorkerConfigurationResource, error) {
		calls++
		if calls != 1 || ctx != f.requestContext || p != f.handler.principal || id != f.worker || revision != "7" || input.PreserveToolPaths || input.ToolPaths.Codex == nil || input.ToolPaths.Codex.Path != "/cloud/codex" {
			t.Fatal("conflicting request was changed or replayed")
		}
		return model.WorkerConfigurationResource{}, &model.Fault{Code: "version_conflict", Message: "Worker configuration revision does not match."}
	}
	response := controlModeRequest(t, f, "PUT", "/configuration", jsonBody(t, map[string]any{"revision": "7", "value": value}), http.Header{toolPathsHeader: {"1"}})
	if response.Code != http.StatusConflict || calls != 1 || !strings.Contains(response.Body.String(), `"version_conflict"`) {
		t.Fatalf("conflict mapping: %d %s calls=%d", response.Code, response.Body, calls)
	}
}
