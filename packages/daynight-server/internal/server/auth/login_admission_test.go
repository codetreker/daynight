package auth

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
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

func TestLoginBootstrapSecureCookieAndInputLimit(t *testing.T) {
	h := authTestHarness(t)
	h.Auth.secure = true
	for _, value := range []string{"/" + strings.Repeat("a", 4096), "/" + strings.Repeat("界", 1366)} {
		path := "/api/v1/auth/login?" + url.Values{"provider": {"github"}, "returnPath": {value}}.Encode()
		response := h.Request("GET", path, "", nil, nil, "")
		testsupport.AssertProjectError(t, response, 400, "invalid_input")
		if len(response.Result().Cookies()) != 0 {
			t.Fatal("invalid input set cookie")
		}
	}
	value := "/" + strings.Repeat("界", 1365)
	path := "/api/v1/auth/login?" + url.Values{"provider": {"github"}, "returnPath": {value}}.Encode()
	response := h.Request("GET", path, "", nil, nil, "")
	if response.Code != 303 || response.Header().Get("Location") != path || len(response.Result().Cookies()) != 1 {
		t.Fatalf("valid boundary: %d", response.Code)
	}
	cookie := response.Result().Cookies()[0]
	if cookie.Name != "__Host-daynight_login_scope" || !cookie.Secure || !cookie.HttpOnly || cookie.Domain != "" || cookie.Path != "/" || cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("secure cookie: %+v", cookie)
	}
	var n int
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM login_transactions`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("bootstrap count %d: %v", n, err)
	}
}

func TestLoginGlobalCapacityHTTP(t *testing.T) {
	h := authTestHarness(t)
	const path = "/api/v1/auth/login?provider=github"
	bootstrap := h.Request("GET", path, "", nil, nil, "")
	if bootstrap.Code != 303 || len(bootstrap.Result().Cookies()) != 1 {
		t.Fatal("scope bootstrap failed")
	}
	_, err := h.Database.Pool.Exec(context.Background(), `INSERT INTO login_transactions(id,state_hash,browser_binding_hash,provider,return_path,expires_at,scope_hash)
 SELECT md5('http-login'||n)::uuid,sha256(('http-state'||n)::bytea),sha256('binding'::bytea),'github','/',clock_timestamp()+interval '10 minutes',sha256(('scope'||n)::bytea) FROM generate_series(1,10000) n`)
	if err != nil {
		t.Fatal(err)
	}
	response := h.Request("GET", path, "", bootstrap.Result().Cookies(), nil, "")
	testsupport.AssertProjectError(t, response, http.StatusServiceUnavailable, "capacity_exhausted")
	if response.Header().Get("Retry-After") == "" || len(response.Result().Cookies()) != 0 {
		t.Fatal("global rejection omitted Retry-After or set cookies")
	}
	var count int
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM login_transactions`).Scan(&count); err != nil || count != 10000 {
		t.Fatalf("global rejection changed rows: %d %v", count, err)
	}
}
