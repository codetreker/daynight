package worker

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/cors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

const workerBrowserOrigin = "https://application.example"
const corsWorkerID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

func workerCORSHTTP(t *testing.T, operations *capacityReportOperations) (http.Handler, *int) {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	calls := new(int)
	auth, err := authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		*calls++
		if kind != model.PATCredential || token != "worker-cors-token" || ctx.Err() != nil {
			t.Fatalf("authentication input: %s %s %v", kind, token, ctx.Err())
		}
		return defaultHTTPPrincipal(), nil
	}, authconfig.AuthSettings{PublicOrigin: workerTestOrigin}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, operations, &authhttp.Authentication{RequestAuthentication: auth}, logger)
	return httpx.RequestLogging(logger, cors.Wrap(mux, mux, workerBrowserOrigin, logger)), calls
}

func workerBrowserRequest(t *testing.T, handler http.Handler, method, path, body string, headers http.Header) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header = headers.Clone()
	r.Header.Set("Origin", workerBrowserOrigin)
	if method != http.MethodOptions {
		r.Header.Set("Authorization", "Bearer worker-cors-token")
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func assertWorkerBrowserResponse(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	if w.Header().Get("Access-Control-Allow-Origin") != workerBrowserOrigin || w.Header().Get("Access-Control-Allow-Credentials") != "" {
		t.Fatalf("CORS headers: %v", w.Header())
	}
	for _, name := range []string{"Daynight-User-ID", "Daynight-Worker-Configuration", "Daynight-Worker-Control-Mode", "Daynight-Worker-Tool-Paths"} {
		if !strings.Contains(w.Header().Get("Access-Control-Expose-Headers"), name) {
			t.Fatalf("missing exposed Worker header %s", name)
		}
	}
}

func TestWorkerCORSConfigurationReportsPreserveProtocol(t *testing.T) {
	for _, version := range []string{"1", "2"} {
		t.Run("protocol="+version, func(t *testing.T) {
			operations := &capacityReportOperations{t: t}
			handler, authCalls := workerCORSHTTP(t, operations)
			path := "/api/v1/me/workers/" + corsWorkerID + "/report"
			headers := http.Header{}
			headers.Set("daynight-worker-configuration", version)
			headers.Set("daynight-worker-protocol", "1")
			headers.Set("daynight-worker-control-mode", "1")
			headers.Set("daynight-worker-tool-paths", "1")
			if version == "2" {
				headers.Set("daynight-worker-prompts", "[]")
			}
			names := []string{"Authorization", "Content-Type"}
			for name := range headers {
				names = append(names, name)
			}
			preflight := workerBrowserRequest(t, handler, "OPTIONS", path, "", http.Header{"Access-Control-Request-Method": {"POST"}, "Access-Control-Request-Headers": {strings.ToLower(strings.Join(names, ", "))}})
			if preflight.Code != 204 || *authCalls != 0 {
				t.Fatalf("Worker preflight: %d auth=%d %s", preflight.Code, *authCalls, preflight.Body.String())
			}
			assertWorkerBrowserResponse(t, preflight)
			body := configurationHTTPReportBody(nil, nil)
			body["configuration"].(map[string]any)["controlModeBootstrap"] = "web"
			body["configuration"].(map[string]any)["toolPathsBootstrap"] = map[string]any{"codex": map[string]any{"kind": "auto"}, "copilot": map[string]any{"kind": "auto"}, "herdr": map[string]any{"kind": "auto"}}
			body["toolPaths"] = map[string]any{"schemaVersion": 1, "observedAt": "2026-11-08T00:00:00Z", "entries": []any{}}
			businessCalls := 0
			result := workerservice.WorkerReportResult{ObservedAt: capacityObservedAt, LastReportedAt: capacityObservedAt, Configuration: &model.WorkerConfigurationReceipt{ObservationRevision: "7"}}
			check := func(ctx context.Context, p model.Principal, id string, in model.WorkerReport) {
				businessCalls++
				if ctx.Err() != nil || p != defaultHTTPPrincipal() || id != corsWorkerID || in.Configuration == nil || in.Configuration.ControlModeBootstrap == nil || *in.Configuration.ControlModeBootstrap != "web" || in.Configuration.ToolPathsBootstrap == nil || in.Telemetry.ToolPaths == nil {
					t.Fatalf("Worker protocol arguments changed: %+v", in)
				}
			}
			operations.report = func(ctx context.Context, p model.Principal, id string, in model.WorkerReport) (workerservice.WorkerReportResult, error) {
				if version != "1" {
					t.Fatal("protocol 2 used protocol 1 operation")
				}
				check(ctx, p, id, in)
				return result, nil
			}
			operations.sync = func(ctx context.Context, p model.Principal, id string, in model.WorkerReport, selectors []model.PromptSelector) (workerservice.ConfigurationSyncResult, error) {
				if version != "2" || selectors == nil || len(selectors) != 0 {
					t.Fatalf("protocol 2 selectors: %+v", selectors)
				}
				check(ctx, p, id, in)
				return workerservice.ConfigurationSyncResult{Native: result, Prompts: []model.PromptResult{}}, nil
			}
			w := workerBrowserRequest(t, handler, "POST", path, jsonBody(t, body), headers)
			if w.Code != 200 || businessCalls != 1 || *authCalls != 1 {
				t.Fatalf("Worker report: %d business=%d auth=%d %s", w.Code, businessCalls, *authCalls, w.Body.String())
			}
			assertWorkerBrowserResponse(t, w)
			for name, value := range map[string]string{"Daynight-Worker-Configuration": version, "Daynight-Worker-Control-Mode": "1", "Daynight-Worker-Tool-Paths": "1", "Daynight-User-ID": defaultHTTPPrincipal().UserID} {
				if w.Header().Get(name) != value {
					t.Fatalf("Worker response %s=%s", name, w.Header().Get(name))
				}
			}
			if !strings.Contains(w.Body.String(), `"observationRevision":"7"`) {
				t.Fatalf("Worker configuration receipt lost: %s", w.Body.String())
			}
		})
	}
}

func TestWorkerCORSDoesNotRelaxHeaderParsers(t *testing.T) {
	for _, tc := range []struct {
		name    string
		headers http.Header
	}{
		{"duplicate configuration version", http.Header{workerConfigurationHeader: {"1", "1"}}},
		{"prompts on protocol 1", http.Header{workerConfigurationHeader: {"1"}, workerPromptsHeader: {"[]"}}},
		{"duplicate prompts", http.Header{workerConfigurationHeader: {"2"}, workerPromptsHeader: {"[]", "[]"}}},
		{"oversized prompts", http.Header{workerConfigurationHeader: {"2"}, workerPromptsHeader: {strings.Repeat(" ", 1025)}}},
		{"duplicate tool paths", http.Header{workerConfigurationHeader: {"2"}, workerPromptsHeader: {"[]"}, workerToolPathsHeader: {"1", "1"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			operations := &capacityReportOperations{t: t}
			handler, authCalls := workerCORSHTTP(t, operations)
			w := workerBrowserRequest(t, handler, "POST", "/api/v1/me/workers/"+corsWorkerID+"/report", jsonBody(t, configurationHTTPReportBody(nil, nil)), tc.headers)
			if w.Code != 400 || *authCalls != 1 || !strings.Contains(w.Body.String(), `"code":"invalid_input"`) {
				t.Fatalf("original header parser: %d auth=%d %s", w.Code, *authCalls, w.Body.String())
			}
			assertWorkerBrowserResponse(t, w)
		})
	}
}
