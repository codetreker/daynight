package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"

	httpx "github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"

	uniauth "github.com/codetreker/uniauth/sdk/go"
)

type providerTestTransport func(*http.Request) (*http.Response, error)

func (transport providerTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func providerTestHandler(t *testing.T, transport providerTestTransport, output io.Writer) http.Handler {
	t.Helper()
	client, err := uniauth.New(uniauth.Config{
		BaseURL: "https://configured-auth.example", AppID: "provider-test-app", AppSecret: "provider-backend-secret",
		HTTPClient: &http.Client{Transport: transport, Timeout: time.Second},
	})
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(output, nil))
	auth, err := NewAuthentication(identityservice.New(nil, client, "https://daynight.example/auth/callback"), authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	auth.RegisterRoutes(mux)
	return httpx.RequestLogging(logger, mux)
}

func TestIdentityProvidersRejectQueryBeforeGateway(t *testing.T) {
	var calls atomic.Int32
	handler := providerTestHandler(t, func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return nil, errors.New("unexpected upstream request")
	}, io.Discard)
	for _, query := range []string{"?unexpected=value", "?provider=github&provider=google", "?unexpected=", "?%zz"} {
		response := providerRequest(handler, http.MethodGet, "/api/v1/auth/providers"+query, "")
		testsupport.AssertProjectError(t, response, http.StatusBadRequest, "invalid_input")
		if response.Header().Get("Cache-Control") != "no-store" || len(response.Result().Cookies()) != 0 {
			t.Fatal("invalid provider queries must remain uncached and must not create credentials")
		}
	}
	if calls.Load() != 0 {
		t.Fatal("invalid provider queries reached the gateway")
	}
}

func TestIdentityProvidersHTTPOutcomesAndSafeDiagnostics(t *testing.T) {
	for _, item := range []struct {
		name       string
		upstream   int
		body       string
		failure    error
		status     int
		code, kind string
		providers  []string
	}{
		{name: "available", upstream: 200, body: `{"providers":["github","google"]}`, status: 200, providers: []string{"github", "google"}},
		{name: "empty_intersection", upstream: 200, body: `{"providers":[]}`, status: 200, providers: []string{}},
		{name: "invalid_app", upstream: 401, body: `{"error":{"code":"invalid_app","message":"private-provider-detail"}}`, status: 503, code: "identity_configuration", kind: "protocol"},
		{name: "unregistered_callback", upstream: 400, body: `{"error":{"code":"invalid_request","message":"private-provider-detail"}}`, status: 503, code: "identity_configuration", kind: "protocol"},
		{name: "upstream_failure", upstream: 503, body: `{"error":{"code":"service_unavailable","message":"private-provider-detail"}}`, status: 502, code: "identity_unavailable", kind: "protocol"},
		{name: "malformed_provider_payload", upstream: 200, body: `{"providers":"private-provider-detail"}`, status: 502, code: "identity_unavailable", kind: "protocol"},
		{name: "network", failure: &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("private-provider-transport")}, status: 502, code: "identity_unavailable", kind: "network"},
		{name: "timeout", failure: context.DeadlineExceeded, status: 504, code: "identity_timeout", kind: "deadline"},
	} {
		t.Run(item.name, func(t *testing.T) {
			var logs bytes.Buffer
			var calls atomic.Int32
			handler := providerTestHandler(t, func(request *http.Request) (*http.Response, error) {
				calls.Add(1)
				appID, secret, authenticated := request.BasicAuth()
				if request.Method != http.MethodPost || request.URL.String() != "https://configured-auth.example/auth/providers" || !authenticated || appID != "provider-test-app" || secret != "provider-backend-secret" || request.Header.Get("Content-Type") != "application/json" {
					t.Error("provider discovery did not use the configured SDK endpoint and App credentials")
				}
				var body struct {
					RedirectURI string `json:"redirect_uri"`
				}
				if err := json.NewDecoder(request.Body).Decode(&body); err != nil || body.RedirectURI != "https://daynight.example/auth/callback" {
					t.Error("provider discovery did not use its exact configured callback")
				}
				if item.failure != nil {
					return nil, item.failure
				}
				header := make(http.Header)
				header.Set("Content-Type", "application/json")
				header.Set("X-Request-ID", "upstream-providers-request")
				return &http.Response{StatusCode: item.upstream, Header: header, Body: io.NopCloser(strings.NewReader(item.body)), Request: request}, nil
			}, &logs)
			response := providerRequest(handler, http.MethodGet, "/api/v1/auth/providers", "")
			if calls.Load() != 1 || response.Code != item.status || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("X-Request-ID") != "project-test" || len(response.Result().Cookies()) != 0 {
				t.Fatalf("provider outcome changed: status=%d calls=%d", response.Code, calls.Load())
			}
			if item.code == "" {
				var result struct {
					Providers []string `json:"providers"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || !reflect.DeepEqual(result.Providers, item.providers) {
					t.Fatal("provider result changed or an empty intersection became a failure")
				}
			} else {
				result := testsupport.DecodeResponse[api.ErrorResponse](t, response, item.status)
				if result.Error.Code != item.code || result.Error.RequestID != "project-test" || !strings.Contains(logs.String(), `"cause":"`+item.kind+`"`) || !strings.Contains(logs.String(), `"error_code":"`+item.code+`"`) {
					t.Fatal("provider failure lost its safe category or request correlation")
				}
				if item.failure == nil && !strings.Contains(logs.String(), `"upstream_request_id":"upstream-providers-request"`) {
					t.Fatal("provider HTTP failure lost its upstream request ID")
				}
			}
			for _, secret := range []string{"provider-backend-secret", "private-provider-detail", "private-provider-transport"} {
				if strings.Contains(response.Body.String(), secret) || strings.Contains(logs.String(), secret) {
					t.Fatal("provider discovery exposed a backend credential or upstream diagnostic")
				}
			}
		})
	}
}

func providerRequest(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json; charset=UTF-8")
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
