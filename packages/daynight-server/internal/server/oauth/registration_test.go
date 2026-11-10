package oauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
)

type registrationFunc func(context.Context, string, []byte) (core.ClientMetadata, error)

func (f registrationFunc) Register(ctx context.Context, source string, body []byte) (core.ClientMetadata, error) {
	return f(ctx, source, body)
}

func TestRegistrationHTTP(t *testing.T) {
	type registrationPlan struct {
		body   string
		result core.ClientMetadata
		err    error
		done   chan struct{}
	}
	type contextKey struct{}
	plans := make(chan registrationPlan, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var plan registrationPlan
		select {
		case plan = <-plans:
		default:
			t.Error("unexpected registration request")
			http.Error(w, "unexpected request", http.StatusInternalServerError)
			return
		}
		defer close(plan.done)
		ctx := context.WithValue(r.Context(), contextKey{}, plan.done)
		calls := 0
		svc := registrationFunc(func(got context.Context, source string, body []byte) (core.ClientMetadata, error) {
			calls++
			if calls != 1 || got != ctx || source != "127.0.0.1" || !bytes.Equal(body, []byte(plan.body)) {
				t.Errorf("registration call=%d ctx=%v source=%q body=%q; want exact request context/bytes and trusted source", calls, got, source, body)
			}
			return plan.result, plan.err
		})
		Handler(svc).ServeHTTP(w, r.WithContext(ctx))
		if calls != 1 {
			t.Errorf("registration calls=%d, want 1", calls)
		}
	}))
	defer server.Close()
	client := server.Client()
	client.Timeout = 5 * time.Second
	success := core.ClientMetadata{ClientID: "generated-client", ClientName: "client", RedirectURIs: []string{"http://127.0.0.1:123/cb"}, TokenEndpointAuthMethod: "none"}
	for _, tc := range []struct {
		name, body string
		result     core.ClientMetadata
		err        error
		status     int
	}{
		{name: "registered public metadata", body: `{"client_name":"client","redirect_uris":["http://127.0.0.1:123/cb"],"logo_uri":"https://client.example/logo","software_id":"sample","extension":{"value":true}}`, result: success, status: http.StatusCreated},
		{name: "unsupported authentication", body: `{"redirect_uris":["https://client.example/callback"],"token_endpoint_auth_method":"client_secret_basic"}`, err: core.ErrInvalidClientMetadata, status: http.StatusBadRequest},
		{name: "duplicate field", body: `{"redirect_uris":["https://client.example/callback"],"redirect_uris":[]}`, err: core.ErrInvalidClientMetadata, status: http.StatusBadRequest},
		{name: "invalid UTF8", body: "{\"client_name\":\"\xff\",\"redirect_uris\":[\"https://client.example/callback\"]}", err: core.ErrInvalidClientMetadata, status: http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			done := make(chan struct{})
			plans <- registrationPlan{body: tc.body, result: tc.result, err: tc.err, done: done}
			req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, server.URL, strings.NewReader(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Content-Type", "application/json; charset=utf-8")
			req.Header.Set("Origin", "https://client.example")
			req.Header.Set("X-Forwarded-For", "203.0.113.12")
			resp, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(resp.Body)
			closeErr := resp.Body.Close()
			if err != nil || closeErr != nil {
				t.Fatal(errors.Join(err, closeErr))
			}
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("registration handler did not finish")
			}
			if resp.StatusCode != tc.status || resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("Access-Control-Allow-Origin") != "*" {
				t.Fatalf("registration response status=%d headers=%v body=%s", resp.StatusCode, resp.Header, body)
			}
			if tc.err != nil {
				var failure struct {
					Error string `json:"error"`
				}
				if err := json.Unmarshal(body, &failure); err != nil || failure.Error != "invalid_client_metadata" {
					t.Fatalf("invalid metadata response=%s error=%v", body, err)
				}
				return
			}
			var metadata core.ClientMetadata
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(body, &metadata); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(body, &fields); err != nil {
				t.Fatal(err)
			}
			want := core.ClientMetadata{ClientID: "generated-client", ClientName: "client", RedirectURIs: []string{"http://127.0.0.1:123/cb"}, TokenEndpointAuthMethod: "none"}
			if !reflect.DeepEqual(metadata, want) {
				t.Fatalf("registration metadata=%+v, want %+v", metadata, want)
			}
			for _, key := range []string{"logo_uri", "software_id", "extension", "client_secret"} {
				if _, exists := fields[key]; exists {
					t.Fatalf("unexpected registration response field %s: %s", key, body)
				}
			}
		})
	}
}

func TestRegistrationHTTPFailuresAndLimits(t *testing.T) {
	calls := 0
	var result error
	var requestContext context.Context
	expectedBody := bytes.Repeat([]byte("x"), core.MetadataLimit)
	svc := registrationFunc(func(ctx context.Context, source string, body []byte) (core.ClientMetadata, error) {
		calls++
		if ctx != requestContext || source != "198.51.100.11" || calls > 3 || !bytes.Equal(body, expectedBody) {
			t.Fatalf("unexpected registration inputs: ctx=%v source=%q calls=%d bodylength=%d", ctx, source, calls, len(body))
		}
		return core.ClientMetadata{}, result
	})
	h := Handler(svc)
	request := func(method, contentType string, size int) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/oauth/register", bytes.NewReader(bytes.Repeat([]byte("x"), size)))
		r.Header.Set("Content-Type", contentType)
		r.Header.Set("X-Forwarded-For", "203.0.113.12")
		r.RemoteAddr = "198.51.100.11:241"
		requestContext = r.Context()
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	for _, tc := range []struct {
		method, contentType string
		size, status        int
	}{
		{http.MethodGet, "application/json", 0, http.StatusMethodNotAllowed},
		{http.MethodPost, "text/plain", 0, http.StatusBadRequest},
		{http.MethodPost, "application/json; charset=ascii", 0, http.StatusBadRequest},
		{http.MethodPost, "application/json; unknown=x", 0, http.StatusBadRequest},
		{http.MethodPost, "application/json", core.MetadataLimit + 1, http.StatusRequestEntityTooLarge},
	} {
		w := request(tc.method, tc.contentType, tc.size)
		if w.Code != tc.status || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%+v: %d %v", tc, w.Code, w.Header())
		}
	}
	if calls != 0 {
		t.Fatalf("invalid requests reached service: %d", calls)
	}
	result = core.ErrRateLimited
	w := request(http.MethodPost, "application/json", core.MetadataLimit)
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") != "60" || !strings.Contains(w.Body.String(), `"slow_down"`) {
		t.Fatalf("limited: %d %v %s", w.Code, w.Header(), w.Body)
	}
	result = errors.New("secret raw client URL")
	w = request(http.MethodPost, "application/json", core.MetadataLimit)
	if w.Code != http.StatusInternalServerError || strings.Contains(w.Body.String(), "secret") {
		t.Fatalf("safe failure: %d %s", w.Code, w.Body)
	}
	result = nil
	w = request(http.MethodPost, "application/json", core.MetadataLimit)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("invalid service result: %d %s", w.Code, w.Body)
	}
	w = request(http.MethodOptions, "", 0)
	if w.Code != http.StatusNoContent || w.Header().Get("Access-Control-Allow-Methods") != "POST, OPTIONS" || w.Header().Get("Access-Control-Allow-Headers") != "Content-Type" {
		t.Fatalf("preflight: %d %v", w.Code, w.Header())
	}
	if calls != 3 {
		t.Fatalf("registration calls=%d, want 3", calls)
	}
	_, _ = io.Copy(io.Discard, w.Result().Body)
}
