package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreworker "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	monitoring "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/monitoring"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"github.com/google/uuid"
)

func workerSnapshotReportBody() map[string]any {
	now := "2026-10-29T00:00:00Z"
	probe := func(value any) map[string]any { return map[string]any{"state": "ok", "checkedAt": now, "value": value} }
	return map[string]any{"machine": map[string]any{"id": uuid.NewString(), "name": "Private worker machine"}, "platform": "linux", "workingDirectory": "/private/work", "sampledAt": now,
		"os":     probe(map[string]any{"type": "Linux", "release": "6.8", "version": "kernel", "arch": "x64"}),
		"cpu":    probe(map[string]any{"model": "CPU", "logicalProcessors": 4, "usagePercent": 12.5}),
		"memory": probe(map[string]any{"usedBytes": 4, "totalBytes": 8}), "disk": probe(map[string]any{"availableBytes": 8, "totalBytes": 16}),
		"versions":      map[string]any{"daynight": "1.0.0", "herdr": probe("0.9.5"), "codex": map[string]any{"state": "not_installed", "checkedAt": now}, "copilot": map[string]any{"state": "error", "checkedAt": now, "code": "timeout"}},
		"taskInventory": map[string]any{"observedAt": now, "claims": []any{}}}
}

func TestWorkerReportStrictInputObjects(t *testing.T) {
	for _, key := range workerRequiredReportFields {
		body := workerSnapshotReportBody()
		delete(body, key)
		fields, err := jsonobject.Decode([]byte(jsonBody(t, body)), "report", workerReportFields...)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := workerReportInput(fields); err == nil {
			t.Errorf("missing %s accepted", key)
		}
	}
	for _, key := range workerReportFields {
		if key == "taskInventory" {
			continue
		}
		body := workerSnapshotReportBody()
		body[key] = nil
		fields, err := jsonobject.Decode([]byte(jsonBody(t, body)), "report", workerReportFields...)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := workerReportInput(fields); err == nil {
			t.Errorf("null %s accepted", key)
		}
	}
	base := jsonBody(t, workerSnapshotReportBody())
	for _, test := range []struct{ old, replacement string }{
		{`"machine":{`, `"machine":{"unknown":true,`}, {`"name":"Private worker machine"`, `"name":null`},
		{`"platform":"linux"`, `"platform":false`}, {`"workingDirectory":"/private/work"`, `"workingDirectory":null`},
		{`"sampledAt":"2026-10-29T00:00:00Z"`, `"sampledAt":"bad"`},
		{`"state":"ok"`, `"state":"unknown"`}, {`"state":"ok"`, `"state":"ok","state":"ok"`},
		{`"checkedAt":"2026-10-29T00:00:00Z"`, `"checkedAt":false`},
		{`"arch":"x64"`, `"arch":2`}, {`"logicalProcessors":4`, `"logicalProcessors":null`},
		{`"model":"CPU"`, `"model":false`}, {`"usagePercent":12.5`, `"usagePercent":null`}, {`"usagePercent":12.5`, `"usagePercent":"12"`},
		{`"usedBytes":4`, `"usedBytes":1.1`}, {`"totalBytes":8`, `"totalBytes":true`}, {`"availableBytes":8`, `"availableBytes":-1`},
		{`"daynight":"1.0.0"`, `"daynight":null`}, {`"state":"not_installed"`, `"state":"not_installed","value":"bad"`},
		{`"claims":[]`, `"claims":null`}, {`"claims":[]`, `"claims":{}`}, {`"claims":[]`, `"claims":[{"projectId":"x","taskId":"y"}]`},
		{`"os":{`, `"os":{"code":"timeout",`}, {`"memory":{`, `"memory":{"unknown":true,`}, {`"versions":{`, `"versions":{"unknown":true,`},
	} {
		if !strings.Contains(base, test.old) {
			t.Fatalf("fixture text missing %s", test.old)
		}
		body := strings.Replace(base, test.old, test.replacement, 1)
		fields, err := jsonobject.Decode([]byte(body), "report", workerReportFields...)
		if err == nil {
			_, err = workerReportInput(fields)
		}
		if err == nil {
			t.Errorf("invalid nested input accepted: %s", body)
		}
	}
	body := workerSnapshotReportBody()
	body["taskInventory"] = nil
	fields, _ := jsonobject.Decode([]byte(jsonBody(t, body)), "report", workerReportFields...)
	if report, err := workerReportInput(fields); err != nil || report.TaskInventory != nil {
		t.Fatal("explicit unknown inventory rejected", err)
	}
	body = workerSnapshotReportBody()
	body["taskInventory"] = map[string]any{"observedAt": "2026-10-29T00:00:00+02:00", "claims": []any{map[string]any{"projectId": uuid.NewString(), "taskId": uuid.NewString(), "claimId": uuid.NewString()}}}
	fields, _ = jsonobject.Decode([]byte(jsonBody(t, body)), "report", workerReportFields...)
	if report, err := workerReportInput(fields); err != nil || len(report.TaskInventory.Claims) != 1 || report.TaskInventory.ObservedAt.Location().String() != "UTC" {
		t.Fatal("valid inventory rejected", err)
	}
}

func TestWorkerSafeIntegerParsing(t *testing.T) {
	for raw, want := range map[string]int64{"0": 0, "-0": 0, "0e999999999999": 0, "1.0": 1, "1e3": 1000, "12300e-2": 123, "9007199254740991": 9007199254740991} {
		got, err := workerIntegerInput(json.RawMessage(raw))
		if err != nil || got != want {
			t.Errorf("%s: %d %v", raw, got, err)
		}
	}
	for _, raw := range []string{"", "null", "true", `"1"`, "[]", "{}", "-1", "1.1", "1e-1", "9007199254740992", "9007199254740991.1", "1e999999999999", "1e-999999999999", "1e30", "9223372036854775807"} {
		if _, err := workerIntegerInput(json.RawMessage(raw)); err == nil {
			t.Errorf("unsafe integer accepted: %s", raw)
		}
	}
}

func TestWorkerReportTimestampSyntax(t *testing.T) {
	for _, value := range []string{"2026-10-29T00:00:00Z", "2026-10-29T00:00:00.123456789Z", "2026-10-29T00:00:00.123+02:30", "2026-10-29t00:00:00z", "2026-10-29T00:00:00-03:15"} {
		fields := map[string]json.RawMessage{"sampledAt": json.RawMessage(`"` + value + `"`)}
		stamp, err := workerTimeInput(fields, "sampledAt")
		if err != nil || stamp.Location().String() != "UTC" {
			t.Errorf("valid timestamp %s: %v", value, err)
		}
	}
	for _, value := range []string{"2026-10-29T00:00:00+24:00", "2026-10-29T00:00:00+00:60", "2026-10-29T00:00:00,1Z", "2026-10-29T24:00:00Z", "2026-02-30T00:00:00Z", "2026-10-29T0:00:00Z", "2026-10-29 00:00:00Z"} {
		fields := map[string]json.RawMessage{"sampledAt": json.RawMessage(`"` + value + `"`)}
		if _, err := workerTimeInput(fields, "sampledAt"); err == nil {
			t.Errorf("invalid timestamp accepted: %s", value)
		}
	}
}

func jsonBody(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

var capacityObservedAt = time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)

func capacityDecode[T any](t *testing.T, value any) T {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var got T
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	return got
}

func capacityExpectedSnapshot(t *testing.T, user, worker string, body map[string]any) model.WorkerSnapshot {
	t.Helper()
	telemetry := capacityDecode[model.WorkerTelemetry](t, body)
	observation := model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}}
	if body["taskInventory"] != nil {
		inventory := capacityDecode[model.WorkerTaskInventory](t, body["taskInventory"])
		observation = model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &capacityObservedAt, InventoryObservedAt: &inventory.ObservedAt, Items: []model.WorkerObservedTask{}}
	}
	return model.WorkerSnapshot{UserID: user, WorkerID: worker, CreatedAt: capacityObservedAt, LastReportedAt: capacityObservedAt, Telemetry: telemetry, TaskSnapshot: observation}
}

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
	}, config.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, f.operations, &authhttp.Authentication{RequestAuthentication: auth}, logger)
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

func boundedUTF8(size int) string { return strings.Repeat("界", size/3) + strings.Repeat("x", size%3) }

func TestWorkerReportCapacityHTTPRejectsBeforeWrite(t *testing.T) {
	tests := []struct {
		name string
		size int
		set  func(map[string]any, string)
	}{
		{"machine", 256, func(b map[string]any, s string) { b["machine"].(map[string]any)["name"] = s }},
		{"cwd", 4096, func(b map[string]any, s string) { b["workingDirectory"] = s }},
		{"daynight", 256, func(b map[string]any, s string) { b["versions"].(map[string]any)["daynight"] = s }},
		{"herdr", 256, func(b map[string]any, s string) {
			b["versions"].(map[string]any)["herdr"].(map[string]any)["value"] = s
		}},
		{"codex", 256, func(b map[string]any, s string) {
			b["versions"].(map[string]any)["codex"] = map[string]any{"state": "ok", "checkedAt": "2026-10-29T00:00:00Z", "value": s}
		}},
		{"copilot", 256, func(b map[string]any, s string) {
			b["versions"].(map[string]any)["copilot"] = map[string]any{"state": "ok", "checkedAt": "2026-10-29T00:00:00Z", "value": s}
		}},
		{"os.type", 64, func(b map[string]any, s string) { b["os"].(map[string]any)["value"].(map[string]any)["type"] = s }},
		{"os.arch", 64, func(b map[string]any, s string) { b["os"].(map[string]any)["value"].(map[string]any)["arch"] = s }},
		{"os.release", 256, func(b map[string]any, s string) { b["os"].(map[string]any)["value"].(map[string]any)["release"] = s }},
		{"os.version", 1024, func(b map[string]any, s string) { b["os"].(map[string]any)["value"].(map[string]any)["version"] = s }},
		{"cpu.model", 512, func(b map[string]any, s string) { b["cpu"].(map[string]any)["value"].(map[string]any)["model"] = s }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := newCapacityReportOperationFixture(t, uuid.NewString())
			body := workerSnapshotReportBody()
			value := boundedUTF8(tc.size)
			tc.set(body, value)
			f.success(body)
			tc.set(body, value+"x")
			assertProjectError(t, f.request(body, 1, &model.Fault{Code: "invalid_input", Message: "Worker report exceeds its capacity."}), http.StatusBadRequest, "invalid_input")
		})
	}
	for _, kind := range []string{"claims", "projects"} {
		t.Run(kind, func(t *testing.T) {
			f := newCapacityReportOperationFixture(t, uuid.NewString())
			body := workerSnapshotReportBody()
			set := func(n int) {
				items := make([]any, n)
				for i := range items {
					if kind == "claims" {
						items[i] = map[string]any{"projectId": uuid.NewString(), "taskId": uuid.NewString(), "claimId": uuid.NewString()}
					} else {
						items[i] = map[string]any{"projectId": uuid.NewString(), "native": nil}
					}
				}
				if kind == "claims" {
					body["taskInventory"].(map[string]any)["claims"] = items
				} else {
					body["runtimeConfiguration"] = map[string]any{"schemaVersion": 1, "native": nil, "projects": items}
				}
			}
			maximum := 256
			if kind == "projects" {
				maximum = 128
			}
			set(maximum)
			f.success(body)
			set(maximum + 1)
			assertProjectError(t, f.request(body, 0, nil), http.StatusBadRequest, "invalid_input")
		})
	}
}

func TestWorkerConfigurationCapacityHTTPRejectsBeforeWrite(t *testing.T) {
	cases := []struct {
		name           string
		valid, invalid any
		changed        bool
		set            func(map[string]any, any)
	}{
		{"maxConcurrent", 64, 65, true, func(v map[string]any, x any) { v["maxConcurrent"] = x }},
		{"pollIntervalMs", 60000, 60001, false, func(v map[string]any, x any) { v["pollIntervalMs"] = x }},
		{"recoveryLimit", 10, 11, true, func(v map[string]any, x any) { v["recoveryLimit"] = x }},
		{"native.model", boundedUTF8(256), boundedUTF8(256) + "x", true, func(v map[string]any, x any) { v["native"].(map[string]any)["model"] = x }},
		{"native.arg", []any{boundedUTF8(4096)}, []any{boundedUTF8(4096) + "x"}, true, func(v map[string]any, x any) { v["native"].(map[string]any)["args"] = x }},
	}
	args := make([]any, 128)
	for i := range args {
		args[i] = "x"
	}
	cases = append(cases, struct {
		name           string
		valid, invalid any
		changed        bool
		set            func(map[string]any, any)
	}{"native.args", args, append(append([]any{}, args...), "x"), true, func(v map[string]any, x any) { v["native"].(map[string]any)["args"] = x }})
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newCapacityReportOperationFixture(t, uuid.NewString())
			value := configurationHTTPValue()
			tc.set(value, tc.valid)
			saved := model.WorkerConfigurationResource{Desired: &model.WorkerDesiredConfiguration{Revision: "1", Value: capacityDecode[model.WorkerConfiguration](t, value), UpdatedAt: capacityObservedAt}, ObservationRevision: "0"}
			if tc.changed {
				saved.Desired.Revision = "2"
				saved.Desired.UpdatedAt = capacityObservedAt.Add(1)
			}
			got := decodeResponse[model.WorkerConfigurationResource](t, f.putRequest(map[string]any{"revision": "1", "value": value}, 1, saved), http.StatusOK)
			if !reflect.DeepEqual(got, saved) {
				t.Fatalf("configuration boundary response differs: %+v", got)
			}
			tc.set(value, tc.invalid)
			assertProjectError(t, f.putRequest(map[string]any{"revision": saved.Desired.Revision, "value": value}, 0, model.WorkerConfigurationResource{}), http.StatusBadRequest, "invalid_input")
		})
	}
	t.Run("desired.projects", func(t *testing.T) {
		f := newCapacityReportOperationFixture(t, uuid.NewString())
		value := configurationHTTPValue()
		projects := make([]any, 129)
		for i := range projects {
			projects[i] = map[string]any{"projectId": fmt.Sprintf("%08x-0000-4000-8000-000000000001", i+1), "nativeOverrides": map[string]any{}}
		}
		value["projects"] = projects[:128]
		current := model.WorkerConfigurationResource{Desired: &model.WorkerDesiredConfiguration{Revision: "1", Value: capacityDecode[model.WorkerConfiguration](t, value), UpdatedAt: capacityObservedAt}, ObservationRevision: "0"}
		got := decodeResponse[model.WorkerConfigurationResource](t, f.putRequest(map[string]any{"revision": "1", "value": value}, 1, current), http.StatusOK)
		if !reflect.DeepEqual(got, current) {
			t.Fatal("equal configuration response changed revision or content")
		}
		value["projects"] = projects
		assertProjectError(t, f.putRequest(map[string]any{"revision": "1", "value": value}, 0, model.WorkerConfigurationResource{}), http.StatusBadRequest, "invalid_input")
	})
	t.Run("observation.items", func(t *testing.T) {
		f := newCapacityReportOperationFixture(t, uuid.NewString())
		items := make([]any, coreworker.MaxObservationItems)
		for i := range items {
			items[i] = map[string]any{"key": map[string]any{"kind": "projectPreparation", "projectId": uuid.NewString()}, "targetRevision": "1", "appliedValue": nil, "state": "pending", "error": nil, "lastFailure": nil, "nextAttemptAt": nil}
		}
		obs := map[string]any{"baseRevision": "0", "desiredRevision": "1", "items": items[:coreworker.MaxObservationItems-1]}
		body := configurationHTTPReportBody(nil, obs)
		want := configurationHTTPReceipt{ObservedAt: capacityObservedAt, LastReportedAt: capacityObservedAt, Configuration: model.WorkerConfigurationReceipt{
			Desired: &model.WorkerDesiredConfiguration{Revision: "1", Value: capacityDecode[model.WorkerConfiguration](t, configurationHTTPValue()), UpdatedAt: capacityObservedAt}, ObservationAccepted: true, ObservationRevision: "1",
		}}
		result := workerservice.WorkerReportResult{ObservedAt: capacityObservedAt, LastReportedAt: capacityObservedAt, Configuration: &want.Configuration}
		response := f.reportRequest(body, 1, result, nil, "1")
		if response.Header().Get(workerConfigurationHeader) != "1" {
			t.Fatal("configuration report lacks its protocol header")
		}
		receipt := decodeResponse[configurationHTTPReceipt](t, response, http.StatusOK)
		if !reflect.DeepEqual(receipt, want) {
			t.Fatalf("maximum item observation receipt differs: %+v", receipt)
		}
		obs["baseRevision"] = "1"
		obs["items"] = items
		assertProjectError(t, f.reportRequest(configurationHTTPReportBody(nil, obs), 0, workerservice.WorkerReportResult{}, nil, "1"), http.StatusBadRequest, "invalid_input")
	})
}
