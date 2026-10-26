package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

type authHarness struct {
	database *store.Store
	auth     *Authentication
	handler  http.Handler
	logs     bytes.Buffer
	claims   atomic.Int32
}

func authTestHarness(t *testing.T) *authHarness {
	t.Helper()
	h := &authHarness{database: projectTestStore(t)}
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.claims.Add(1)
		app, secret, ok := r.BasicAuth()
		if !ok || app != "test-app" || secret != "app-secret-never-log" || r.Method != "POST" || r.URL.Path != "/auth/result" {
			t.Error("incorrect gateway request")
		}
		var input struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch input.Code {
		case "protocol-secret":
			w.Header().Set("X-Request-ID", "upstream-request")
			_, _ = io.WriteString(w, `{"payload":"raw-secret"}`)
		case "denied-secret":
			w.Header().Set("X-Request-ID", "bad secret")
			w.WriteHeader(410)
			_, _ = io.WriteString(w, `{"error":{"code":"expired","message":"upstream-secret"}}`)
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"provider": "github", "id": "github:" + input.Code, "email": nil, "email_verified": false, "name": nil, "avatar_url": nil, "origin": map[string]any{"provider-secret": "raw-secret"}})
		}
	}))
	t.Cleanup(gateway.Close)
	client, err := uniauth.New(uniauth.Config{BaseURL: gateway.URL, AppID: "test-app", AppSecret: "app-secret-never-log", AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(&h.logs, nil))
	h.auth, err = NewAuthentication(service.NewIdentity(h.database, client, "http://127.0.0.1:8787/api/v1/auth/callback"), AuthConfig{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	h.auth.RegisterRoutes(mux)
	mux.HandleFunc("POST /mutation", h.auth.Require(func(w http.ResponseWriter, r *http.Request, p core.Principal) { w.WriteHeader(204) }))
	h.handler = RequestLogging(logger, mux)
	return h
}

func (h *authHarness) request(method, path, body string, cookies []*http.Cookie, authorization []string, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("X-Request-ID", "project-test")
	r.Header.Set("Content-Type", "application/json")
	for _, cookie := range cookies {
		r.AddCookie(cookie)
	}
	if authorization != nil {
		r.Header["Authorization"] = authorization
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	w := httptest.NewRecorder()
	h.handler.ServeHTTP(w, r)
	return w
}

func (h *authHarness) start(t *testing.T, returnPath string) (string, *http.Cookie) {
	t.Helper()
	values := url.Values{"provider": {"github"}}
	if returnPath != "" {
		values.Set("returnPath", returnPath)
	}
	response := h.request("GET", "/api/v1/auth/login?"+values.Encode(), "", nil, nil, "")
	if response.Code != 303 || len(response.Result().Cookies()) != 1 {
		t.Fatalf("login start: %d %s", response.Code, response.Body)
	}
	u, err := url.Parse(response.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	cookie := response.Result().Cookies()[0]
	if cookie.Domain != "" || cookie.Path != "/" || cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.MaxAge != 600 {
		t.Fatalf("binding cookie: %+v", cookie)
	}
	return u.Query().Get("state"), cookie
}

func (h *authHarness) login(t *testing.T, code string) *http.Cookie {
	t.Helper()
	state, binding := h.start(t, "/projects?view=all")
	response := h.request("GET", "/api/v1/auth/callback?"+url.Values{"state": {state}, "code": {code}}.Encode(), "", []*http.Cookie{binding}, nil, "")
	if response.Code != 303 || response.Header().Get("Location") != "/projects?view=all" {
		t.Fatalf("callback: %d %s %s", response.Code, response.Header().Get("Location"), response.Body)
	}
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == h.auth.SessionCookieName() {
			return cookie
		}
	}
	t.Fatal("missing session cookie")
	return nil
}

func TestIdentityHTTPLoginCredentialsAndRevocation(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.login(t, "user-one")
	if cookie.Domain != "" || cookie.Path != "/" || cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.MaxAge != 604800 {
		t.Fatalf("session cookie: %+v", cookie)
	}
	cookies := []*http.Cookie{cookie}
	meResponse := h.request("GET", "/api/v1/me", "", cookies, nil, "")
	user := decodeResponse[api.User](t, meResponse, 200)
	if user.ID == "" || user.Email != nil || user.Name != nil || user.AvatarURL != nil || user.EmailVerified == nil || *user.EmailVerified {
		t.Fatalf("profile semantics: %+v", user)
	}
	if strings.Contains(meResponse.Body.String(), "github:") || strings.Contains(meResponse.Body.String(), "raw-secret") {
		t.Fatal("raw identity exposed")
	}
	empty := decodeResponse[api.PersonalAccessTokenList](t, h.request("GET", "/api/v1/me/tokens", "", cookies, nil, ""), 200)
	if empty.Items == nil || len(empty.Items) != 0 {
		t.Fatalf("empty tokens: %+v", empty)
	}
	minted := decodeResponse[api.CreatedPersonalAccessToken](t, h.request("POST", "/api/v1/me/tokens", `{"name":"CI agent","expiresAt":null}`, cookies, nil, h.auth.origin), 201)
	if !strings.HasPrefix(minted.Token, "dnpat_") || minted.ExpiresAt != nil {
		t.Fatalf("token: %+v", minted)
	}
	var stored []byte
	if err := h.database.Pool.QueryRow(context.Background(), `SELECT token_hash FROM personal_access_tokens WHERE id=$1`, minted.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256([]byte(minted.Token))
	if !bytes.Equal(stored, want[:]) {
		t.Fatal("token hash differs")
	}
	listResponse := h.request("GET", "/api/v1/me/tokens", "", cookies, nil, "")
	list := decodeResponse[api.PersonalAccessTokenList](t, listResponse, 200)
	if len(list.Items) != 1 || strings.Contains(listResponse.Body.String(), minted.Token) || strings.Contains(listResponse.Body.String(), "token_hash") {
		t.Fatal("PAT list exposed secret")
	}
	bearer := []string{"Bearer " + minted.Token}
	if got := h.request("GET", "/api/v1/me", "", nil, bearer, ""); got.Code != 200 {
		t.Fatalf("PAT authentication: %d %s", got.Code, got.Body)
	}
	if got := h.request("POST", "/mutation", "", cookies, bearer, "https://foreign.test"); got.Code != 204 {
		t.Fatalf("Bearer origin behavior: %d %s", got.Code, got.Body)
	}
	for _, call := range []struct{ method, path, body string }{{"GET", "/api/v1/me/tokens", ""}, {"POST", "/api/v1/me/tokens", `{"name":"nested","expiresAt":null}`}, {"DELETE", "/api/v1/me/tokens/" + minted.ID, ""}, {"POST", "/api/v1/auth/logout", ""}} {
		got := h.request(call.method, call.path, call.body, cookies, bearer, h.auth.origin)
		assertProjectError(t, got, 403, "forbidden")
	}
	for range 2 {
		if got := h.request("DELETE", "/api/v1/me/tokens/"+minted.ID, "", cookies, nil, h.auth.origin); got.Code != 204 {
			t.Fatalf("revoke: %d %s", got.Code, got.Body)
		}
	}
	assertProjectError(t, h.request("GET", "/api/v1/me", "", cookies, bearer, ""), 401, "unauthenticated")
	loggedOut := h.request("POST", "/api/v1/auth/logout", "", cookies, nil, h.auth.origin)
	if loggedOut.Code != 204 || loggedOut.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("logout failed")
	}
	assertProjectError(t, h.request("GET", "/api/v1/me", "", cookies, nil, ""), 401, "unauthenticated")
	for _, secret := range []string{cookie.Value, minted.Token, "app-secret-never-log", "raw-secret", "user-one"} {
		if strings.Contains(h.logs.String(), secret) {
			t.Fatalf("secret logged: %s", secret)
		}
	}
	if !strings.Contains(h.logs.String(), `"user_id":"`+user.ID+`"`) {
		t.Fatal("missing identity correlation")
	}
}

func TestIdentityHTTPOriginAndBearerPrecedence(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.login(t, "origin-user")
	cookies := []*http.Cookie{cookie}
	for _, origin := range []string{"", "null", "https://foreign.test", "http://127.0.0.1:8787/", "http://localhost:8787"} {
		assertProjectError(t, h.request("POST", "/mutation", "", cookies, nil, origin), 403, "forbidden")
	}
	for _, authorization := range [][]string{{""}, {"Basic abc"}, {"Bearer invalid"}, {"Bearer a", "Bearer b"}, {"Bearer a b"}, {"Bearer " + cookie.Value}} {
		assertProjectError(t, h.request("GET", "/api/v1/me", "", cookies, authorization, ""), 401, "unauthenticated")
	}
	assertProjectError(t, h.request("GET", "/api/v1/me", "", nil, nil, ""), 401, "unauthenticated")
	assertProjectError(t, h.request("GET", "/api/v1/me", "", []*http.Cookie{cookie, cookie}, nil, ""), 401, "unauthenticated")
	r := httptest.NewRequest("POST", "/mutation", nil)
	r.AddCookie(cookie)
	r.Header["Origin"] = []string{h.auth.origin, h.auth.origin}
	response := httptest.NewRecorder()
	h.handler.ServeHTTP(response, r)
	if response.Code != 403 {
		t.Fatalf("duplicate origin accepted: %d", response.Code)
	}
	if _, err := h.database.Pool.Exec(context.Background(), `UPDATE sessions SET created_at=now()-interval '8 days',expires_at=now()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, h.request("GET", "/api/v1/me", "", cookies, nil, ""), 401, "unauthenticated")
}

func TestIdentityHTTPResponsePrincipalProvenance(t *testing.T) {
	h := authTestHarness(t)
	aliceCookie := h.login(t, "principal-alice")
	aliceCookies := []*http.Cookie{aliceCookie}
	aliceResponse := h.request("GET", "/api/v1/me", "", aliceCookies, nil, "")
	alice := decodeResponse[api.User](t, aliceResponse, http.StatusOK)
	if aliceResponse.Header().Get("Daynight-User-ID") != alice.ID {
		t.Fatal("session response does not identify its authenticated principal")
	}

	bobCookie := h.login(t, "principal-bob")
	bobCookies := []*http.Cookie{bobCookie}
	bobResponse := h.request("GET", "/api/v1/me", "", bobCookies, nil, "")
	bob := decodeResponse[api.User](t, bobResponse, http.StatusOK)
	if bob.ID == alice.ID || bobResponse.Header().Get("Daynight-User-ID") != bob.ID {
		t.Fatal("account replacement reused the previous response principal")
	}

	minted := decodeResponse[api.CreatedPersonalAccessToken](t,
		h.request("POST", "/api/v1/me/tokens", `{"name":"principal-test","expiresAt":null}`, aliceCookies, nil, h.auth.origin), http.StatusCreated)
	bearer := []string{"Bearer " + minted.Token}
	patResponse := h.request("GET", "/api/v1/me", "", bobCookies, bearer, "")
	if user := decodeResponse[api.User](t, patResponse, http.StatusOK); user.ID != alice.ID || patResponse.Header().Get("Daynight-User-ID") != alice.ID {
		t.Fatal("response principal followed the cookie instead of the admitted bearer")
	}

	spoofed := httptest.NewRequest("GET", "/api/v1/me", nil)
	spoofed.AddCookie(aliceCookie)
	spoofed.Header.Set("Daynight-User-ID", bob.ID)
	spoofedResponse := httptest.NewRecorder()
	h.handler.ServeHTTP(spoofedResponse, spoofed)
	if user := decodeResponse[api.User](t, spoofedResponse, http.StatusOK); user.ID != alice.ID || spoofedResponse.Header().Get("Daynight-User-ID") != alice.ID {
		t.Fatal("request-supplied principal was echoed into the response")
	}

	mutation := h.request("POST", "/mutation", "", aliceCookies, nil, h.auth.origin)
	if mutation.Code != http.StatusNoContent || mutation.Header().Get("Daynight-User-ID") != alice.ID {
		t.Fatal("successful empty mutation response lost its principal")
	}
	invalid := h.request("POST", "/api/v1/me/tokens", `{}`, aliceCookies, nil, h.auth.origin)
	assertProjectError(t, invalid, http.StatusBadRequest, "invalid_input")
	forbidden := h.request("POST", "/api/v1/me/tokens", `{"name":"nested","expiresAt":null}`, bobCookies, bearer, h.auth.origin)
	assertProjectError(t, forbidden, http.StatusForbidden, "forbidden")
	for _, response := range []*httptest.ResponseRecorder{invalid, forbidden} {
		if response.Header().Get("Daynight-User-ID") != alice.ID {
			t.Fatal("authenticated resource error lost the actual principal")
		}
	}
	for _, response := range []*httptest.ResponseRecorder{
		h.request("GET", "/api/v1/me", "", nil, nil, ""),
		h.request("GET", "/api/v1/me", "", bobCookies, []string{"Bearer invalid"}, ""),
		h.request("POST", "/mutation", "", aliceCookies, nil, "https://foreign.test"),
	} {
		if response.Header().Get("Daynight-User-ID") != "" {
			t.Fatal("failed authentication exposed an unadmitted principal")
		}
	}
}

func TestIdentityHTTPCallbackFailures(t *testing.T) {
	h := authTestHarness(t)
	for _, destination := range []string{"/projects/project/tasks/task/attachments/docs/guide.md?tab=overview#details", "/invitations", "/device?user_code=ABCD-EFGH"} {
		for _, mode := range []string{"provider", "protocol-secret", "denied-secret"} {
			state, binding := h.start(t, destination)
			values := url.Values{"state": {state}}
			if mode == "provider" {
				values.Set("error", "provider_denied")
			} else {
				values.Set("code", mode)
			}
			before := h.claims.Load()
			result := h.request("GET", "/api/v1/auth/callback?"+values.Encode(), "", []*http.Cookie{binding}, nil, "")
			location, err := url.Parse(result.Header().Get("Location"))
			if result.Code != http.StatusSeeOther || err != nil || location.Path != "/login" || location.Query().Get("authError") != "login_failed" || location.Query().Get("returnPath") != destination || len(location.Query()) != 2 || len(result.Result().Cookies()) != 1 || result.Result().Cookies()[0].MaxAge != -1 {
				t.Fatalf("failed browser navigation lost its login state or destination: %d %s", result.Code, result.Body)
			}
			replay := h.request("GET", "/api/v1/auth/callback?"+values.Encode(), "", []*http.Cookie{binding}, nil, "")
			assertProjectError(t, replay, 401, "unauthenticated")
			want := int32(1)
			if mode == "provider" {
				want = 0
			}
			if h.claims.Load()-before != want {
				t.Fatal("one-time callback retried")
			}
		}
	}
	state, binding := h.start(t, "/")
	callback := "/api/v1/auth/callback?" + url.Values{"state": {state}, "code": {"user"}}.Encode()
	assertProjectError(t, h.request("GET", callback, "", nil, nil, ""), 401, "unauthenticated")
	wrong := *binding
	wrong.Value = "wrong"
	assertProjectError(t, h.request("GET", callback, "", []*http.Cookie{&wrong}, nil, ""), 401, "unauthenticated")
	if got := h.request("GET", callback, "", []*http.Cookie{binding}, nil, ""); got.Code != 303 {
		t.Fatal("wrong browser consumed pending")
	}
	for _, query := range []string{"state=x&state=y&code=z", "state=x&unknown=z", "state=x%zz"} {
		assertProjectError(t, h.request("GET", "/api/v1/auth/callback?"+query, "", nil, nil, ""), 400, "invalid_input")
	}
	for _, secret := range []string{"app-secret-never-log", "protocol-secret", "denied-secret", "raw-secret", "upstream-secret", "bad secret"} {
		if strings.Contains(h.logs.String(), secret) {
			t.Fatalf("failure secret logged: %s", secret)
		}
	}
	if !strings.Contains(h.logs.String(), `"cause":"protocol"`) || !strings.Contains(h.logs.String(), `"upstream_request_id":"upstream-request"`) {
		t.Fatal("protocol failure not classified/correlated")
	}
}

func TestIdentityHTTPDefaultLoginDestination(t *testing.T) {
	h := authTestHarness(t)
	state, binding := h.start(t, "")
	result := h.request(http.MethodGet, "/api/v1/auth/callback?"+url.Values{"state": {state}, "code": {"default-destination"}}.Encode(), "", []*http.Cookie{binding}, nil, "")
	if result.Code != http.StatusSeeOther || result.Header().Get("Location") != "/projects" {
		t.Fatal("login without a destination did not enter the project workspace")
	}
}

func TestIdentityHTTPSessionCreationFailureRetainsDestination(t *testing.T) {
	h := authTestHarness(t)
	if _, err := h.database.Pool.Exec(context.Background(), `ALTER TABLE sessions ADD CONSTRAINT reject_session CHECK (false)`); err != nil {
		t.Fatal(err)
	}
	const destination = "/device?user_code=ABCD-EFGH"
	state, binding := h.start(t, destination)
	result := h.request(http.MethodGet, "/api/v1/auth/callback?"+url.Values{"state": {state}, "code": {"session-failure"}}.Encode(), "", []*http.Cookie{binding}, nil, "")
	location, err := url.Parse(result.Header().Get("Location"))
	if result.Code != http.StatusSeeOther || err != nil || location.Path != "/login" || location.Query().Get("authError") != "login_failed" || location.Query().Get("returnPath") != destination {
		t.Fatal("session creation failure lost its validated login destination")
	}
	cookies := result.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != binding.Name || cookies[0].MaxAge != -1 {
		t.Fatal("session creation failure must clear only its consumed browser binding")
	}
	if !strings.Contains(h.logs.String(), `"cause":"database"`) {
		t.Fatal("session creation failure lost its database error classification")
	}
}

func TestIdentityHTTPInputAndOperationalFailures(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.login(t, "input-user")
	cookies := []*http.Cookie{cookie}
	for _, body := range []string{`{}`, `{"name":null}`, `{"name":""}`, `{"name":"ok","days":null}`, `{"name":"ok","days":"30"}`, `{"name":"ok","days":0}`, `{"name":"ok","days":366}`, `{"name":"ok","unknown":true}`, `invalid`} {
		assertProjectError(t, h.request("POST", "/api/v1/me/tokens", body, cookies, nil, h.auth.origin), 400, "invalid_input")
	}
	assertProjectError(t, h.request("DELETE", "/api/v1/me/tokens/invalid", "", cookies, nil, h.auth.origin), 400, "invalid_input")
	for _, path := range []string{"/api/v1/auth/login", "/api/v1/auth/login?provider=unknown", "/api/v1/auth/login?provider=github&returnPath=https://foreign.test", "/api/v1/auth/login?provider=github&returnPath=//foreign.test", "/api/v1/auth/login?provider=github&returnPath=%2Fapi%2Fv1%2Fauth%2Flogin", "/api/v1/auth/login?provider=github&returnPath=%2Flogin", "/api/v1/auth/login?provider=github&returnPath=%2Flogin%3FreturnPath%3D%2Fprojects", "/api/v1/auth/login?provider=github&unexpected=x"} {
		assertProjectError(t, h.request("GET", path, "", nil, nil, ""), 400, "invalid_input")
	}
	for _, path := range []string{"/api/v1/auth/login", "/api/v1/auth/callback"} {
		if got := h.request("HEAD", path, "", nil, nil, ""); got.Code != 405 {
			t.Fatal("HEAD consumed login")
		}
	}
	assertProjectError(t, h.request("PUT", "/api/v1/me", "", nil, nil, ""), http.StatusUnauthorized, "unauthenticated")
	if got := h.request("PUT", "/api/v1/me", "", cookies, nil, h.auth.origin); got.Code != 405 {
		t.Fatal("method routing")
	}
	if _, err := h.database.Pool.Exec(context.Background(), `DROP TABLE personal_access_tokens`); err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, h.request("GET", "/api/v1/me/tokens", "", cookies, nil, ""), 500, "internal_error")
	assertProjectError(t, h.request("POST", "/api/v1/me/tokens", `{"name":"fails","expiresAt":null}`, cookies, nil, h.auth.origin), 500, "internal_error")
	assertProjectError(t, h.request("DELETE", "/api/v1/me/tokens/00000000-0000-0000-0000-000000000001", "", cookies, nil, h.auth.origin), 500, "internal_error")
	if _, err := h.database.Pool.Exec(context.Background(), `DROP TABLE users`); err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, h.request("GET", "/api/v1/me", "", cookies, nil, ""), 500, "internal_error")
	if !strings.Contains(h.logs.String(), `"cause":"database"`) {
		t.Fatal("database fault not classified")
	}
}

func TestIdentityAuthenticationConfiguration(t *testing.T) {
	client, err := uniauth.New(uniauth.Config{BaseURL: "https://uniauth.example.com", AppID: "test", AppSecret: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	for _, test := range []struct {
		origin       string
		allow, valid bool
	}{
		{"https://daynight.example.com", false, true}, {"https://daynight.example.com", true, true}, {"http://localhost:8787", true, true}, {"http://127.0.0.1:8787", true, true}, {"http://[::1]:8787", true, true}, {"http://127.0.0.1:8787", false, false}, {"http://dev.localhost:8787", true, true}, {"http://localhost.example.com", true, true}, {"http://192.168.1.1", true, true}, {"https://example.com/", false, false}, {"https://example.com?x=1", false, false}, {"https://user@example.com", false, false}, {"https://example.com#secret", false, false}, {"invalid", false, false}, {"https://%zz", false, false}, {"https://example.com:443", false, false}, {"https://EXAMPLE.com", false, false}, {"https://:443", false, false}, {"https://example.com:65536", false, false}, {"https://example.com:", false, false}, {"https://example.com:0443", false, false}, {"http://127.0.0.1:80", true, false},
	} {
		identity := service.NewIdentity(nil, client, test.origin+"/api/v1/auth/callback")
		auth, err := NewAuthentication(identity, AuthConfig{PublicOrigin: test.origin, AllowHTTPTestOrigin: test.allow}, logger)
		if (err == nil) != test.valid {
			t.Fatalf("origin %s allow=%t: %v", test.origin, test.allow, err)
		}
		if err == nil && strings.HasPrefix(test.origin, "https:") {
			cookie := auth.cookie(auth.SessionCookieName(), "secret", time.Now(), 60)
			if cookie.Name != "__Host-daynight_session" || !cookie.Secure || cookie.Domain != "" || !strings.HasPrefix(auth.bindingCookieName("state"), "__Host-daynight_login_") {
				t.Fatal("HTTPS cookie contract")
			}
		}
	}
	_, err = NewAuthentication(service.NewIdentity(nil, client, "https://wrong.example/api/v1/auth/callback"), AuthConfig{PublicOrigin: "https://example.com"}, logger)
	if err == nil {
		t.Fatal("mismatched callback accepted")
	}
	for _, failure := range []struct {
		err  error
		kind string
	}{
		{&uniauth.RequestError{Cause: errors.New("secret")}, "network"},
		{&uniauth.ProtocolError{Reason: "identity_schema"}, "protocol"},
		{&uniauth.APIError{StatusCode: 410}, "protocol"},
	} {
		if got := ErrorKind(failure.err); got != failure.kind {
			t.Fatalf("kind %s want %s", got, failure.kind)
		}
	}
}

func TestIdentityHTTPUserDisappearsAfterCredentialAdmission(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.login(t, "removed-user")
	request := httptest.NewRequest("GET", "/api/v1/me", nil)
	request.AddCookie(cookie)
	principal, err := h.auth.AuthenticateRequest(request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.database.Pool.Exec(context.Background(), "DELETE FROM users WHERE id=$1", principal.UserID); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	h.auth.me(response, request, principal)
	decodeResponse[api.ErrorResponse](t, response, 401)
}
