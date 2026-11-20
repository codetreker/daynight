package auth

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
)

type scopedProfileAuth struct{ value model.CredentialAuthorization }

func (a *scopedProfileAuth) RequireScoped(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { next(w, r, a.value) }
}

type scopedProfileFixture struct {
	calls   int
	got     model.CredentialAuthorization
	checked bool
}

func (p *scopedProfileFixture) PatchUserAuthorized(ctx context.Context, auth model.CredentialAuthorization, patch model.UserProfilePatch, recheck identityservice.ProfileScopeRecheck) (model.User, error) {
	p.calls++
	p.got = auth
	if !patch.Name.Present {
		panic("name missing")
	}
	if err := scopeadmission.Require(auth, scopepolicy.AccountWrite); err != nil {
		return model.User{}, err
	}
	current, err := recheck(ctx, nil, auth.Principal)
	if err != nil {
		return model.User{}, err
	}
	p.checked = current.Principal == auth.Principal
	return model.User{ID: auth.Principal.UserID}, nil
}
func TestScopedProfileHTTPAssembly(t *testing.T) {
	const id = "11111111-1111-4111-8111-111111111111"
	const credential = "22222222-2222-4222-8222-222222222222"
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"prompt:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	a := &scopedProfileAuth{value: model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: id, CredentialID: credential}, Profile: model.ScopedPATProfile, Policy: &policy}}
	p := &scopedProfileFixture{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := &Authentication{RequestAuthentication: &RequestAuthentication{logger: logger}, callbackPath: "/auth/callback"}
	mux := http.NewServeMux()
	check := func(_ context.Context, _ store.IdentityScope, principal model.Principal) (model.CredentialAuthorization, error) {
		if principal != a.value.Principal {
			t.Fatal("incorrect recheck principal")
		}
		return a.value, nil
	}
	h.RegisterScopedRoutes(mux, a, p, check, nil)
	request := func(body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("PATCH", "/api/v1/me", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	w := request(`{"name":"Alice"}`)
	if w.Code != 403 || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || p.calls != 1 || p.checked {
		t.Fatalf("denial %d %v %s", w.Code, w.Header(), w.Body)
	}
	policy, err = scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"account:write"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	a.value.Policy = &policy
	w = request(`{"name":"Alice"}`)
	if w.Code != 200 || p.calls != 2 || !p.checked || p.got.Policy != a.value.Policy {
		t.Fatalf("success %d %v %s", w.Code, w.Header(), w.Body)
	}
	w = request(`{"name":42}`)
	if w.Code != 400 || p.calls != 2 {
		t.Fatalf("invalid input: %d calls %d", w.Code, p.calls)
	}
}

type scopedProfileRequestAuthentication struct {
	request *RequestAuthentication
	value   model.CredentialAuthorization
}

func (a scopedProfileRequestAuthentication) RequireScoped(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
	return a.request.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		if p != a.value.Principal {
			httpx.WriteError(w, r, a.request.logger, "auth", "authenticate", Failure())
			return
		}
		next(w, r, a.value)
	})
}

func TestScopedProfileRegistrationRejectsMissingDependencies(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := &Authentication{RequestAuthentication: &RequestAuthentication{logger: logger}, callbackPath: "/auth/callback"}
	for _, tc := range []struct {
		name    string
		scoped  ScopedAuthentication
		profile ScopedProfile
	}{
		{name: "authentication", profile: &scopedProfileFixture{}},
		{name: "profile", scoped: &scopedProfileAuth{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Error("registration accepted a missing dependency")
				}
			}()
			h.RegisterScopedRoutes(http.NewServeMux(), tc.scoped, tc.profile, nil, nil)
		})
	}
}

func TestScopedProfileAuthenticationPrecedesPatch(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	id := "11111111-1111-4111-8111-111111111111"
	principal := model.Principal{Kind: model.SessionCredential, UserID: id, CredentialID: "22222222-2222-4222-8222-222222222222"}
	reqAuth, err := NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, secret string) (model.Principal, error) {
		if kind != model.SessionCredential || secret != "session" {
			return model.Principal{}, Failure()
		}
		return principal, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	scoped := scopedProfileRequestAuthentication{request: reqAuth, value: model.CredentialAuthorization{Principal: principal, Profile: model.SessionProfile}}
	profile := &scopedProfileFixture{}
	h := &Authentication{RequestAuthentication: reqAuth, callbackPath: "/auth/callback"}
	mux := http.NewServeMux()
	recheck := func(_ context.Context, _ store.IdentityScope, p model.Principal) (model.CredentialAuthorization, error) {
		if p != principal {
			t.Fatal("wrong recheck identity")
		}
		return scoped.value, nil
	}
	observed := map[string]ScopeRoute{}
	h.RegisterScopedRoutes(mux, scoped, profile, recheck, func(route ScopeRoute) { observed[route.Pattern] = route })
	if route := observed["PATCH /api/v1/me"]; len(route.Operations) != 1 || route.Operations[0] != scopepolicy.AccountWrite {
		t.Fatalf("patch classification: %+v", route)
	}
	for _, tc := range []struct {
		name, origin, cookie string
		status               int
		calls                int
	}{
		{"wrong origin", "https://other.example", "session", 403, 0},
		{"expired session", "https://daynight.example", "expired", 401, 0},
		{"valid session", "https://daynight.example", "session", 200, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("PATCH", "/api/v1/me", strings.NewReader(`{"name":"Alice"}`))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("Origin", tc.origin)
			r.AddCookie(&http.Cookie{Name: reqAuth.SessionCookieName(), Value: tc.cookie})
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != tc.status || profile.calls != tc.calls || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("status=%d calls=%d headers=%v body=%s", w.Code, profile.calls, w.Header(), w.Body)
			}
		})
	}
}
