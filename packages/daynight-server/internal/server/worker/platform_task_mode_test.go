package worker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

func TestPlatformTaskModeHTTPNegotiation(t *testing.T) {
	for _, aware := range []bool{false, true} {
		f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
		value := configurationHTTPModel(t, configurationHTTPValue())
		value.PlatformTaskMode = model.PlatformTaskOnly
		desired := &model.WorkerDesiredConfiguration{Revision: "2", UpdatedAt: capacityObservedAt, Value: value}
		f.operations.configuration = func(context.Context, model.Principal, string) (model.WorkerConfigurationResource, error) {
			return model.WorkerConfigurationResource{Desired: desired, ObservationRevision: "0"}, nil
		}
		f.operations.put = func(_ context.Context, _ model.Principal, _ string, _ string, input model.WorkerConfiguration) (model.WorkerConfigurationResource, error) {
			if input.LegacyPlatformTaskMode == aware || input.PlatformTaskMode != model.PlatformTaskPrefer {
				t.Fatalf("negotiated input: %+v", input)
			}
			return model.WorkerConfigurationResource{Desired: desired, ObservationRevision: "0"}, nil
		}
		f.operations.report = func(_ context.Context, _ model.Principal, _ string, input model.WorkerReport) (workerservice.WorkerReportResult, error) {
			if input.Configuration.Bootstrap.PlatformTaskMode != model.PlatformTaskAll {
				t.Fatal("bootstrap changed")
			}
			return workerservice.WorkerReportResult{Configuration: &model.WorkerConfigurationReceipt{Desired: desired, ObservationRevision: "0"}}, nil
		}
		f.operations.get = func(context.Context, model.Principal, string) (workerservice.WorkerDetailResult, error) {
			return workerservice.WorkerDetailResult{}, nil
		}
		headers := http.Header{}
		if aware {
			headers.Set(workerPlatformTaskModeHeader, "1")
		}
		for _, method := range []string{"GET", "HEAD"} {
			response := controlModeRequest(t, f, method, "/configuration", "", headers)
			if response.Code != 200 || (response.Header().Get(workerPlatformTaskModeHeader) == "1") != aware {
				t.Fatalf("%s aware=%v: %d %v", method, aware, response.Code, response.Header())
			}
			if method == "GET" && (strings.Contains(response.Body.String(), `"platformTaskMode":"only"`) != aware || strings.Contains(response.Body.String(), `"preferPlatformSpecificTasks":true`) == aware) {
				t.Fatalf("projection: %s", response.Body)
			}
		}
		input := configurationHTTPValue()
		input["preferPlatformSpecificTasks"] = true
		if aware {
			delete(input, "preferPlatformSpecificTasks")
			input["platformTaskMode"] = "prefer"
		}
		response := controlModeRequest(t, f, "PUT", "/configuration", jsonBody(t, map[string]any{"revision": "2", "value": input}), headers)
		if response.Code != 200 || (response.Header().Get(workerPlatformTaskModeHeader) == "1") != aware {
			t.Fatalf("PUT: %d %s", response.Code, response.Body)
		}
		detail := controlModeRequest(t, f, "GET", "", "", headers)
		if detail.Code != 200 || (detail.Header().Get(workerPlatformTaskModeHeader) == "1") != aware {
			t.Fatalf("detail: %d %s", detail.Code, detail.Body)
		}
		headers.Set(workerConfigurationHeader, "1")
		response = controlModeRequest(t, f, "POST", "/report", jsonBody(t, configurationHTTPReportBody(configurationHTTPValue(), nil)), headers)
		if response.Code != 200 || (response.Header().Get(workerPlatformTaskModeHeader) == "1") != aware {
			t.Fatalf("report: %d %s", response.Code, response.Body)
		}
	}
	f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	for _, values := range [][]string{{"2"}, {"1", "1"}, {""}} {
		response := controlModeRequest(t, f, "GET", "/configuration", "", http.Header{workerPlatformTaskModeHeader: values})
		if response.Code != 400 {
			t.Fatalf("invalid version: %d %s", response.Code, response.Body)
		}
	}
	response := controlModeRequest(t, f, "POST", "/report", jsonBody(t, workerSnapshotReportBody()), http.Header{workerPlatformTaskModeHeader: {"1"}})
	if response.Code != 400 {
		t.Fatalf("missing base protocol: %d %s", response.Code, response.Body)
	}
}

func TestPlatformTaskModeObservationProjectionHasNoSyntheticSupport(t *testing.T) {
	source := model.WorkerConfigurationResource{Observation: &model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: model.WorkerConfigurationObservation{Items: []model.WorkerConfigurationItem{
		{Key: model.WorkerConfigurationItemKey{Kind: "platformTaskMode"}, AppliedValue: json.RawMessage(`"only"`), State: "applied"},
		{Key: model.WorkerConfigurationItemKey{Kind: "preferPlatformSpecificTasks"}, AppliedValue: json.RawMessage(`true`), State: "applied"},
	}}}}
	for _, aware := range []bool{false, true} {
		got := projectConfiguration(source, workerprotocol.Capabilities{PlatformTaskMode: aware})
		if len(got.Observation.Items) != 1 || (got.Observation.Items[0].Key.Kind == "platformTaskMode") != aware {
			t.Fatalf("projection aware=%v: %+v", aware, got)
		}
	}
	if len(source.Observation.Items) != 2 {
		t.Fatal("projection mutated source")
	}
	raw := json.RawMessage(`{"platformTaskMode":"only","future":{"value":1234567890123456789012345}}`)
	encoded, err := (rawConfigurationProjection{raw: raw}).MarshalJSON()
	if err != nil || !strings.Contains(string(encoded), `"preferPlatformSpecificTasks":true`) || !strings.Contains(string(encoded), `1234567890123456789012345`) || strings.Contains(string(encoded), "platformTaskMode") {
		t.Fatalf("raw projection: %s %v", encoded, err)
	}
}

func TestPlatformTaskModeRefusalsThroughServiceHTTP(t *testing.T) {
	for _, tc := range []struct {
		name, previous, code string
		legacy               bool
	}{
		{"legacy exit", "only", "worker_platform_task_mode_upgrade_required", true},
		{"unsupported enable", "all", "worker_platform_task_mode_unsupported", false},
	} {
		for _, completion := range []string{"rollback", "unknown", "cleanup", "database"} {
			t.Run(tc.name+"/"+completion, func(t *testing.T) {
				f := newConfigurationHTTPFixture(t, io.Discard)
				value := configurationHTTPModel(t, configurationHTTPValue())
				value.PlatformTaskMode = model.WorkerPlatformTaskMode(tc.previous)
				current := model.WorkerConfigurationResource{Desired: &model.WorkerDesiredConfiguration{Revision: "1", UpdatedAt: capacityObservedAt, Value: value}, ObservationRevision: "0"}
				calls := 0
				dao := &workerHTTPWriteDAO{t: t, WorkerConfigurationCall: func(_ context.Context, user, worker string) (model.WorkerConfigurationResource, error) {
					calls++
					if user != f.handler.principal.UserID || worker != f.workerID {
						t.Fatal("incorrect configuration identity")
					}
					return current, nil
				}}
				f.tx.WriteWorkerCall = func(_ context.Context, op func(store.WorkerScope) error) (store.Completion, error) {
					err := op(&workerHTTPWriteScope{t: t, DAO: dao})
					var fault *model.Fault
					if !errors.As(err, &fault) || fault.Code != tc.code {
						t.Fatalf("core refusal: %v", err)
					}
					tx := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
					switch completion {
					case "unknown":
						tx.Phase, tx.Outcome = "commit", store.TransactionUnknown
					case "cleanup":
						tx.CleanupFailed = true
					case "database":
						tx.Cause = errors.Join(err, &store.Error{DatabaseFailure: true, Cause: errors.New("database failure")})
					}
					return store.Completion{Outcome: tx.Outcome}, tx
				}
				input := configurationHTTPValue()
				if tc.legacy {
					input["preferPlatformSpecificTasks"] = false
				} else {
					delete(input, "preferPlatformSpecificTasks")
					input["platformTaskMode"] = "only"
				}
				body := jsonBody(t, map[string]any{"revision": "1", "value": input})
				var response *httptest.ResponseRecorder
				if tc.legacy {
					response = projectRequest(f.handler, http.MethodPut, f.path(), body)
				} else {
					response = f.request(http.MethodPut, f.path(), body)
				}
				if calls != 1 {
					t.Fatalf("configuration reads = %d", calls)
				}
				if completion == "rollback" {
					assertProjectError(t, response, http.StatusConflict, tc.code)
				} else {
					assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
				}
			})
		}
	}
}
