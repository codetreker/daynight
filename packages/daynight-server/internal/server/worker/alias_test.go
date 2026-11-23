package worker

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

func aliasResourceRequest(t *testing.T, f *capacityReportOperationFixture, method, suffix, body string, headers http.Header) *httptest.ResponseRecorder {
	if headers == nil {
		headers = http.Header{}
	}
	headers.Set("X-Request-ID", "project-test")
	return controlModeRequest(t, f, method, suffix, body, headers)
}

func TestWorkerAliasHTTPResource(t *testing.T) {
	const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	for _, value := range []*string{nil, new(" 开发 👩‍💻 ")} {
		f := newCapacityReportOperationFixture(t, id)
		calls := 0
		f.operations.putAlias = func(ctx context.Context, principal model.Principal, worker, version string, actual *string) (model.WorkerAlias, error) {
			calls++
			if ctx != f.requestContext || principal != f.handler.principal || worker != id || version != "9223372036854775806" || !reflect.DeepEqual(actual, value) {
				t.Fatalf("PUT arguments: %s %s %v", worker, version, actual)
			}
			return model.WorkerAlias{Value: new("开发 👩‍💻"), Version: 9223372036854775807}, nil
		}
		body, err := json.Marshal(map[string]any{"value": value, "expectedVersion": "9223372036854775806"})
		if err != nil {
			t.Fatal(err)
		}
		response := aliasResourceRequest(t, f, "PUT", "/alias", string(body), nil)
		want := `{"workerId":"` + id + `","alias":{"value":"开发 👩‍💻","version":"9223372036854775807"}}` + "\n"
		if response.Code != 200 || response.Body.String() != want || response.Header().Get(workerAliasHeader) != "1" || calls != 1 {
			t.Fatalf("PUT: %d %s %v calls=%d", response.Code, response.Body, response.Header(), calls)
		}
		f.operations.alias = func(ctx context.Context, principal model.Principal, worker string) (model.WorkerAlias, error) {
			calls++
			if ctx != f.requestContext || principal != f.handler.principal || worker != id {
				t.Fatal("GET arguments changed")
			}
			return model.WorkerAlias{Version: 1}, nil
		}
		response = aliasResourceRequest(t, f, "GET", "/alias", "", nil)
		if response.Code != 200 || response.Body.String() != `{"workerId":"`+id+`","alias":{"value":null,"version":"1"}}`+"\n" || calls != 2 {
			t.Fatalf("GET: %d %s calls=%d", response.Code, response.Body, calls)
		}
	}
}

func TestWorkerAliasHTTPRejectsProtocolWithoutOperations(t *testing.T) {
	for _, tc := range []struct {
		name, method, suffix, body string
		headers                    http.Header
		status                     int
		code                       string
	}{
		{name: "unknown", method: "PUT", suffix: "/alias", body: `{"value":null,"expectedVersion":"1","userId":"owner"}`},
		{name: "duplicate", method: "PUT", suffix: "/alias", body: `{"value":null,"value":"x","expectedVersion":"1"}`},
		{name: "missing value", method: "PUT", suffix: "/alias", body: `{"expectedVersion":"1"}`},
		{name: "missing version", method: "PUT", suffix: "/alias", body: `{"value":null}`},
		{name: "numeric version", method: "PUT", suffix: "/alias", body: `{"value":null,"expectedVersion":1}`},
		{name: "null version", method: "PUT", suffix: "/alias", body: `{"value":null,"expectedVersion":null}`},
		{name: "nonstring value", method: "PUT", suffix: "/alias", body: `{"value":5,"expectedVersion":"1"}`},
		{name: "surrogate", method: "PUT", suffix: "/alias", body: `{"value":"\ud800","expectedVersion":"1"}`},
		{name: "low surrogate", method: "PUT", suffix: "/alias", body: `{"value":"\udfff","expectedVersion":"1"}`},
		{name: "invalid UTF8", method: "PUT", suffix: "/alias", body: "{\"value\":\"\xff\",\"expectedVersion\":\"1\"}"},
		{name: "query", method: "GET", suffix: "/alias?owner=x"},
		{name: "empty query", method: "GET", suffix: "/alias?"},
		{name: "bad protocol", method: "GET", suffix: "/alias", headers: http.Header{workerAliasHeader: {"2"}}},
		{name: "repeated protocol", method: "GET", suffix: "/alias", headers: http.Header{workerAliasHeader: {"1", "1"}}},
		{name: "wrong method", method: "POST", suffix: "/alias", status: 405, code: "method_not_allowed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
			got := aliasResourceRequest(t, f, tc.method, tc.suffix, tc.body, tc.headers)
			status, code := tc.status, tc.code
			if status == 0 {
				status, code = 400, "invalid_input"
			}
			assertProjectError(t, got, status, code)
		})
	}
}

func TestWorkerAliasHTTPDomainErrors(t *testing.T) {
	for _, tc := range []struct {
		code   string
		status int
	}{
		{"not_found", 404}, {"version_conflict", 409}, {"invalid_input", 400},
		{"write_outcome_unknown", 503},
	} {
		t.Run(tc.code, func(t *testing.T) {
			f := newCapacityReportOperationFixture(t, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
			calls := 0
			f.operations.putAlias = func(context.Context, model.Principal, string, string, *string) (model.WorkerAlias, error) {
				calls++
				return model.WorkerAlias{}, &model.Fault{Code: tc.code, Message: "Operation refused."}
			}
			response := aliasResourceRequest(t, f, "PUT", "/alias", `{"value":null,"expectedVersion":"1"}`, nil)
			assertProjectError(t, response, tc.status, tc.code)
			if calls != 1 {
				t.Fatalf("operation calls=%d", calls)
			}
		})
	}
}

func aliasReadRequest(f *capacityReportOperationFixture, path string, headers http.Header) *httptest.ResponseRecorder {
	f.authCalls = 0
	r := httptest.NewRequest("GET", path, nil)
	authorizeResourceRequest(f.handler, r)
	r.Header.Set(workerToolPathsHeader, "2")
	r.Header.Set("X-Request-ID", "project-test")
	for name, values := range headers {
		r.Header[name] = values
	}
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	return w
}

func TestWorkerAliasHTTPReadNegotiation(t *testing.T) {
	const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	for _, detail := range []bool{false, true} {
		for _, negotiated := range []bool{false, true} {
			t.Run(stringBool(detail)+"/"+stringBool(negotiated), func(t *testing.T) {
				f := newCapacityReportOperationFixture(t, id)
				calls := 0
				alias := model.WorkerAlias{Value: new("开发"), Version: 3}
				path := "/api/v1/me/workers"
				if detail {
					path += "/" + id
					f.operations.get = func(context.Context, model.Principal, string) (workerservice.WorkerDetailResult, error) {
						calls++
						return workerservice.WorkerDetailResult{ObservedAt: capacityObservedAt, Worker: model.WorkerSnapshot{WorkerID: id, Alias: alias}}, nil
					}
				} else {
					f.operations.list = func(context.Context, model.Principal, model.PageRequest) (workerservice.WorkerPage, error) {
						calls++
						return workerservice.WorkerPage{ObservedAt: capacityObservedAt, Items: []workerprotocol.WorkerSummary{{WorkerID: id}}, Aliases: []model.WorkerAlias{alias}}, nil
					}
				}
				headers := http.Header{}
				if negotiated {
					headers.Set(workerAliasHeader, "1")
				}
				w := aliasReadRequest(f, path, headers)
				if w.Code != 200 || calls != 1 || strings.Contains(w.Body.String(), `"alias":`) != negotiated || (w.Header().Get(workerAliasHeader) == "1") != negotiated {
					t.Fatalf("read: %d %s %v calls=%d", w.Code, w.Body, w.Header(), calls)
				}
				if negotiated && !strings.Contains(w.Body.String(), `"alias":{"value":"开发","version":"3"}`) {
					t.Fatalf("alias projection changed: %s", w.Body)
				}
			})
		}
	}
	for _, path := range []string{"/api/v1/me/workers", "/api/v1/me/workers/" + id} {
		for _, values := range [][]string{{""}, {"0"}, {"1, 1"}, {"1", "1"}, {" 1 "}} {
			f := newCapacityReportOperationFixture(t, id)
			assertProjectError(t, aliasReadRequest(f, path, http.Header{workerAliasHeader: values}), 400, "invalid_input")
		}
	}
}

func stringBool(value bool) string {
	if value {
		return "true"
	}
	return "false"
}

func TestWorkerAliasCORSNegotiation(t *testing.T) {
	operations := &capacityReportOperations{t: t}
	handler, authCalls := workerCORSHTTP(t, operations)
	path := "/api/v1/me/workers/" + corsWorkerID + "/alias"
	preflight := workerBrowserRequest(t, handler, "OPTIONS", path, "", http.Header{
		"Access-Control-Request-Method":  {"PUT"},
		"Access-Control-Request-Headers": {"authorization, content-type, daynight-worker-alias"},
	})
	if preflight.Code != 204 || *authCalls != 0 || !strings.Contains(preflight.Header().Get("Access-Control-Allow-Headers"), workerAliasHeader) {
		t.Fatalf("alias preflight: %d %v calls=%d", preflight.Code, preflight.Header(), *authCalls)
	}
	calls := 0
	operations.putAlias = func(_ context.Context, p model.Principal, worker, expected string, value *string) (model.WorkerAlias, error) {
		calls++
		if p != defaultHTTPPrincipal() || worker != corsWorkerID || expected != "1" || value == nil || *value != "Build" {
			t.Fatal("browser alias arguments changed")
		}
		return model.WorkerAlias{Value: new("Build"), Version: 2}, nil
	}
	response := workerBrowserRequest(t, handler, "PUT", path, `{"value":"Build","expectedVersion":"1"}`, http.Header{workerAliasHeader: {"1"}})
	if response.Code != 200 || calls != 1 || *authCalls != 1 || response.Header().Get(workerAliasHeader) != "1" || !strings.Contains(response.Header().Get("Access-Control-Expose-Headers"), workerAliasHeader) {
		t.Fatalf("alias browser response: %d %v calls=%d auth=%d", response.Code, response.Header(), calls, *authCalls)
	}
	assertWorkerBrowserResponse(t, response)
}
