package auth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
)

func TestIdentityHTTPLoginCredentialsAndRevocation(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.Login(t, "user-one")
	if cookie.Domain != "" || cookie.Path != "/" || cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.MaxAge != 604800 {
		t.Fatalf("session cookie: %+v", cookie)
	}
	cookies := []*http.Cookie{cookie}
	meResponse := h.Request("GET", "/api/v1/me", "", cookies, nil, "")
	user := testsupport.DecodeResponse[api.User](t, meResponse, 200)
	if user.ID == "" || user.Email != nil || user.Name != nil || user.AvatarURL != nil || user.EmailVerified == nil || *user.EmailVerified {
		t.Fatalf("profile semantics: %+v", user)
	}
	if strings.Contains(meResponse.Body.String(), "github:") || strings.Contains(meResponse.Body.String(), "raw-secret") {
		t.Fatal("raw identity exposed")
	}
	empty := testsupport.DecodeResponse[api.PersonalAccessTokenList](t, h.Request("GET", "/api/v1/me/tokens", "", cookies, nil, ""), 200)
	if empty.Items == nil || len(empty.Items) != 0 {
		t.Fatalf("empty tokens: %+v", empty)
	}
	minted := testsupport.DecodeResponse[api.CreatedPersonalAccessToken](t, h.Request("POST", "/api/v1/me/tokens", `{"name":"CI agent","expiresAt":null}`, cookies, nil, h.Origin), 201)
	if !strings.HasPrefix(minted.Token, "dnpat_") || minted.ExpiresAt != nil {
		t.Fatalf("token: %+v", minted)
	}
	var stored []byte
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT token_hash FROM personal_access_tokens WHERE id=$1`, minted.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256([]byte(minted.Token))
	if !bytes.Equal(stored, want[:]) {
		t.Fatal("token hash differs")
	}
	listResponse := h.Request("GET", "/api/v1/me/tokens", "", cookies, nil, "")
	list := testsupport.DecodeResponse[api.PersonalAccessTokenList](t, listResponse, 200)
	if len(list.Items) != 1 || strings.Contains(listResponse.Body.String(), minted.Token) || strings.Contains(listResponse.Body.String(), "token_hash") {
		t.Fatal("PAT list exposed secret")
	}
	bearer := []string{"Bearer " + minted.Token}
	if got := h.Request("GET", "/api/v1/me", "", nil, bearer, ""); got.Code != 200 {
		t.Fatalf("PAT authentication: %d %s", got.Code, got.Body)
	}
	if got := h.Request("POST", "/mutation", "", cookies, bearer, "https://foreign.test"); got.Code != 204 {
		t.Fatalf("Bearer origin behavior: %d %s", got.Code, got.Body)
	}
	for _, call := range []struct{ method, path, body string }{{"GET", "/api/v1/me/tokens", ""}, {"POST", "/api/v1/me/tokens", `{"name":"nested","expiresAt":null}`}, {"DELETE", "/api/v1/me/tokens/" + minted.ID, ""}, {"POST", "/api/v1/auth/logout", ""}} {
		got := h.Request(call.method, call.path, call.body, cookies, bearer, h.Origin)
		testsupport.AssertProjectError(t, got, 403, "forbidden")
	}
	for range 2 {
		if got := h.Request("DELETE", "/api/v1/me/tokens/"+minted.ID, "", cookies, nil, h.Origin); got.Code != 204 {
			t.Fatalf("revoke: %d %s", got.Code, got.Body)
		}
	}
	testsupport.AssertProjectError(t, h.Request("GET", "/api/v1/me", "", cookies, bearer, ""), 401, "unauthenticated")
	loggedOut := h.Request("POST", "/api/v1/auth/logout", "", cookies, nil, h.Origin)
	if loggedOut.Code != 204 || loggedOut.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("logout failed")
	}
	testsupport.AssertProjectError(t, h.Request("GET", "/api/v1/me", "", cookies, nil, ""), 401, "unauthenticated")
	for _, secret := range []string{cookie.Value, minted.Token, "app-secret-never-log", "raw-secret", "user-one"} {
		if strings.Contains(h.Logs.String(), secret) {
			t.Fatalf("secret logged: %s", secret)
		}
	}
	if !strings.Contains(h.Logs.String(), `"user_id":"`+user.ID+`"`) {
		t.Fatal("missing identity correlation")
	}
}

func TestIdentityHTTPOriginAndBearerPrecedence(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.Login(t, "origin-user")
	cookies := []*http.Cookie{cookie}
	for _, origin := range []string{"", "null", "https://foreign.test", "http://127.0.0.1:8787/", "http://localhost:8787"} {
		testsupport.AssertProjectError(t, h.Request("POST", "/mutation", "", cookies, nil, origin), 403, "forbidden")
	}
	for _, authorization := range [][]string{{""}, {"Basic abc"}, {"Bearer invalid"}, {"Bearer a", "Bearer b"}, {"Bearer a b"}, {"Bearer " + cookie.Value}} {
		testsupport.AssertProjectError(t, h.Request("GET", "/api/v1/me", "", cookies, authorization, ""), 401, "unauthenticated")
	}
	testsupport.AssertProjectError(t, h.Request("GET", "/api/v1/me", "", nil, nil, ""), 401, "unauthenticated")
	testsupport.AssertProjectError(t, h.Request("GET", "/api/v1/me", "", []*http.Cookie{cookie, cookie}, nil, ""), 401, "unauthenticated")
	r := httptest.NewRequest("POST", "/mutation", nil)
	r.AddCookie(cookie)
	r.Header["Origin"] = []string{h.Origin, h.Origin}
	response := httptest.NewRecorder()
	h.Handler.ServeHTTP(response, r)
	if response.Code != 403 {
		t.Fatalf("duplicate origin accepted: %d", response.Code)
	}
	if _, err := h.Database.Pool.Exec(context.Background(), `UPDATE sessions SET created_at=now()-interval '8 days',expires_at=now()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	testsupport.AssertProjectError(t, h.Request("GET", "/api/v1/me", "", cookies, nil, ""), 401, "unauthenticated")
}

func TestIdentityHTTPResponsePrincipalProvenance(t *testing.T) {
	h := authTestHarness(t)
	aliceCookie := h.Login(t, "principal-alice")
	aliceCookies := []*http.Cookie{aliceCookie}
	aliceResponse := h.Request("GET", "/api/v1/me", "", aliceCookies, nil, "")
	alice := testsupport.DecodeResponse[api.User](t, aliceResponse, http.StatusOK)
	if aliceResponse.Header().Get("Daynight-User-ID") != alice.ID {
		t.Fatal("session response does not identify its authenticated principal")
	}

	bobCookie := h.Login(t, "principal-bob")
	bobCookies := []*http.Cookie{bobCookie}
	bobResponse := h.Request("GET", "/api/v1/me", "", bobCookies, nil, "")
	bob := testsupport.DecodeResponse[api.User](t, bobResponse, http.StatusOK)
	if bob.ID == alice.ID || bobResponse.Header().Get("Daynight-User-ID") != bob.ID {
		t.Fatal("account replacement reused the previous response principal")
	}

	minted := testsupport.DecodeResponse[api.CreatedPersonalAccessToken](t,
		h.Request("POST", "/api/v1/me/tokens", `{"name":"principal-test","expiresAt":null}`, aliceCookies, nil, h.Origin), http.StatusCreated)
	bearer := []string{"Bearer " + minted.Token}
	patResponse := h.Request("GET", "/api/v1/me", "", bobCookies, bearer, "")
	if user := testsupport.DecodeResponse[api.User](t, patResponse, http.StatusOK); user.ID != alice.ID || patResponse.Header().Get("Daynight-User-ID") != alice.ID {
		t.Fatal("response principal followed the cookie instead of the admitted bearer")
	}

	spoofed := httptest.NewRequest("GET", "/api/v1/me", nil)
	spoofed.AddCookie(aliceCookie)
	spoofed.Header.Set("Daynight-User-ID", bob.ID)
	spoofedResponse := httptest.NewRecorder()
	h.Handler.ServeHTTP(spoofedResponse, spoofed)
	if user := testsupport.DecodeResponse[api.User](t, spoofedResponse, http.StatusOK); user.ID != alice.ID || spoofedResponse.Header().Get("Daynight-User-ID") != alice.ID {
		t.Fatal("request-supplied principal was echoed into the response")
	}

	mutation := h.Request("POST", "/mutation", "", aliceCookies, nil, h.Origin)
	if mutation.Code != http.StatusNoContent || mutation.Header().Get("Daynight-User-ID") != alice.ID {
		t.Fatal("successful empty mutation response lost its principal")
	}
	invalid := h.Request("POST", "/api/v1/me/tokens", `{}`, aliceCookies, nil, h.Origin)
	testsupport.AssertProjectError(t, invalid, http.StatusBadRequest, "invalid_input")
	forbidden := h.Request("POST", "/api/v1/me/tokens", `{"name":"nested","expiresAt":null}`, bobCookies, bearer, h.Origin)
	testsupport.AssertProjectError(t, forbidden, http.StatusForbidden, "forbidden")
	for _, response := range []*httptest.ResponseRecorder{invalid, forbidden} {
		if response.Header().Get("Daynight-User-ID") != alice.ID {
			t.Fatal("authenticated resource error lost the actual principal")
		}
	}
	for _, response := range []*httptest.ResponseRecorder{
		h.Request("GET", "/api/v1/me", "", nil, nil, ""),
		h.Request("GET", "/api/v1/me", "", bobCookies, []string{"Bearer invalid"}, ""),
		h.Request("POST", "/mutation", "", aliceCookies, nil, "https://foreign.test"),
	} {
		if response.Header().Get("Daynight-User-ID") != "" {
			t.Fatal("failed authentication exposed an unadmitted principal")
		}
	}
}

func TestIdentityHTTPCallbackFailures(t *testing.T) {
	h := authTestHarness(t)
	for _, destination := range []string{"/projects/project/tasks/task/attachments/docs/guide.md?tab=overview#details", "/invitations", "/team-invitations", "/device?user_code=ABCD-EFGH"} {
		for _, mode := range []string{"provider", "protocol-secret", "denied-secret"} {
			state, binding := h.Start(t, destination)
			values := url.Values{"state": {state}}
			if mode == "provider" {
				values.Set("error", "provider_denied")
			} else {
				values.Set("code", mode)
			}
			before := h.Claims.Load()
			result := h.Request("GET", "/api/v1/auth/callback?"+values.Encode(), "", []*http.Cookie{binding}, nil, "")
			if mode == "protocol-secret" {
				testsupport.AssertProjectError(t, result, http.StatusBadGateway, "identity_unavailable")
			} else {
				location, err := url.Parse(result.Header().Get("Location"))
				if result.Code != http.StatusSeeOther || err != nil || location.Path != "/login" || location.Query().Get("authError") != "login_failed" || location.Query().Get("returnPath") != destination || len(location.Query()) != 2 {
					t.Fatalf("failed browser navigation lost its destination: %d %s", result.Code, result.Body)
				}
			}
			if len(result.Result().Cookies()) != 1 || result.Result().Cookies()[0].MaxAge != -1 {
				t.Fatalf("failed callback did not clear binding: %d %s", result.Code, result.Body)
			}
			replay := h.Request("GET", "/api/v1/auth/callback?"+values.Encode(), "", []*http.Cookie{binding}, nil, "")
			testsupport.AssertProjectError(t, replay, 401, "unauthenticated")
			want := int32(1)
			if mode == "provider" {
				want = 0
			}
			if h.Claims.Load()-before != want {
				t.Fatal("one-time callback retried")
			}
		}
	}
	state, binding := h.Start(t, "/")
	callback := "/api/v1/auth/callback?" + url.Values{"state": {state}, "code": {"user"}}.Encode()
	testsupport.AssertProjectError(t, h.Request("GET", callback, "", nil, nil, ""), 401, "unauthenticated")
	wrong := *binding
	wrong.Value = "wrong"
	testsupport.AssertProjectError(t, h.Request("GET", callback, "", []*http.Cookie{&wrong}, nil, ""), 401, "unauthenticated")
	if got := h.Request("GET", callback, "", []*http.Cookie{binding}, nil, ""); got.Code != 303 {
		t.Fatal("wrong browser consumed pending")
	}
	for _, query := range []string{"state=x&state=y&code=z", "state=x&unknown=z", "state=x%zz"} {
		testsupport.AssertProjectError(t, h.Request("GET", "/api/v1/auth/callback?"+query, "", nil, nil, ""), 400, "invalid_input")
	}
	for _, secret := range []string{"app-secret-never-log", "protocol-secret", "denied-secret", "raw-secret", "upstream-secret", "bad secret"} {
		if strings.Contains(h.Logs.String(), secret) {
			t.Fatalf("failure secret logged: %s", secret)
		}
	}
	if !strings.Contains(h.Logs.String(), `"cause":"protocol"`) || !strings.Contains(h.Logs.String(), `"upstream_request_id":"upstream-request"`) {
		t.Fatal("protocol failure not classified/correlated")
	}
}

func TestIdentityHTTPDefaultLoginDestination(t *testing.T) {
	h := authTestHarness(t)
	state, binding := h.Start(t, "")
	result := h.Request(http.MethodGet, "/api/v1/auth/callback?"+url.Values{"state": {state}, "code": {"default-destination"}}.Encode(), "", []*http.Cookie{binding}, nil, "")
	if result.Code != http.StatusSeeOther || result.Header().Get("Location") != "/projects" {
		t.Fatal("login without a destination did not enter the project workspace")
	}
}

func TestIdentityHTTPSessionCreationFailureRetainsDestination(t *testing.T) {
	h := authTestHarness(t)
	if _, err := h.Database.Pool.Exec(context.Background(), `ALTER TABLE sessions ADD CONSTRAINT reject_session CHECK (false)`); err != nil {
		t.Fatal(err)
	}
	const destination = "/device?user_code=ABCD-EFGH"
	state, binding := h.Start(t, destination)
	result := h.Request(http.MethodGet, "/api/v1/auth/callback?"+url.Values{"state": {state}, "code": {"session-failure"}}.Encode(), "", []*http.Cookie{binding}, nil, "")
	location, err := url.Parse(result.Header().Get("Location"))
	if result.Code != http.StatusSeeOther || err != nil || location.Path != "/login" || location.Query().Get("authError") != "login_failed" || location.Query().Get("returnPath") != destination {
		t.Fatal("session creation failure lost its validated login destination")
	}
	cookies := result.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != binding.Name || cookies[0].MaxAge != -1 {
		t.Fatal("session creation failure must clear only its consumed browser binding")
	}
	if !strings.Contains(h.Logs.String(), `"cause":"database"`) {
		t.Fatal("session creation failure lost its database error classification")
	}
}

func TestIdentityHTTPInputAndOperationalFailures(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.Login(t, "input-user")
	cookies := []*http.Cookie{cookie}
	for _, body := range []string{`{}`, `{"name":null}`, `{"name":""}`, `{"name":"ok","days":null}`, `{"name":"ok","days":"30"}`, `{"name":"ok","days":0}`, `{"name":"ok","days":366}`, `{"name":"ok","unknown":true}`, `invalid`} {
		testsupport.AssertProjectError(t, h.Request("POST", "/api/v1/me/tokens", body, cookies, nil, h.Origin), 400, "invalid_input")
	}
	testsupport.AssertProjectError(t, h.Request("DELETE", "/api/v1/me/tokens/invalid", "", cookies, nil, h.Origin), 400, "invalid_input")
	for _, path := range []string{"/api/v1/auth/login", "/api/v1/auth/login?provider=unknown", "/api/v1/auth/login?provider=github&returnPath=https://foreign.test", "/api/v1/auth/login?provider=github&returnPath=//foreign.test", "/api/v1/auth/login?provider=github&returnPath=%2Fapi%2Fv1%2Fauth%2Flogin", "/api/v1/auth/login?provider=github&returnPath=%2Flogin", "/api/v1/auth/login?provider=github&returnPath=%2Flogin%3FreturnPath%3D%2Fprojects", "/api/v1/auth/login?provider=github&unexpected=x"} {
		testsupport.AssertProjectError(t, h.Request("GET", path, "", nil, nil, ""), 400, "invalid_input")
	}
	for _, path := range []string{"/api/v1/auth/login", "/api/v1/auth/callback"} {
		if got := h.Request("HEAD", path, "", nil, nil, ""); got.Code != 405 {
			t.Fatal("HEAD consumed login")
		}
	}
	testsupport.AssertProjectError(t, h.Request("PUT", "/api/v1/me", "", nil, nil, ""), http.StatusUnauthorized, "unauthenticated")
	if got := h.Request("PUT", "/api/v1/me", "", cookies, nil, h.Origin); got.Code != 405 {
		t.Fatal("method routing")
	}
	if _, err := h.Database.Pool.Exec(context.Background(), `DROP TABLE personal_access_tokens`); err != nil {
		t.Fatal(err)
	}
	testsupport.AssertProjectError(t, h.Request("GET", "/api/v1/me/tokens", "", cookies, nil, ""), 500, "internal_error")
	testsupport.AssertProjectError(t, h.Request("POST", "/api/v1/me/tokens", `{"name":"fails","expiresAt":null}`, cookies, nil, h.Origin), 500, "internal_error")
	testsupport.AssertProjectError(t, h.Request("DELETE", "/api/v1/me/tokens/00000000-0000-0000-0000-000000000001", "", cookies, nil, h.Origin), 500, "internal_error")
	if _, err := h.Database.Pool.Exec(context.Background(), `ALTER TABLE users RENAME TO unavailable_users`); err != nil {
		t.Fatal(err)
	}
	testsupport.AssertProjectError(t, h.Request("GET", "/api/v1/me", "", cookies, nil, ""), 500, "internal_error")
	if !strings.Contains(h.Logs.String(), `"cause":"database"`) {
		t.Fatal("database fault not classified")
	}
}

func TestIdentityHTTPUserDisappearsAfterCredentialAdmission(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.Login(t, "removed-user")
	request := httptest.NewRequest("GET", "/api/v1/me", nil)
	request.AddCookie(cookie)
	principal, err := h.Auth.AuthenticateRequest(request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.Database.Pool.Exec(context.Background(), "DELETE FROM users WHERE id=$1", principal.UserID); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	h.Auth.me(response, request, principal)
	testsupport.DecodeResponse[api.ErrorResponse](t, response, 401)
}

func TestIdentityHTTPLoginReturnsToTestSessionDeepLink(t *testing.T) {
	h := authTestHarness(t)
	destination := "/test-sessions/10000000-0000-0000-0000-000000000001"
	state, binding := h.Start(t, destination)
	response := h.Request(http.MethodGet, "/api/v1/auth/callback?"+url.Values{"state": {state}, "code": {"test-session-owner"}}.Encode(), "", []*http.Cookie{binding}, nil, "")
	if response.Code != http.StatusSeeOther || response.Header().Get("Location") != destination {
		t.Fatalf("login lost Test Session destination: %d %s", response.Code, response.Header().Get("Location"))
	}
	found := false
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == h.Auth.SessionCookieName() {
			found = true
		}
	}
	if !found {
		t.Fatal("successful callback omitted login session")
	}
}

func TestIdentityHTTPPATExpiryAndCookieLogoutAreIndependent(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.Login(t, "credential-independence")
	cookies := []*http.Cookie{cookie}
	user := testsupport.DecodeResponse[api.User](t, h.Request(http.MethodGet, "/api/v1/me", "", cookies, nil, ""), http.StatusOK)
	mint := func(name string) api.CreatedPersonalAccessToken {
		t.Helper()
		return testsupport.DecodeResponse[api.CreatedPersonalAccessToken](t, h.Request(http.MethodPost, "/api/v1/me/tokens", `{"name":"`+name+`","expiresAt":null}`, cookies, nil, h.Origin), http.StatusCreated)
	}
	expired, active := mint("Expired independently"), mint("Active independently")
	result, err := h.Database.Pool.Exec(context.Background(), `UPDATE personal_access_tokens SET created_at=now()-interval '2 hours',expires_at=now()-interval '1 hour' WHERE id=$1`, expired.ID)
	if err != nil || result.RowsAffected() != 1 {
		t.Fatalf("expire the selected credential: %v", err)
	}
	expiredBearer := []string{"Bearer " + expired.Token}
	activeBearer := []string{"Bearer " + active.Token}
	testsupport.AssertProjectError(t, h.Request(http.MethodGet, "/api/v1/me", "", nil, expiredBearer, ""), http.StatusUnauthorized, "unauthenticated")
	cookieUser := testsupport.DecodeResponse[api.User](t, h.Request(http.MethodGet, "/api/v1/me", "", cookies, nil, ""), http.StatusOK)
	patUser := testsupport.DecodeResponse[api.User](t, h.Request(http.MethodGet, "/api/v1/me", "", nil, activeBearer, ""), http.StatusOK)
	if cookieUser.ID != user.ID || patUser.ID != user.ID {
		t.Fatal("PAT expiry changed the independent session or active credential")
	}
	logout := h.Request(http.MethodPost, "/api/v1/auth/logout", "", cookies, nil, h.Origin)
	if logout.Code != http.StatusNoContent || len(logout.Result().Cookies()) != 1 || logout.Result().Cookies()[0].MaxAge != -1 {
		t.Fatalf("session logout: %d", logout.Code)
	}
	testsupport.AssertProjectError(t, h.Request(http.MethodGet, "/api/v1/me", "", cookies, nil, ""), http.StatusUnauthorized, "unauthenticated")
	patUser = testsupport.DecodeResponse[api.User](t, h.Request(http.MethodGet, "/api/v1/me", "", nil, activeBearer, ""), http.StatusOK)
	if patUser.ID != user.ID {
		t.Fatal("cookie logout changed the independent PAT owner")
	}
	for _, secret := range []string{cookie.Value, expired.Token, active.Token} {
		if strings.Contains(h.Logs.String(), secret) {
			t.Fatal("credential entered diagnostics")
		}
	}
}
