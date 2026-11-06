package oauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
)

type registrationFunc func(context.Context, string, []byte) (core.ClientMetadata, error)

func (f registrationFunc) Register(ctx context.Context, source string, body []byte) (core.ClientMetadata, error) {
	return f(ctx, source, body)
}

func TestRegistrationHTTP(t *testing.T) {
	var mu sync.Mutex
	var sources []string
	svc := registrationFunc(func(_ context.Context, source string, body []byte) (core.ClientMetadata, error) {
		mu.Lock()
		sources = append(sources, source)
		mu.Unlock()
		m, err := core.ParseClientMetadata(body, "")
		if err != nil {
			return m, err
		}
		m.ClientID = "generated-client"
		return m, nil
	})
	server := httptest.NewServer(Handler(svc))
	defer server.Close()
	client := server.Client()
	body := `{"client_name":"App","redirect_uris":["https://client.example/callback"]}`
	req, _ := http.NewRequest(http.MethodPost, server.URL, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("Origin", "https://client.example")
	req.Header.Set("X-Forwarded-For", "203.0.113.12")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var response map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusCreated || response["client_id"] != "generated-client" || response["token_endpoint_auth_method"] != "none" || response["client_secret"] != nil || len(response["redirect_uris"].([]any)) != 1 {
		t.Fatalf("registration: status=%d body=%v", resp.StatusCode, response)
	}
	if resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("headers: %v", resp.Header)
	}
	mu.Lock()
	if len(sources) != 1 || sources[0] != "127.0.0.1" {
		t.Fatalf("trusted source: %v", sources)
	}
	mu.Unlock()

	for _, invalid := range []string{
		`{"redirect_uris":["https://client.example/callback"],"token_endpoint_auth_method":"client_secret_basic"}`,
		`{"redirect_uris":["https://client.example/callback"],"redirect_uris":[]}`,
		"{\"client_name\":\"\xff\",\"redirect_uris\":[\"https://client.example/callback\"]}",
	} {
		r, _ := http.NewRequest(http.MethodPost, server.URL, strings.NewReader(invalid))
		r.Header.Set("Content-Type", "application/json")
		got, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		var failure struct {
			Error string `json:"error"`
		}
		err = json.NewDecoder(got.Body).Decode(&failure)
		got.Body.Close()
		if err != nil || got.StatusCode != http.StatusBadRequest || failure.Error != "invalid_client_metadata" {
			t.Fatalf("invalid metadata: status=%d response=%+v err=%v", got.StatusCode, failure, err)
		}
	}
}

func TestRegistrationHTTPFailuresAndLimits(t *testing.T) {
	calls := 0
	var result error
	svc := registrationFunc(func(_ context.Context, _ string, body []byte) (core.ClientMetadata, error) {
		calls++
		if len(body) != core.MetadataLimit {
			t.Fatalf("body length=%d", len(body))
		}
		return core.ClientMetadata{}, result
	})
	h := Handler(svc)
	request := func(method, contentType string, size int) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "/oauth/register", bytes.NewReader(bytes.Repeat([]byte("x"), size)))
		r.Header.Set("Content-Type", contentType)
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
		{http.MethodPost, "application/json", core.MetadataLimit + 1, http.StatusBadRequest},
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
	_, _ = io.Copy(io.Discard, w.Result().Body)
}
