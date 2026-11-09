package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func TestRequestAuthenticationConfiguration(t *testing.T) {
	for _, test := range []struct {
		name, origin, cookie string
		allowHTTP, accepted  bool
	}{
		{"https", "https://example.com", "__Host-daynight_session", false, true},
		{"test_http", "http://127.0.0.1:8080", "daynight_session", true, true},
		{"http_requires_opt_in", "http://127.0.0.1:8080", "", false, false},
		{"path", "https://example.com/path", "", false, false},
		{"query", "https://example.com?x=y", "", false, false},
		{"credentials", "https://private:secret@example.com", "", false, false},
		{"host_case", "https://EXAMPLE.com", "", false, false},
		{"default_port", "https://example.com:443", "", false, false},
		{"invalid_url", "https://bad%host", "", false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			h, err := NewRequestAuthentication(func(context.Context, model.CredentialKind, string) (model.Principal, error) {
				t.Fatal("configuration invoked a credential operation")
				return model.Principal{}, nil
			}, config.AuthSettings{PublicOrigin: test.origin, AllowHTTPTestOrigin: test.allowHTTP}, slog.Default())
			if (err == nil) != test.accepted {
				t.Fatalf("accepted=%t err=%v", test.accepted, err)
			}
			if test.accepted && (h.Origin() != test.origin || h.SessionCookieName() != test.cookie) {
				t.Fatalf("origin=%q cookie=%q", h.Origin(), h.SessionCookieName())
			}
		})
	}
}

func TestRequestAuthenticationProtocolAndIdentity(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.PATCredential, model.SessionCredential} {
		t.Run(string(kind), func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			type contextKey struct{}
			contextValue := &struct{}{}
			calls := 0
			principal := model.Principal{UserID: "user-identity", CredentialID: "credential-identity", Kind: kind}
			h, err := NewRequestAuthentication(func(ctx context.Context, actualKind model.CredentialKind, secret string) (model.Principal, error) {
				calls++
				if actualKind != kind || secret != "credential-secret" || ctx.Value(contextKey{}) != contextValue {
					t.Fatalf("credential input: kind=%s secret=%q context=%v", actualKind, secret, ctx.Value(contextKey{}))
				}
				return principal, nil
			}, config.AuthSettings{PublicOrigin: "https://example.com"}, logger)
			if err != nil {
				t.Fatal(err)
			}
			nextCalls := 0
			handler := httpx.RequestLogging(logger, h.Require(func(w http.ResponseWriter, r *http.Request, actual model.Principal) {
				nextCalls++
				if actual != principal || r.Context().Value(contextKey{}) != contextValue {
					t.Fatalf("principal/context changed: %+v", actual)
				}
				w.WriteHeader(http.StatusNoContent)
			}))
			request := httptest.NewRequest(http.MethodPost, "https://example.com/protected", nil)
			request = request.WithContext(context.WithValue(request.Context(), contextKey{}, contextValue))
			request.Header.Set("X-Request-ID", "auth-request")
			if kind == model.PATCredential {
				request.Header.Set("Authorization", "bEaReR credential-secret")
			} else {
				request.AddCookie(&http.Cookie{Name: h.SessionCookieName(), Value: "credential-secret"})
				request.Header.Set("Origin", h.Origin())
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusNoContent || calls != 1 || nextCalls != 1 || response.Header().Get("Daynight-User-ID") != principal.UserID || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("X-Request-ID") != "auth-request" {
				t.Fatalf("status=%d calls=%d next=%d headers=%v", response.Code, calls, nextCalls, response.Header())
			}
			if strings.Contains(logs.String(), "credential-secret") || !strings.Contains(logs.String(), `"credential_id":"credential-identity"`) || !strings.Contains(logs.String(), `"user_id":"user-identity"`) {
				t.Fatalf("credential log lost attribution or leaked a secret: %s", &logs)
			}
		})
	}
}

func TestRequestAuthenticationRejectsMalformedCredentialsBeforeCallingIdentity(t *testing.T) {
	for _, test := range []struct {
		name          string
		authorization []string
		cookies       []string
	}{
		{"missing", nil, nil},
		{"wrong_scheme", []string{"Basic secret"}, nil},
		{"missing_bearer", []string{"Bearer"}, nil},
		{"extra_bearer_field", []string{"Bearer private extra"}, nil},
		{"duplicate_authorization", []string{"Bearer private", "Bearer second"}, nil},
		{"duplicate_session", nil, []string{"private", "second"}},
		{"insecure_cookie_on_https", nil, []string{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			h, err := NewRequestAuthentication(func(context.Context, model.CredentialKind, string) (model.Principal, error) {
				t.Fatal("malformed credentials reached identity")
				return model.Principal{}, nil
			}, config.AuthSettings{PublicOrigin: "https://example.com"}, logger)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodGet, "/protected", nil)
			if test.authorization != nil {
				request.Header["Authorization"] = test.authorization
			}
			for _, value := range test.cookies {
				request.AddCookie(&http.Cookie{Name: h.SessionCookieName(), Value: value})
			}
			if test.name == "insecure_cookie_on_https" {
				request.AddCookie(&http.Cookie{Name: "daynight_session", Value: "private"})
			}
			response := httptest.NewRecorder()
			h.Require(func(http.ResponseWriter, *http.Request, model.Principal) { t.Fatal("rejected request reached handler") })(response, request)
			var failure api.ErrorResponse
			if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil || response.Code != http.StatusUnauthorized || failure.Error.Code != "unauthenticated" || response.Header().Get("Daynight-User-ID") != "" || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("status=%d failure=%+v err=%v", response.Code, failure, err)
			}
			if strings.Contains(logs.String(), "private") || strings.Contains(response.Body.String(), "private") {
				t.Fatal("credential refusal leaked its secret")
			}
		})
	}
}

func TestRequestAuthenticationCookieWriteOrigin(t *testing.T) {
	for _, test := range []struct {
		name, method string
		origins      []string
		accepted     bool
	}{
		{"read_without_origin", http.MethodGet, nil, true},
		{"head_without_origin", http.MethodHead, nil, true},
		{"options_without_origin", http.MethodOptions, nil, true},
		{"exact_origin", http.MethodPost, []string{"https://example.com"}, true},
		{"missing_origin", http.MethodPost, nil, false},
		{"different_origin", http.MethodPost, []string{"https://other.example"}, false},
		{"duplicate_origin", http.MethodPost, []string{"https://example.com", "https://example.com"}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			h, err := NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, secret string) (model.Principal, error) {
				calls++
				if kind != model.SessionCredential || secret != "cookie-secret" {
					t.Fatalf("credential kind=%s secret=%q", kind, secret)
				}
				return model.Principal{UserID: "user", Kind: kind}, nil
			}, config.AuthSettings{PublicOrigin: "https://example.com"}, slog.Default())
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(test.method, "/protected", nil)
			request.AddCookie(&http.Cookie{Name: h.SessionCookieName(), Value: "cookie-secret"})
			request.Header["Origin"] = test.origins
			principal, err := h.AuthenticateRequest(request)
			var fault *model.Fault
			if calls != 1 || (err == nil) != test.accepted || test.accepted && principal.UserID != "user" || !test.accepted && (!errors.As(err, &fault) || fault.Code != "forbidden") {
				t.Fatalf("accepted=%t calls=%d principal=%+v err=%v", test.accepted, calls, principal, err)
			}
		})
	}
}

func TestRequestAuthenticationPreservesIdentityFailure(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.PATCredential, model.SessionCredential} {
		t.Run(string(kind), func(t *testing.T) {
			cause := errors.New("identity failure sentinel")
			h, err := NewRequestAuthentication(func(context.Context, model.CredentialKind, string) (model.Principal, error) {
				return model.Principal{}, cause
			}, config.AuthSettings{PublicOrigin: "https://example.com"}, slog.Default())
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodGet, "/protected", nil)
			if kind == model.PATCredential {
				request.Header.Set("Authorization", "Bearer secret")
			} else {
				request.AddCookie(&http.Cookie{Name: h.SessionCookieName(), Value: "secret"})
			}
			if _, err := h.AuthenticateRequest(request); err != cause {
				t.Fatalf("identity error changed: %v", err)
			}
		})
	}
}
