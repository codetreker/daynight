package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func TestLoginBootstrapAndBrowserQuota(t *testing.T) {
	h := authTestHarness(t)
	path := "/api/v1/auth/login?provider=github&returnPath=%2Fprojects"
	count := func() int {
		t.Helper()
		var n int
		if err := h.Database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM login_transactions`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	for range 2 {
		bootstrap := h.Request("GET", path, "", nil, nil, "")
		if bootstrap.Code != 303 || bootstrap.Header().Get("Location") != path || len(bootstrap.Result().Cookies()) != 1 || count() != 0 {
			t.Fatal("bootstrap must redirect without a transaction")
		}
	}
	bootstrap := h.Request("GET", path, "", nil, nil, "")
	scope := bootstrap.Result().Cookies()[0]
	if scope.Name != "daynight_login_scope" || scope.Path != "/" || scope.Domain != "" || scope.Secure || !scope.HttpOnly || scope.SameSite != http.SameSiteLaxMode || scope.MaxAge != 600 {
		t.Fatalf("scope cookie: %+v", scope)
	}
	var state string
	var binding *http.Cookie
	for range 5 {
		response := h.Request("GET", path, "", []*http.Cookie{scope}, nil, "")
		if response.Code != 303 || len(response.Result().Cookies()) != 2 {
			t.Fatalf("login: %d %s", response.Code, response.Body)
		}
		u, err := url.Parse(response.Header().Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		state = u.Query().Get("state")
		for _, cookie := range response.Result().Cookies() {
			if cookie.Name == scope.Name {
				if cookie.Value != scope.Value || cookie.MaxAge != 600 || cookie.Expires.Before(time.Now().Add(9*time.Minute)) {
					t.Fatal("scope not refreshed")
				}
			} else {
				binding = cookie
			}
		}
	}
	denied := h.Request("GET", path, "", []*http.Cookie{scope}, nil, "")
	testsupport.AssertProjectError(t, denied, 429, "rate_limited")
	if len(denied.Result().Cookies()) != 0 || count() != 5 {
		t.Fatal("quota rejection changed cookies or transactions")
	}
	callback := "/api/v1/auth/callback?" + url.Values{"state": {state}, "code": {"quota-user"}}.Encode()
	if got := h.Request("GET", callback, "", []*http.Cookie{binding}, nil, ""); got.Code != 303 {
		t.Fatalf("existing login no longer consumable: %d", got.Code)
	}
	if got := h.Request("GET", path, "", []*http.Cookie{scope}, nil, ""); got.Code != 303 {
		t.Fatalf("consumed slot not reusable: %d", got.Code)
	}
}

func requireLoginCookie(t *testing.T, cookies []*http.Cookie, name string, secure bool, maxAge int) *http.Cookie {
	t.Helper()
	var result *http.Cookie
	for _, c := range cookies {
		if c.Name != name {
			continue
		}
		if result != nil {
			t.Fatalf("duplicate login cookie %s", name)
		}
		result = c
	}
	if result == nil || result.Domain != "" || result.Path != "/" || !result.HttpOnly ||
		result.Secure != secure || result.SameSite != http.SameSiteLaxMode || result.MaxAge != maxAge || result.Expires.IsZero() {
		t.Fatalf("incorrect attributes for login cookie %s", name)
	}
	return result
}

func strictLoginPath(returnPath string) string {
	values := url.Values{"provider": {"github"}}
	if returnPath != "" {
		values.Set("returnPath", returnPath)
	}
	return "/api/v1/auth/login?" + values.Encode()
}

func requireStrictLoginBootstrap(t *testing.T, h *strictAuthHTTP, path, returnPath string, secure bool) *http.Cookie {
	t.Helper()
	response := h.request("GET", path, "", nil, nil, "",
		authRequestCall{name: "ValidateLogin", args: []any{"github", returnPath}})
	cookies := response.Result().Cookies()
	if response.Code != http.StatusSeeOther || response.Header().Get("Location") != path ||
		response.Header().Get("Cache-Control") != "no-store" || len(cookies) != 1 {
		t.Fatalf("login bootstrap: status=%d redirect and cache policy must match, cookies=%d", response.Code, len(cookies))
	}
	name := "daynight_login_scope"
	if secure {
		name = "__Host-daynight_login_scope"
	}
	scope := requireLoginCookie(t, cookies, name, secure, 600)
	if !secretutil.Valid(scope.Value, "") {
		t.Fatal("login bootstrap did not mint a valid browser scope")
	}
	return scope
}

func TestLoginBootstrapSecureCookieAndInputLimit(t *testing.T) {
	h := newStrictAuthHTTPWithSettings(t, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"})
	tooLong := &model.Fault{Code: "invalid_input", Message: "Return path exceeds 4096 bytes."}
	for _, value := range []string{"/" + strings.Repeat("a", 4096), "/" + strings.Repeat("界", 1366)} {
		response := h.request("GET", strictLoginPath(value), "", nil, nil, "",
			authRequestCall{name: "ValidateLogin", args: []any{"github", value}, err: tooLong})
		testsupport.AssertProjectError(t, response, http.StatusBadRequest, "invalid_input")
		if len(response.Result().Cookies()) != 0 {
			t.Fatal("invalid input set cookie")
		}
	}
	for _, value := range []string{"/" + strings.Repeat("a", 4095), "/" + strings.Repeat("界", 1365)} {
		requireStrictLoginBootstrap(t, h, strictLoginPath(value), value, true)
	}
}

func TestLoginGlobalCapacityHTTP(t *testing.T) {
	h := newStrictAuthHTTP(t)
	const path = "/api/v1/auth/login?provider=github"
	scope := requireStrictLoginBootstrap(t, h, path, "", false)
	capacity := &model.Fault{Code: "capacity_exhausted", Message: "Login capacity is unavailable. Please try again later."}
	response := h.request("GET", path, "", []*http.Cookie{scope}, nil, "",
		authRequestCall{name: "ValidateLogin", args: []any{"github", ""}},
		authRequestCall{name: "StartLogin", args: []any{"github", "", scope.Value}, err: capacity},
	)
	testsupport.AssertProjectError(t, response, http.StatusServiceUnavailable, "capacity_exhausted")
	if response.Header().Get("Retry-After") != "60" || len(response.Result().Cookies()) != 0 ||
		response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Location") != "" {
		t.Fatalf("global capacity rejection: Retry-After=%q cookies=%d", response.Header().Get("Retry-After"), len(response.Result().Cookies()))
	}
}

func completeStrictLogin(t *testing.T, requestedReturnPath, resolvedReturnPath, code string) *httptest.ResponseRecorder {
	t.Helper()
	h := newStrictAuthHTTP(t)
	path := strictLoginPath(requestedReturnPath)
	scope := requireStrictLoginBootstrap(t, h, path, requestedReturnPath, false)
	state := strings.Repeat("S", 42) + "A"
	bindingValue := strings.Repeat("B", 42) + "A"
	authorizationURL := "https://identity.example/authorize?" + url.Values{"state": {state}, "provider": {"github"}}.Encode()
	start := identitycore.LoginStart{
		ID: "50000000-0000-4000-8000-000000000001", State: state, BrowserBinding: bindingValue,
		AuthorizationURL: authorizationURL, ExpiresAt: time.Date(2030, 1, 2, 3, 4, 5, 0, time.UTC),
	}
	started := h.request("GET", path, "", []*http.Cookie{scope}, nil, "",
		authRequestCall{name: "ValidateLogin", args: []any{"github", requestedReturnPath}},
		authRequestCall{name: "StartLogin", args: []any{"github", requestedReturnPath, scope.Value}, result: start},
	)
	startCookies := started.Result().Cookies()
	if started.Code != http.StatusSeeOther || started.Header().Get("Location") != authorizationURL ||
		started.Header().Get("Cache-Control") != "no-store" || len(startCookies) != 2 {
		t.Fatalf("login start: status=%d cookies=%d", started.Code, len(startCookies))
	}
	stateHash := sha256.Sum256([]byte(state))
	bindingName := "daynight_login_" + hex.EncodeToString(stateHash[:16])
	refreshed := requireLoginCookie(t, startCookies, scope.Name, false, 600)
	binding := requireLoginCookie(t, startCookies, bindingName, false, 600)
	if refreshed.Value != scope.Value || binding.Value != bindingValue ||
		!refreshed.Expires.Equal(start.ExpiresAt) || !binding.Expires.Equal(start.ExpiresAt) {
		t.Fatal("login start changed the scope or binding cookie")
	}

	actor, user := authRequestAccount(1)
	completed := identitycore.LoginCompletion{
		LoginID: start.ID, User: user, Secret: authAliceCookie, ReturnPath: resolvedReturnPath,
		Session: model.Session{ID: actor.CredentialID, UserID: actor.UserID, ExpiresAt: start.ExpiresAt.Add(identitycore.SessionLifetime)},
	}
	callbackQuery := url.Values{"state": {state}, "code": {code}}
	callbackPath := "/api/v1/auth/callback?" + callbackQuery.Encode()
	response := h.request("GET", callbackPath, "", []*http.Cookie{binding}, nil, "",
		authRequestCall{name: "CompleteLogin", args: []any{callbackQuery, bindingValue}, result: completed})
	completionCookies := response.Result().Cookies()
	if response.Code != http.StatusSeeOther || response.Header().Get("Cache-Control") != "no-store" || len(completionCookies) != 2 {
		t.Fatalf("login callback: status=%d cookies=%d", response.Code, len(completionCookies))
	}
	cleared := requireLoginCookie(t, completionCookies, bindingName, false, -1)
	session := requireLoginCookie(t, completionCookies, "daynight_session", false, 604800)
	if cleared.Value != "" || !cleared.Expires.Equal(time.Unix(1, 0)) ||
		session.Value != completed.Secret || !session.Expires.Equal(completed.Session.ExpiresAt) {
		t.Fatal("login callback did not clear the binding or issue the expected session")
	}
	return response
}
