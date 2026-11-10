package identity

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	uniauth "github.com/codetreker/uniauth/sdk/go"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func providerMapping(t *testing.T, codes ...string) func([]string, string, error) ([]string, error) {
	calls := 0
	t.Cleanup(func() {
		if calls != len(codes) {
			t.Errorf("provider mappings=%d want=%d", calls, len(codes))
		}
	})
	return func(providers []string, code string, cause error) ([]string, error) {
		if calls >= len(codes) {
			t.Fatal("extra provider mapping")
		}
		want := codes[calls]
		calls++
		if code != want {
			t.Fatalf("mapping code=%q want=%q", code, want)
		}
		if cause == nil {
			return providers, nil
		}
		if providers == nil || len(providers) != 0 {
			t.Errorf("failed discovery projection=%v", providers)
		}
		return nil, &model.IdentityProviderError{Code: want, Cause: cause}
	}
}

type identityProviderTransport func(*http.Request) (*http.Response, error)

func (transport identityProviderTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestIdentityProviderDiscovery(t *testing.T) {
	var response atomic.Value
	response.Store(identityReply{status: 200, body: map[string]any{"providers": []string{"google", "github"}}})
	const callback = "http://daynight.test:8787/auth/callback"
	var calls atomic.Int32
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		app, secret, ok := request.BasicAuth()
		if request.Method != "POST" || request.URL.Path != "/auth/providers" || !ok || app != "provider-app" || secret != "provider-secret" {
			t.Error("incorrect App-aware discovery request")
		}
		var input struct {
			RedirectURI string `json:"redirect_uri"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil || input.RedirectURI != callback {
			t.Error("callback projection changed")
		}
		reply := response.Load().(identityReply)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-ID", "provider-request")
		w.WriteHeader(reply.status)
		_ = json.NewEncoder(w).Encode(reply.body)
	}))
	defer gateway.Close()
	client, err := uniauth.New(uniauth.Config{BaseURL: gateway.URL, AppID: "provider-app", AppSecret: "provider-secret", AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	identity := New(nil, client, callback)
	identity.ops.providers = providerMapping(t, "identity_unavailable", "identity_unavailable", "identity_configuration", "identity_configuration", "identity_unavailable", "identity_unavailable", "identity_unavailable")
	providers, err := identity.Providers(context.Background())
	if err != nil || !reflect.DeepEqual(providers, []string{"google", "github"}) {
		t.Fatalf("provider intersection: %v %v", providers, err)
	}
	response.Store(identityReply{status: 200, body: map[string]any{"providers": []string{}}})
	providers, err = identity.Providers(context.Background())
	if err != nil || providers == nil || len(providers) != 0 {
		t.Fatalf("empty provider intersection: %v %v", providers, err)
	}
	for _, status := range []int{400, 401, 500, 503} {
		response.Store(identityReply{status: status, body: map[string]any{"error": map[string]string{"code": "upstream_code", "message": "private-upstream-message"}}})
		_, err := identity.Providers(context.Background())
		var failure *model.IdentityProviderError
		var upstream *uniauth.APIError
		expected := "identity_unavailable"
		if status == 400 || status == 401 {
			expected = "identity_configuration"
		}
		if !errors.As(err, &failure) || failure.Code != expected || !errors.As(err, &upstream) || upstream.StatusCode != status || strings.Contains(err.Error(), "private") {
			t.Fatalf("provider error classification: %v", err)
		}
	}
	response.Store(identityReply{status: 200, body: map[string]any{"providers": nil}})
	_, err = identity.Providers(context.Background())
	var failure *model.IdentityProviderError
	var protocol *uniauth.ProtocolError
	if !errors.As(err, &failure) || failure.Code != "identity_unavailable" || !errors.As(err, &protocol) {
		t.Fatalf("invalid provider response hidden: %v", err)
	}
	if calls.Load() != 7 {
		t.Fatalf("discovery was retried: %d", calls.Load())
	}
}

func TestIdentityProviderTransportCancellation(t *testing.T) {
	cause := errors.New("private transport cause")
	client, err := uniauth.New(uniauth.Config{BaseURL: "https://uniauth.example", AppID: "provider-app", AppSecret: "provider-secret", HTTPClient: &http.Client{Transport: identityProviderTransport(func(request *http.Request) (*http.Response, error) { return nil, cause })}})
	if err != nil {
		t.Fatal(err)
	}
	identity := New(nil, client, "https://daynight.example/auth/callback")
	identity.ops.providers = providerMapping(t, "identity_unavailable")
	_, err = identity.Providers(context.Background())
	var failure *model.IdentityProviderError
	if !errors.Is(err, cause) || !errors.As(err, &failure) || failure.Code != "identity_unavailable" || strings.Contains(err.Error(), "private") {
		t.Fatalf("transport chain: %v", err)
	}
	client, err = uniauth.New(uniauth.Config{BaseURL: "https://uniauth.example", AppID: "provider-app", AppSecret: "provider-secret", HTTPClient: &http.Client{Transport: identityProviderTransport(func(request *http.Request) (*http.Response, error) {
		<-request.Context().Done()
		return nil, request.Context().Err()
	})}})
	if err != nil {
		t.Fatal(err)
	}
	identity = New(nil, client, "https://daynight.example/auth/callback")
	identity.ops.providers = providerMapping(t, "identity_timeout")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	_, err = identity.Providers(ctx)
	if !errors.Is(err, context.DeadlineExceeded) || !errors.As(err, &failure) || failure.Code != "identity_timeout" || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("deadline chain: %v", err)
	}
}
