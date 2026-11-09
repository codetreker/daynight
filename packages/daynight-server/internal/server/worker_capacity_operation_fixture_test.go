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

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	monitoring "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/monitoring"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	workerhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/worker"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

type capacityReportOperations struct {
	t      *testing.T
	report func(context.Context, model.Principal, string, model.WorkerReport) (workerservice.WorkerReportResult, error)
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

func (s *capacityReportOperations) List(context.Context, model.Principal, model.PageRequest) (workerservice.WorkerPage, error) {
	return workerservice.WorkerPage{}, s.unexpected("List")
}

func (s *capacityReportOperations) Get(context.Context, model.Principal, string) (workerservice.WorkerDetailResult, error) {
	return workerservice.WorkerDetailResult{}, s.unexpected("Get")
}

func (s *capacityReportOperations) Configuration(context.Context, model.Principal, string) (model.WorkerConfigurationResource, error) {
	return model.WorkerConfigurationResource{}, s.unexpected("Configuration")
}

func (s *capacityReportOperations) PutConfiguration(context.Context, model.Principal, string, string, model.WorkerConfiguration) (model.WorkerConfigurationResource, error) {
	return model.WorkerConfigurationResource{}, s.unexpected("PutConfiguration")
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
	f := &capacityReportOperationFixture{t: t, worker: worker, operations: &capacityReportOperations{t: t}}
	f.handler = &resourceTestHandler{token: "worker-capacity-token", principal: defaultHTTPPrincipal()}
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	auth, err := authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		f.authCalls++
		if f.authCalls != 1 || ctx != f.requestContext || kind != model.PATCredential || token != f.handler.token {
			t.Errorf("unexpected credential arguments or call count: %s %d", kind, f.authCalls)
			return model.Principal{}, authhttp.Failure()
		}
		return f.handler.principal, nil
	}, config.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
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
	want := model.WorkerReport{
		Telemetry:     capacityDecode[model.WorkerTelemetry](f.t, body),
		TaskInventory: capacityDecode[*model.WorkerTaskInventory](f.t, body["taskInventory"]),
		Configuration: nil,
	}
	f.authCalls = 0
	used := 0
	f.operations.report = func(ctx context.Context, principal model.Principal, worker string, input model.WorkerReport) (workerservice.WorkerReportResult, error) {
		used++
		if used > calls {
			return workerservice.WorkerReportResult{}, f.operations.unexpected("Report")
		}
		if ctx != f.requestContext || principal != f.handler.principal || worker != f.worker || !reflect.DeepEqual(input, want) {
			f.t.Errorf("Report arguments differ:\nactual: %+v\nwant: %+v", input, want)
		}
		return workerservice.WorkerReportResult{ObservedAt: capacityObservedAt, LastReportedAt: capacityObservedAt}, refusal
	}
	defer func() { f.operations.report = nil }()
	response := projectRequest(f.handler, http.MethodPost, "/api/v1/me/workers/"+f.worker+"/report", jsonBody(f.t, body))
	if used != calls || f.authCalls != 1 {
		f.t.Fatalf("Report calls = %d, want %d; credential calls = %d, want 1", used, calls, f.authCalls)
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != f.handler.principal.UserID {
		f.t.Fatalf("worker report private response headers differ: %v", response.Header())
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
