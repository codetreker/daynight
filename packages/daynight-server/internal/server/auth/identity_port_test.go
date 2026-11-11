package auth

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type strictIdentity struct {
	t            *testing.T
	callback     func() string
	authenticate func(context.Context, model.CredentialKind, string) (model.Principal, error)
}

var _ identityOperations = (*strictIdentity)(nil)

func (m *strictIdentity) unexpected(name string) error {
	m.t.Helper()
	m.t.Errorf("unexpected identity operation %s", name)
	return errors.New("unexpected identity operation: " + name)
}

func (m *strictIdentity) CallbackURL() string {
	if m.callback == nil {
		m.unexpected("CallbackURL")
		return ""
	}
	return m.callback()
}
func (m *strictIdentity) Authenticate(ctx context.Context, kind model.CredentialKind, credential string) (model.Principal, error) {
	if m.authenticate == nil {
		return model.Principal{}, m.unexpected("Authenticate")
	}
	return m.authenticate(ctx, kind, credential)
}
func (m *strictIdentity) ValidateLogin(string, string) error { return m.unexpected("ValidateLogin") }
func (m *strictIdentity) StartLogin(context.Context, string, string, string) (identitycore.LoginStart, error) {
	return identitycore.LoginStart{}, m.unexpected("StartLogin")
}
func (m *strictIdentity) CompleteLogin(context.Context, url.Values, string) (identitycore.LoginCompletion, error) {
	return identitycore.LoginCompletion{}, m.unexpected("CompleteLogin")
}
func (m *strictIdentity) User(context.Context, model.Principal) (model.User, error) {
	return model.User{}, m.unexpected("User")
}
func (m *strictIdentity) Logout(context.Context, model.Principal) error {
	return m.unexpected("Logout")
}
func (m *strictIdentity) CreatePAT(context.Context, model.Principal, identitycore.CreatePAT) (identitycore.MintedPAT, error) {
	return identitycore.MintedPAT{}, m.unexpected("CreatePAT")
}
func (m *strictIdentity) ListPATs(context.Context, model.Principal) ([]model.PersonalAccessToken, error) {
	return nil, m.unexpected("ListPATs")
}
func (m *strictIdentity) RevokePAT(context.Context, model.Principal, string) error {
	return m.unexpected("RevokePAT")
}
func (m *strictIdentity) UpdatePATExpiry(context.Context, model.Principal, string, identitycore.UpdatePATExpiry) (model.PersonalAccessToken, error) {
	return model.PersonalAccessToken{}, m.unexpected("UpdatePATExpiry")
}
func (m *strictIdentity) Providers(context.Context) ([]string, error) {
	return nil, m.unexpected("Providers")
}
func (m *strictIdentity) StartDevice(context.Context, string, string) (identitycore.DeviceStart, error) {
	return identitycore.DeviceStart{}, m.unexpected("StartDevice")
}
func (m *strictIdentity) InspectDevice(context.Context, model.Principal, string) (identitycore.DeviceInspection, error) {
	return identitycore.DeviceInspection{}, m.unexpected("InspectDevice")
}
func (m *strictIdentity) DecideDevice(context.Context, model.Principal, string, string, string) error {
	return m.unexpected("DecideDevice")
}
func (m *strictIdentity) RedeemDevice(context.Context, string, string, string, string) (identitycore.MintedPAT, error) {
	return identitycore.MintedPAT{}, m.unexpected("RedeemDevice")
}
func (m *strictIdentity) LogoutDevice(context.Context, model.Principal) error {
	return m.unexpected("LogoutDevice")
}

func TestIdentityPortConstruction(t *testing.T) {
	for _, tc := range []struct {
		name, origin, callback, path, cookie string
		allow, valid                         bool
	}{
		{"https", "https://daynight.example", "https://daynight.example/custom/callback", "/custom/callback", "__Host-daynight_session", false, true},
		{"http_allowed", "http://127.0.0.1:8787", "http://127.0.0.1:8787/auth/callback", "/auth/callback", "daynight_session", true, true},
		{"http_denied", "http://127.0.0.1:8787", "http://127.0.0.1:8787/auth/callback", "", "", false, false},
		{"invalid_origin", "https://daynight.example/", "https://daynight.example/auth/callback", "", "", false, false},
		{"mismatched_callback", "https://daynight.example", "https://other.example/auth/callback", "", "", false, false},
		{"invalid_callback", "https://daynight.example", "https://daynight.example/auth/callback?bad=1", "", "", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			identity := &strictIdentity{t: t, callback: func() string { calls++; return tc.callback }}
			settings := authconfig.AuthSettings{PublicOrigin: tc.origin, AllowHTTPTestOrigin: tc.allow}
			h, err := NewAuthentication(identity, settings, slog.New(slog.NewTextHandler(io.Discard, nil)))
			if calls != 1 || (err == nil) != tc.valid {
				t.Fatalf("callback calls=%d auth=%v error=%v", calls, h, err)
			}
			if !tc.valid {
				if h != nil {
					t.Fatalf("invalid settings returned authentication: %+v", h)
				}
				return
			}
			if h.identity != identity || h.Origin() != settings.PublicOrigin || h.callbackPath != tc.path || h.SessionCookieName() != tc.cookie {
				t.Fatalf("identity=%v origin=%q callbackPath=%q cookie=%q", h.identity == identity, h.Origin(), h.callbackPath, h.SessionCookieName())
			}
		})
	}
}

func TestIdentityPortRequestBinding(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.PATCredential, model.SessionCredential} {
		for _, useRequire := range []bool{false, true} {
			t.Run(string(kind)+map[bool]string{false: "/AuthenticateRequest", true: "/Require"}[useRequire], func(t *testing.T) {
				type contextKey struct{}
				value := &struct{ marker string }{"request-value"}
				ctx, cancel := context.WithCancel(context.WithValue(context.Background(), contextKey{}, value))
				defer cancel()
				principal := model.Principal{UserID: "user-id", CredentialID: "credential-id", Kind: kind}
				const credential = "complete-credential.0123456789"
				callbackCalls, authCalls := 0, 0
				identity := &strictIdentity{t: t, callback: func() string { callbackCalls++; return "https://daynight.example/auth/callback" }}
				identity.authenticate = func(got context.Context, gotKind model.CredentialKind, gotCredential string) (model.Principal, error) {
					authCalls++
					if got != ctx || got.Value(contextKey{}) != value || gotKind != kind || gotCredential != credential {
						t.Errorf("context identity=%t value=%v kind=%q credential=%q", got == ctx, got.Value(contextKey{}), gotKind, gotCredential)
					}
					cancel()
					if !errors.Is(got.Err(), context.Canceled) {
						t.Error("request cancellation did not reach identity")
					}
					return principal, nil
				}
				h, err := NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
				if err != nil {
					t.Fatal(err)
				}
				request := httptest.NewRequest(http.MethodPost, "/protected", nil).WithContext(ctx)
				if kind == model.PATCredential {
					request.Header.Set("Authorization", "bEaReR "+credential)
				} else {
					request.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: credential})
					request.Header.Set("Origin", "https://daynight.example")
				}
				if useRequire {
					nextCalls := 0
					response := httptest.NewRecorder()
					h.Require(func(w http.ResponseWriter, r *http.Request, got model.Principal) {
						nextCalls++
						if got != principal || r.Context() != ctx {
							t.Errorf("next principal=%+v context identity=%t", got, r.Context() == ctx)
						}
						w.WriteHeader(http.StatusNoContent)
					})(response, request)
					if nextCalls != 1 || response.Code != http.StatusNoContent || response.Header().Get("Daynight-User-ID") != principal.UserID {
						t.Errorf("next calls=%d status=%d headers=%v", nextCalls, response.Code, response.Header())
					}
				} else {
					got, err := h.AuthenticateRequest(request)
					if err != nil || got != principal {
						t.Errorf("principal=%+v error=%v", got, err)
					}
				}
				if callbackCalls != 1 || authCalls != 1 {
					t.Errorf("callback calls=%d authenticate calls=%d", callbackCalls, authCalls)
				}
			})
		}
	}
}

func TestIdentityPortRefusals(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.PATCredential, model.SessionCredential} {
		t.Run(string(kind)+"/original_error", func(t *testing.T) {
			cause := errors.New("identity refusal")
			type contextKey struct{}
			value := &struct{ marker string }{"refusal"}
			ctx, cancel := context.WithCancel(context.WithValue(context.Background(), contextKey{}, value))
			defer cancel()
			calls, callbackCalls := 0, 0
			identity := &strictIdentity{t: t, callback: func() string { callbackCalls++; return "https://daynight.example/auth/callback" }, authenticate: func(got context.Context, gotKind model.CredentialKind, credential string) (model.Principal, error) {
				calls++
				if got != ctx || got.Value(contextKey{}) != value || gotKind != kind || credential != "credential" {
					t.Errorf("context identity=%t value=%v kind=%q credential=%q", got == ctx, got.Value(contextKey{}), gotKind, credential)
				}
				return model.Principal{}, cause
			}}
			h, err := NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodGet, "/protected", nil).WithContext(ctx)
			if kind == model.PATCredential {
				request.Header.Set("Authorization", "Bearer credential")
			} else {
				request.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: "credential"})
			}
			if _, got := h.AuthenticateRequest(request); got != cause || calls != 1 {
				t.Fatalf("error=%v calls=%d", got, calls)
			}
			response := httptest.NewRecorder()
			h.Require(func(http.ResponseWriter, *http.Request, model.Principal) {
				t.Error("identity refusal reached next handler")
			})(response, request)
			if calls != 2 || callbackCalls != 1 || response.Code != http.StatusInternalServerError {
				t.Errorf("calls=%d callback calls=%d status=%d", calls, callbackCalls, response.Code)
			}
		})
	}
	for _, tc := range []struct {
		name          string
		setup         func(*http.Request)
		calls, status int
	}{
		{"malformed_bearer", func(r *http.Request) { r.Header.Set("Authorization", "Basic credential") }, 0, http.StatusUnauthorized},
		{"wrong_origin", func(r *http.Request) {
			r.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: "credential"})
			r.Header.Set("Origin", "https://other.example")
		}, 1, http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			type contextKey struct{}
			value := &struct{ marker string }{"origin"}
			ctx, cancel := context.WithCancel(context.WithValue(context.Background(), contextKey{}, value))
			defer cancel()
			calls, callbackCalls := 0, 0
			identity := &strictIdentity{t: t, callback: func() string { callbackCalls++; return "https://daynight.example/auth/callback" }}
			if tc.calls != 0 {
				identity.authenticate = func(got context.Context, kind model.CredentialKind, credential string) (model.Principal, error) {
					calls++
					if got != ctx || got.Value(contextKey{}) != value || kind != model.SessionCredential || credential != "credential" {
						t.Errorf("context identity=%t value=%v kind=%q credential=%q", got == ctx, got.Value(contextKey{}), kind, credential)
					}
					return model.Principal{UserID: "user", CredentialID: "session", Kind: kind}, nil
				}
			}
			h, err := NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "/protected", nil).WithContext(ctx)
			tc.setup(request)
			response := httptest.NewRecorder()
			h.Require(func(http.ResponseWriter, *http.Request, model.Principal) {
				t.Error("rejected request reached next handler")
			})(response, request)
			if calls != tc.calls || callbackCalls != 1 || response.Code != tc.status {
				t.Errorf("calls=%d callback calls=%d status=%d", calls, callbackCalls, response.Code)
			}
		})
	}
}
