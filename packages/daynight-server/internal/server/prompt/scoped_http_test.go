package prompt

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type scopedHTTPAuth struct{ value model.CredentialAuthorization }

func (a *scopedHTTPAuth) RequireScoped(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { next(w, r, a.value) }
}

type scopedHTTPPrompts struct {
	gets, puts                 int
	reviewerGets, reviewerPuts int
	received                   model.CredentialAuthorization
}

func (p *scopedHTTPPrompts) GetAuthorized(_ context.Context, auth model.CredentialAuthorization, scope model.PromptScope, id string) (model.PromptResource, error) {
	p.gets++
	p.received = auth
	if err := scopeadmission.Require(auth, scopepolicy.PromptRead); err != nil {
		return model.PromptResource{}, err
	}
	return model.PromptResource{Scope: scope, ScopeID: id, Revision: "0"}, nil
}
func (p *scopedHTTPPrompts) PutAuthorized(_ context.Context, auth model.CredentialAuthorization, scope model.PromptScope, id, expected, revision, text string) (model.PromptResource, error) {
	p.puts++
	p.received = auth
	if err := scopeadmission.Require(auth, scopepolicy.PromptRead, scopepolicy.PromptWrite); err != nil {
		return model.PromptResource{}, err
	}
	return model.PromptResource{Scope: scope, ScopeID: id, Revision: revision, Text: text}, nil
}
func (p *scopedHTTPPrompts) GetReviewerAuthorized(ctx context.Context, auth model.CredentialAuthorization, scope model.PromptScope, id string) (model.PromptResource, error) {
	p.reviewerGets++
	return p.GetAuthorized(ctx, auth, scope, id)
}
func (p *scopedHTTPPrompts) PutReviewerAuthorized(ctx context.Context, auth model.CredentialAuthorization, scope model.PromptScope, id, expected, revision, text string) (model.PromptResource, error) {
	p.reviewerPuts++
	return p.PutAuthorized(ctx, auth, scope, id, expected, revision, text)
}

func TestScopedPromptHTTPAssembly(t *testing.T) {
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"prompt:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	a := &scopedHTTPAuth{value: model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: userID, CredentialID: resourceID}, Profile: model.ScopedPATProfile, Policy: &policy}}
	p := &scopedHTTPPrompts{}
	mux := http.NewServeMux()
	RegisterScopedRoutes(mux, p, a, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	for _, method := range []string{"GET", "HEAD"} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(method, "/api/v1/me/worker-prompt", nil))
		if w.Code != 200 || p.received.Principal != a.value.Principal || p.received.Policy != a.value.Policy {
			t.Fatalf("%s: %d %s", method, w.Code, w.Body)
		}
	}
	body := fmt.Sprintf(`{"expectedUserId":%q,"revision":"0","text":"new"}`, userID)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("PUT", "/api/v1/me/worker-prompt", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(w, r)
	if w.Code != 403 || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || p.puts != 1 {
		t.Fatalf("PUT denial %d %v %s", w.Code, w.Header(), w.Body)
	}
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/me/reviewer-prompt", nil))
	if w.Code != 200 || p.reviewerGets != 1 {
		t.Fatalf("reviewer GET %d", w.Code)
	}
	w = httptest.NewRecorder()
	r = httptest.NewRequest("PUT", "/api/v1/me/reviewer-prompt", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(w, r)
	if w.Code != 403 || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || p.reviewerPuts != 1 {
		t.Fatalf("reviewer PUT %d", w.Code)
	}
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("POST", "/api/v1/me/worker-prompt", nil))
	if w.Code != 405 || p.gets != 3 || p.puts != 2 {
		t.Fatalf("fallback %d", w.Code)
	}
}

type scopedPromptRequestAuthentication struct {
	request *authhttp.RequestAuthentication
	value   model.CredentialAuthorization
}

func (a scopedPromptRequestAuthentication) RequireScoped(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
	return a.request.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		if p != a.value.Principal {
			httpx.WriteError(w, r, slog.Default(), "auth", "authenticate", authhttp.Failure())
			return
		}
		next(w, r, a.value)
	})
}

func TestScopedPromptRegistrationRejectsMissingDependencies(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, tc := range []struct {
		name    string
		prompts ScopedPrompts
		auth    ScopedAuthentication
	}{
		{name: "prompts", auth: &scopedHTTPAuth{}},
		{name: "authentication", prompts: &scopedHTTPPrompts{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Error("registration accepted a missing dependency")
				}
			}()
			RegisterScopedRoutes(http.NewServeMux(), tc.prompts, tc.auth, logger, nil)
		})
	}
}

func TestScopedPromptAuthenticationPrecedesBusinessAndFallback(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	principal := model.Principal{Kind: model.PATCredential, UserID: userID, CredentialID: resourceID}
	reqAuth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, secret string) (model.Principal, error) {
		if kind != model.PATCredential || secret != "valid" {
			return model.Principal{}, authhttp.Failure()
		}
		return principal, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"prompt:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	auth := scopedPromptRequestAuthentication{request: reqAuth, value: model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}}
	prompts := &scopedHTTPPrompts{}
	mux := http.NewServeMux()
	var observed []ScopeRoute
	RegisterScopedRoutes(mux, prompts, auth, logger, func(route ScopeRoute) { observed = append(observed, route) })
	if len(observed) != 24 {
		t.Fatalf("registered %d classifications", len(observed))
	}
	for _, tc := range []struct {
		name, method, token string
		status, gets        int
	}{
		{"invalid authentication", "GET", "invalid", 401, 0},
		{"valid read", "GET", "valid", 200, 1},
		{"unauthenticated fallback", "POST", "invalid", 401, 1},
		{"authenticated fallback", "POST", "valid", 405, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, "/api/v1/me/worker-prompt", nil)
			r.Header.Set("Authorization", "Bearer "+tc.token)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != tc.status || prompts.gets != tc.gets || prompts.puts != 0 || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("status=%d gets=%d headers=%v body=%s", w.Code, prompts.gets, w.Header(), w.Body)
			}
		})
	}
}
