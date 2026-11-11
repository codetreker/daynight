package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	monitoring "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/monitoring"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	workerhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/worker"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

type capacityReportOperations struct {
	t             *testing.T
	report        func(context.Context, model.Principal, string, model.WorkerReport) (workerservice.WorkerReportResult, error)
	put           func(context.Context, model.Principal, string, string, model.WorkerConfiguration) (model.WorkerConfigurationResource, error)
	get           func(context.Context, model.Principal, string) (workerservice.WorkerDetailResult, error)
	list          func(context.Context, model.Principal, model.PageRequest) (workerservice.WorkerPage, error)
	configuration func(context.Context, model.Principal, string) (model.WorkerConfigurationResource, error)
}

func (s *capacityReportOperations) unexpected(method string) error {
	s.t.Helper()
	s.t.Errorf("unexpected Worker operation: %s", method)
	return errors.New("unexpected Worker operation: " + method)
}

func (s *capacityReportOperations) Report(ctx context.Context, principal model.Principal, worker string, input model.WorkerReport) (workerservice.WorkerReportResult, error) {
	if s.report == nil {
		return workerservice.WorkerReportResult{}, s.unexpected("Report")
	}
	return s.report(ctx, principal, worker, input)
}

func (s *capacityReportOperations) ReportSync(context.Context, model.Principal, string, model.WorkerReport, []model.PromptSelector) (workerservice.ConfigurationSyncResult, error) {
	return workerservice.ConfigurationSyncResult{}, s.unexpected("ReportSync")
}

func (s *capacityReportOperations) List(ctx context.Context, principal model.Principal, page model.PageRequest) (workerservice.WorkerPage, error) {
	if s.list == nil {
		return workerservice.WorkerPage{}, s.unexpected("List")
	}
	return s.list(ctx, principal, page)
}

func (s *capacityReportOperations) Get(ctx context.Context, principal model.Principal, worker string) (workerservice.WorkerDetailResult, error) {
	if s.get == nil {
		return workerservice.WorkerDetailResult{}, s.unexpected("Get")
	}
	return s.get(ctx, principal, worker)
}

func (s *capacityReportOperations) Configuration(ctx context.Context, principal model.Principal, worker string) (model.WorkerConfigurationResource, error) {
	if s.configuration == nil {
		return model.WorkerConfigurationResource{}, s.unexpected("Configuration")
	}
	return s.configuration(ctx, principal, worker)
}

func (s *capacityReportOperations) PutConfiguration(ctx context.Context, principal model.Principal, worker, revision string, value model.WorkerConfiguration) (model.WorkerConfigurationResource, error) {
	if s.put == nil {
		return model.WorkerConfigurationResource{}, s.unexpected("PutConfiguration")
	}
	return s.put(ctx, principal, worker, revision, value)
}

func (s *capacityReportOperations) PutMonitoring(context.Context, model.Principal, string, *string, monitoring.Observation) (monitoring.Receipt, error) {
	return monitoring.Receipt{}, s.unexpected("PutMonitoring")
}

func (s *capacityReportOperations) GetMonitoring(context.Context, model.Principal, string) (monitoring.DetailResponse, error) {
	return monitoring.DetailResponse{}, s.unexpected("GetMonitoring")
}

func (s *capacityReportOperations) QueryMonitoring(context.Context, model.Principal, []string) (monitoring.QueryResponse, error) {
	return monitoring.QueryResponse{}, s.unexpected("QueryMonitoring")
}

type capacityReportOperationFixture struct {
	t              *testing.T
	handler        *resourceTestHandler
	operations     *capacityReportOperations
	worker         string
	requestContext context.Context
	authCalls      int
}

func newCapacityReportOperationFixture(t *testing.T, worker string) *capacityReportOperationFixture {
	t.Helper()
	return newCapacityReportOperationFixtureWithOutput(t, worker, io.Discard)
}

func newCapacityReportOperationFixtureWithOutput(t *testing.T, worker string, output io.Writer) *capacityReportOperationFixture {
	t.Helper()
	f := &capacityReportOperationFixture{t: t, worker: worker, operations: &capacityReportOperations{t: t}}
	f.handler = &resourceTestHandler{token: "worker-capacity-token", principal: defaultHTTPPrincipal()}
	logger := slog.New(slog.NewJSONHandler(output, nil))
	auth, err := authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		f.authCalls++
		if f.authCalls != 1 || ctx != f.requestContext || kind != model.PATCredential || token != f.handler.token {
			t.Errorf("unexpected credential arguments or call count: %s %d", kind, f.authCalls)
			return model.Principal{}, authhttp.Failure()
		}
		return f.handler.principal, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	workerhttp.RegisterRoutes(mux, f.operations, &authhttp.Authentication{RequestAuthentication: auth}, logger)
	f.handler.Handler = httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requestContext = r.Context()
		mux.ServeHTTP(w, r)
	}))
	return f
}

func (f *capacityReportOperationFixture) request(body map[string]any, calls int, refusal error) *httptest.ResponseRecorder {
	f.t.Helper()
	return f.reportRequest(body, calls, workerservice.WorkerReportResult{ObservedAt: capacityObservedAt, LastReportedAt: capacityObservedAt}, refusal, "")
}

func (f *capacityReportOperationFixture) reportRequest(body map[string]any, calls int, result workerservice.WorkerReportResult, refusal error, protocol string) *httptest.ResponseRecorder {
	f.t.Helper()
	want := model.WorkerReport{
		Telemetry:     capacityDecode[model.WorkerTelemetry](f.t, body),
		TaskInventory: capacityDecode[*model.WorkerTaskInventory](f.t, body["taskInventory"]),
		Configuration: nil,
	}
	if protocol == "1" {
		want.Configuration = capacityDecode[*model.WorkerConfigurationExchange](f.t, body["configuration"])
	}
	used := 0
	f.operations.report = func(ctx context.Context, principal model.Principal, worker string, input model.WorkerReport) (workerservice.WorkerReportResult, error) {
		used++
		if used > calls {
			return workerservice.WorkerReportResult{}, f.operations.unexpected("Report")
		}
		if ctx != f.requestContext || principal != f.handler.principal || worker != f.worker || !reflect.DeepEqual(input, want) {
			f.t.Errorf("Report arguments differ:\nactual: %+v\nwant: %+v", input, want)
		}
		return capacityDecode[workerservice.WorkerReportResult](f.t, result), refusal
	}
	defer func() { f.operations.report = nil }()
	response := f.dispatch(http.MethodPost, "/report", body, protocol)
	if used != calls {
		f.t.Fatalf("Report calls = %d, want %d", used, calls)
	}
	return response
}

func (f *capacityReportOperationFixture) dispatch(method, suffix string, body map[string]any, protocol string) *httptest.ResponseRecorder {
	f.t.Helper()
	return f.dispatchRaw(method, "/api/v1/me/workers/"+f.worker+suffix, jsonBody(f.t, body), protocol)
}

func (f *capacityReportOperationFixture) dispatchRaw(method, path, body, protocol string) *httptest.ResponseRecorder {
	f.t.Helper()
	f.authCalls = 0
	var response *httptest.ResponseRecorder
	if protocol == "" {
		response = projectRequest(f.handler, method, path, body)
	} else {
		response = configurationHTTPRequest(f.handler, method, path, body, protocol)
	}
	if f.authCalls != 1 {
		f.t.Fatalf("credential calls = %d, want 1", f.authCalls)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != f.handler.principal.UserID {
		f.t.Fatalf("worker private response headers differ: %v", response.Header())
	}
	return response
}

func (f *capacityReportOperationFixture) putRequest(body map[string]any, calls int, result model.WorkerConfigurationResource) *httptest.ResponseRecorder {
	f.t.Helper()
	want := capacityDecode[model.WorkerConfiguration](f.t, body["value"])
	want.PreserveAgentControlMode = true
	revision := body["revision"].(string)
	used := 0
	f.operations.put = func(ctx context.Context, principal model.Principal, worker, actualRevision string, value model.WorkerConfiguration) (model.WorkerConfigurationResource, error) {
		used++
		if used > calls {
			return model.WorkerConfigurationResource{}, f.operations.unexpected("PutConfiguration")
		}
		if ctx != f.requestContext || principal != f.handler.principal || worker != f.worker || actualRevision != revision || !reflect.DeepEqual(value, want) {
			f.t.Errorf("PutConfiguration arguments differ: revision %q, want %q; value %+v, want %+v", actualRevision, revision, value, want)
		}
		return capacityDecode[model.WorkerConfigurationResource](f.t, result), nil
	}
	defer func() { f.operations.put = nil }()
	response := f.dispatch(http.MethodPut, "/configuration", body, "")
	if used != calls {
		f.t.Fatalf("PutConfiguration calls = %d, want %d", used, calls)
	}
	return response
}

func (f *capacityReportOperationFixture) success(body map[string]any) {
	f.t.Helper()
	got := decodeResponse[api.WorkerReportResponse](f.t, f.request(body, 1, nil), http.StatusOK)
	want := api.WorkerReportResponse{ObservedAt: capacityObservedAt, LastReportedAt: capacityObservedAt}
	if got != want {
		f.t.Fatalf("worker report response = %+v, want %+v", got, want)
	}
}

func (f *capacityReportOperationFixture) getRequest(result workerservice.WorkerDetailResult) *httptest.ResponseRecorder {
	f.t.Helper()
	used := 0
	f.operations.get = func(ctx context.Context, principal model.Principal, worker string) (workerservice.WorkerDetailResult, error) {
		used++
		if used > 1 {
			return workerservice.WorkerDetailResult{}, f.operations.unexpected("Get")
		}
		if ctx != f.requestContext || principal != f.handler.principal || worker != f.worker {
			f.t.Errorf("Get arguments differ: principal=%+v worker=%s", principal, worker)
		}
		return capacityDecode[workerservice.WorkerDetailResult](f.t, result), nil
	}
	defer func() { f.operations.get = nil }()
	response := f.dispatchRaw(http.MethodGet, "/api/v1/me/workers/"+f.worker, "", "")
	if used != 1 {
		f.t.Fatalf("Get calls = %d, want 1", used)
	}
	return response
}

func (f *capacityReportOperationFixture) configurationRequest(result model.WorkerConfigurationResource) *httptest.ResponseRecorder {
	f.t.Helper()
	used := 0
	f.operations.configuration = func(ctx context.Context, principal model.Principal, worker string) (model.WorkerConfigurationResource, error) {
		used++
		if used > 1 {
			return model.WorkerConfigurationResource{}, f.operations.unexpected("Configuration")
		}
		if ctx != f.requestContext || principal != f.handler.principal || worker != f.worker {
			f.t.Errorf("Configuration arguments differ: principal=%+v worker=%s", principal, worker)
		}
		return capacityDecode[model.WorkerConfigurationResource](f.t, result), nil
	}
	defer func() { f.operations.configuration = nil }()
	response := f.dispatchRaw(http.MethodGet, "/api/v1/me/workers/"+f.worker+"/configuration", "", "")
	if used != 1 {
		f.t.Fatalf("Configuration calls = %d, want 1", used)
	}
	if response.Header().Get(workerConfigurationHeader) != "1" {
		f.t.Fatalf("configuration response lacks its protocol header: %v", response.Header())
	}
	return response
}

func (f *capacityReportOperationFixture) listRequest(result workerservice.WorkerPage) *httptest.ResponseRecorder {
	f.t.Helper()
	used := 0
	f.operations.list = func(ctx context.Context, principal model.Principal, page model.PageRequest) (workerservice.WorkerPage, error) {
		used++
		if used > 1 {
			return workerservice.WorkerPage{}, f.operations.unexpected("List")
		}
		if ctx != f.requestContext || principal != f.handler.principal || !reflect.DeepEqual(page, model.PageRequest{Limit: 50}) {
			f.t.Errorf("List arguments differ: principal=%+v page=%+v", principal, page)
		}
		return capacityDecode[workerservice.WorkerPage](f.t, result), nil
	}
	defer func() { f.operations.list = nil }()
	response := f.dispatchRaw(http.MethodGet, "/api/v1/me/workers", "", "")
	if used != 1 {
		f.t.Fatalf("List calls = %d, want 1", used)
	}
	return response
}
