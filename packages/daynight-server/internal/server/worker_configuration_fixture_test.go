package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

type configurationHTTPFixture struct {
	*workerHTTPFixture
	workerID string
	headers  http.Header
}

func newConfigurationHTTPFixture(t *testing.T, output io.Writer) *configurationHTTPFixture {
	t.Helper()
	return &configurationHTTPFixture{workerHTTPFixture: newWorkerHTTPFixture(t, output), workerID: "c3333333-3333-4333-8333-333333333333", headers: http.Header{"Authorization": {"Bearer " + defaultHTTPToken()}}}
}

func (f *configurationHTTPFixture) request(method, path, body string, versions ...string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header = f.headers.Clone()
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "project-test")
	for _, version := range versions {
		request.Header.Add(workerConfigurationHeader, version)
	}
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	return response
}

func (f *configurationHTTPFixture) actor(t *testing.T, p model.Principal, headers http.Header) {
	t.Helper()
	f.handler.principal = p
	f.headers = headers
}

func configurationHTTPModel(t *testing.T, value any) model.WorkerConfiguration {
	t.Helper()
	return workerHTTPValue[model.WorkerConfiguration](t, value)
}
func configurationHTTPLegacyValue(t *testing.T, value model.WorkerConfiguration) map[string]any {
	t.Helper()
	result := workerHTTPValue[map[string]any](t, value)
	delete(result, "agentControlMode")
	return result
}
func configurationHTTPExchange(t *testing.T, value any) *model.WorkerConfigurationExchange {
	t.Helper()
	return workerHTTPValue[*model.WorkerConfigurationExchange](t, value)
}
func configurationHTTPCheck(t *testing.T, actual, expected any) {
	t.Helper()
	if !reflect.DeepEqual(actual, expected) {
		workerHTTPFail(t, "configuration operation values: got %#v want %#v", actual, expected)
	}
}
func configurationHTTPCopy[T any](t *testing.T, value T) T {
	t.Helper()
	return workerHTTPValue[T](t, value)
}
func (f *configurationHTTPFixture) path() string {
	return "/api/v1/me/workers/" + f.workerID + "/configuration"
}

func (f *configurationHTTPFixture) readScope(t *testing.T, current model.WorkerConfigurationResource, failure error, request func()) {
	t.Helper()
	result := configurationHTTPCopy(t, current)
	calls := 0
	f.operations.configuration = func(ctx context.Context, p model.Principal, worker string) (model.WorkerConfigurationResource, error) {
		f.require(t, ctx, p)
		calls++
		if calls != 1 || worker != f.workerID {
			workerHTTPFail(t, "Configuration arguments: worker=%s calls=%d", worker, calls)
		}
		return configurationHTTPCopy(t, result), workerHTTPNotFound(failure)
	}
	defer func() { f.operations.configuration = nil }()
	request()
	if calls != 1 {
		workerHTTPFail(t, "Configuration calls=%d want 1", calls)
	}
}
func (f *configurationHTTPFixture) read(t *testing.T, current model.WorkerConfigurationResource, failure error, request func() *httptest.ResponseRecorder) *httptest.ResponseRecorder {
	t.Helper()
	var result *httptest.ResponseRecorder
	f.readScope(t, current, failure, func() { result = request() })
	return result
}
func (f *configurationHTTPFixture) get(t *testing.T, current model.WorkerConfigurationResource) model.WorkerConfigurationResource {
	t.Helper()
	response := f.read(t, current, nil, func() *httptest.ResponseRecorder { return f.request(http.MethodGet, f.path(), "") })
	result := decodeResponse[model.WorkerConfigurationResource](t, response, http.StatusOK)
	configurationHTTPCheck(t, result, current)
	return result
}

func (f *configurationHTTPFixture) putResult(t *testing.T, value model.WorkerConfiguration, revision string, result model.WorkerConfigurationResource, failure error, request func() *httptest.ResponseRecorder) *httptest.ResponseRecorder {
	t.Helper()
	want := configurationHTTPCopy(t, value)
	want.PreserveAgentControlMode = true
	output := configurationHTTPCopy(t, result)
	calls := 0
	f.operations.put = func(ctx context.Context, p model.Principal, worker, actualRevision string, actual model.WorkerConfiguration) (model.WorkerConfigurationResource, error) {
		f.require(t, ctx, p)
		calls++
		if calls != 1 || worker != f.workerID || actualRevision != revision {
			workerHTTPFail(t, "PutConfiguration arguments: worker=%s revision=%q calls=%d", worker, actualRevision, calls)
		}
		configurationHTTPCheck(t, actual, want)
		return configurationHTTPCopy(t, output), failure
	}
	defer func() { f.operations.put = nil }()
	response := request()
	if calls != 1 {
		workerHTTPFail(t, "PutConfiguration calls=%d want 1", calls)
	}
	return response
}

func (f *configurationHTTPFixture) put(t *testing.T, current model.WorkerConfigurationResource, value model.WorkerConfiguration, revision string, saved *model.WorkerDesiredConfiguration, accessFailure error, status int, code string) model.WorkerConfigurationResource {
	t.Helper()
	result := configurationHTTPCopy(t, current)
	if saved != nil {
		result.Desired = configurationHTTPCopy(t, saved)
	}
	var failure error
	if status != http.StatusOK {
		failure = &model.Fault{Code: code, Message: "Configuration refusal.", Cause: accessFailure}
	}
	legacyValue := configurationHTTPLegacyValue(t, value)
	response := f.putResult(t, value, revision, result, failure, func() *httptest.ResponseRecorder {
		return f.request(http.MethodPut, f.path(), jsonBody(t, map[string]any{"revision": revision, "value": legacyValue}))
	})
	if status != http.StatusOK {
		assertProjectError(t, response, status, code)
		return model.WorkerConfigurationResource{}
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != f.handler.principal.UserID || response.Header().Get(workerConfigurationHeader) != "1" {
		t.Fatal("configuration mutation lost private ownership or protocol headers")
	}
	got := decodeResponse[model.WorkerConfigurationResource](t, response, status)
	configurationHTTPCheck(t, got, result)
	return got
}

func (f *configurationHTTPFixture) invalidRevision(t *testing.T, revision string, value model.WorkerConfiguration, request func() *httptest.ResponseRecorder) *httptest.ResponseRecorder {
	t.Helper()
	return f.putResult(t, value, revision, model.WorkerConfigurationResource{}, &model.Fault{Code: "invalid_input", Message: "Configuration revision is invalid."}, request)
}

func (f *configurationHTTPFixture) report(t *testing.T, current model.WorkerConfigurationResource, body map[string]any, expectedExchange *model.WorkerConfigurationExchange, saved *model.WorkerDesiredConfiguration, accessFailure error, accepted *model.WorkerConfigurationResource, status int, code string) configurationHTTPReceipt {
	t.Helper()
	want := workerHTTPReportInput(t, body)
	want.Configuration = configurationHTTPCopy(t, expectedExchange)
	result := workerservice.WorkerReportResult{ObservedAt: f.now, LastReportedAt: f.now}
	if expectedExchange != nil {
		receipt := &model.WorkerConfigurationReceipt{Desired: configurationHTTPCopy(t, current.Desired), ObservationRevision: current.ObservationRevision}
		if saved != nil {
			receipt.Desired = configurationHTTPCopy(t, saved)
		}
		if accepted != nil {
			receipt.ObservationAccepted = true
			receipt.ObservationRevision = accepted.ObservationRevision
		}
		result.Configuration = receipt
	}
	var failure error
	if status != http.StatusOK {
		failure = &model.Fault{Code: code, Message: "Configuration refusal.", Cause: accessFailure}
	}
	calls := 0
	f.operations.report = func(ctx context.Context, p model.Principal, worker string, actual model.WorkerReport) (workerservice.WorkerReportResult, error) {
		f.require(t, ctx, p)
		calls++
		if calls != 1 || worker != f.workerID {
			workerHTTPFail(t, "configuration Report arguments: worker=%s calls=%d", worker, calls)
		}
		configurationHTTPCheck(t, actual, want)
		return workerHTTPValue[workerservice.WorkerReportResult](t, result), failure
	}
	defer func() { f.operations.report = nil }()
	versions := []string(nil)
	if expectedExchange != nil {
		versions = []string{"1"}
	}
	response := f.request(http.MethodPost, "/api/v1/me/workers/"+f.workerID+"/report", jsonBody(t, body), versions...)
	if calls != 1 {
		workerHTTPFail(t, "configuration Report calls=%d want 1", calls)
	}
	if status != http.StatusOK {
		assertProjectError(t, response, status, code)
		return configurationHTTPReceipt{}
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != f.handler.principal.UserID {
		t.Fatal("report lost private admission headers")
	}
	if expectedExchange == nil {
		fields := decodeResponse[map[string]json.RawMessage](t, response, status)
		if len(fields) != 2 || fields["observedAt"] == nil || fields["lastReportedAt"] == nil || response.Header().Get(workerConfigurationHeader) != "" {
			t.Fatalf("legacy report receipt changed: %s", response.Body)
		}
		return configurationHTTPReceipt{}
	}
	if response.Header().Get(workerConfigurationHeader) != "1" {
		t.Fatal("configuration report lost protocol header")
	}
	got := decodeResponse[configurationHTTPReceipt](t, response, status)
	configurationHTTPCheck(t, got, configurationHTTPReceipt{ObservedAt: result.ObservedAt, LastReportedAt: result.LastReportedAt, Configuration: *result.Configuration})
	return got
}
