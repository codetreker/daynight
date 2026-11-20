package auth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
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
	createResponse := createScopedHTTPPAT(t, h, cookie, "CI agent", nil)
	minted := testsupport.DecodeResponse[api.CreatedPersonalAccessToken](t, createResponse, 201)
	if !strings.Contains(createResponse.Body.String(), `"lastUsedAt":null`) {
		t.Fatal("created PAT must contain null lastUsedAt")
	}
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
	usedAt := time.Now().UTC().Truncate(time.Microsecond)
	completion, err := h.Database.WriteCredentialUsage(t.Context(), []model.CredentialUsageEvent{{Kind: model.UsageSubjectPAT, UserID: user.ID, SubjectID: minted.ID, At: usedAt}})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("write usage: %+v %v", completion, err)
	}
	listResponse := h.Request("GET", "/api/v1/me/tokens", "", cookies, nil, "")
	list := testsupport.DecodeResponse[api.PersonalAccessTokenList](t, listResponse, 200)
	if len(list.Items) != 1 || strings.Contains(listResponse.Body.String(), minted.Token) || strings.Contains(listResponse.Body.String(), "token_hash") || list.Items[0].LastUsedAt == nil || !list.Items[0].LastUsedAt.Equal(usedAt) || !strings.Contains(listResponse.Body.String(), `"lastUsedAt":"`+usedAt.Format(time.RFC3339Nano)+`"`) {
		t.Fatal("PAT list exposed secret")
	}
	bearer := []string{"Bearer " + minted.Token}
	if got := h.Request("GET", "/api/v1/me", "", nil, bearer, ""); got.Code != 200 {
		t.Fatalf("PAT authentication: %d %s", got.Code, got.Body)
	}
	if got := h.Request("POST", "/mutation", "", cookies, bearer, "https://foreign.test"); got.Code != 204 {
		t.Fatalf("Bearer origin behavior: %d %s", got.Code, got.Body)
	}
	for _, call := range []struct{ method, path, body string }{{"GET", "/api/v1/me/tokens", ""}, {"POST", "/api/v2/me/tokens", `{"name":"nested","expiresAt":null}`}, {"DELETE", "/api/v1/me/tokens/" + minted.ID, ""}, {"POST", "/api/v1/auth/logout", ""}} {
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
	h := newStrictAuthHTTP(t)
	actor, _ := authRequestAccount(1)
	cookie := h.cookie(authAliceCookie)
	cookies := []*http.Cookie{cookie}
	authenticated := expectAuthentication(actor, cookie.Value)
	for _, origin := range []string{"", "null", "https://foreign.test", "http://127.0.0.1:8787/", "http://localhost:8787"} {
		response := h.request("POST", "/mutation", "", cookies, nil, origin, authenticated)
		testsupport.AssertProjectError(t, response, http.StatusForbidden, "forbidden")
		if response.Header().Get("Daynight-User-ID") != "" {
			t.Fatalf("rejected Origin %q exposed a principal", origin)
		}
	}
	for _, test := range []struct {
		authorization []string
		pending       []authRequestCall
	}{
		{authorization: []string{""}},
		{authorization: []string{"Basic abc"}},
		{authorization: []string{"Bearer invalid"}, pending: []authRequestCall{expectRejectedCredential(model.PATCredential, "invalid")}},
		{authorization: []string{"Bearer a", "Bearer b"}},
		{authorization: []string{"Bearer a b"}},
		{authorization: []string{"Bearer " + cookie.Value}, pending: []authRequestCall{expectRejectedCredential(model.PATCredential, cookie.Value)}},
	} {
		response := h.request("GET", "/api/v1/me", "", cookies, test.authorization, "", test.pending...)
		testsupport.AssertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
		if response.Header().Get("Daynight-User-ID") != "" {
			t.Fatal("rejected Authorization exposed a principal")
		}
	}
	testsupport.AssertProjectError(t, h.request("GET", "/api/v1/me", "", nil, nil, ""), http.StatusUnauthorized, "unauthenticated")
	testsupport.AssertProjectError(t, h.request("GET", "/api/v1/me", "", []*http.Cookie{cookie, cookie}, nil, ""), http.StatusUnauthorized, "unauthenticated")
	request := httptest.NewRequest("POST", "/mutation", nil)
	request.AddCookie(cookie)
	request.Header["Origin"] = []string{authRequestOrigin, authRequestOrigin}
	testsupport.AssertProjectError(t, h.serve(request, authenticated), http.StatusForbidden, "forbidden")
	expired := h.request("GET", "/api/v1/me", "", cookies, nil, "",
		expectRejectedCredential(model.SessionCredential, cookie.Value))
	testsupport.AssertProjectError(t, expired, http.StatusUnauthorized, "unauthenticated")
}

func TestIdentityHTTPResponsePrincipalProvenance(t *testing.T) {
	h := newStrictAuthHTTP(t)
	aliceActor, aliceProfile := authRequestAccount(1)
	bobActor, bobProfile := authRequestAccount(2)
	aliceCookie, bobCookie := h.cookie(authAliceCookie), h.cookie(authBobCookie)
	aliceCookies, bobCookies := []*http.Cookie{aliceCookie}, []*http.Cookie{bobCookie}
	aliceSession := expectAuthentication(aliceActor, aliceCookie.Value)
	bobSession := expectAuthentication(bobActor, bobCookie.Value)
	aliceResponse := h.request("GET", "/api/v1/me", "", aliceCookies, nil, "", aliceSession, expectUser(aliceActor, aliceProfile))
	alice := testsupport.DecodeResponse[api.User](t, aliceResponse, http.StatusOK)
	if alice.ID != aliceActor.UserID || aliceResponse.Header().Get("Daynight-User-ID") != alice.ID {
		t.Fatal("session response does not identify its authenticated principal")
	}
	bobResponse := h.request("GET", "/api/v1/me", "", bobCookies, nil, "", bobSession, expectUser(bobActor, bobProfile))
	bob := testsupport.DecodeResponse[api.User](t, bobResponse, http.StatusOK)
	if bob.ID != bobActor.UserID || bob.ID == alice.ID || bobResponse.Header().Get("Daynight-User-ID") != bob.ID {
		t.Fatal("account replacement reused the previous response principal")
	}

	mintedFact := authRequestMintedPAT(aliceActor, "principal-test")
	minted := testsupport.DecodeResponse[api.CreatedPersonalAccessToken](t,
		h.request("POST", "/api/v1/me/tokens", `{"name":"principal-test","expiresAt":null}`, aliceCookies, nil, authRequestOrigin,
			aliceSession, authRequestCall{name: "CreatePAT", args: []any{aliceActor, identitycore.CreatePAT{Name: "principal-test"}}, result: mintedFact}),
		http.StatusCreated)
	if minted.ID != mintedFact.Credential.ID || minted.Token != mintedFact.Secret {
		t.Fatal("mint response changed the PAT")
	}
	pat := model.Principal{Kind: model.PATCredential, UserID: alice.ID, CredentialID: minted.ID}
	patAdmission := expectAuthentication(pat, minted.Token)
	bearer := []string{"Bearer " + minted.Token}
	patResponse := h.request("GET", "/api/v1/me", "", bobCookies, bearer, "", patAdmission, expectUser(pat, aliceProfile))
	if user := testsupport.DecodeResponse[api.User](t, patResponse, http.StatusOK); user.ID != alice.ID || patResponse.Header().Get("Daynight-User-ID") != alice.ID {
		t.Fatal("response principal followed the cookie instead of the admitted bearer")
	}

	spoofed := httptest.NewRequest("GET", "/api/v1/me", nil)
	spoofed.AddCookie(aliceCookie)
	spoofed.Header.Set("Daynight-User-ID", bob.ID)
	spoofedResponse := h.serve(spoofed, aliceSession, expectUser(aliceActor, aliceProfile))
	if user := testsupport.DecodeResponse[api.User](t, spoofedResponse, http.StatusOK); user.ID != alice.ID || spoofedResponse.Header().Get("Daynight-User-ID") != alice.ID {
		t.Fatal("request-supplied principal was echoed into the response")
	}

	mutation := h.request("POST", "/mutation", "", aliceCookies, nil, authRequestOrigin, aliceSession,
		authRequestCall{name: "mutation", args: []any{aliceActor}})
	if mutation.Code != http.StatusNoContent || mutation.Body.Len() != 0 || mutation.Header().Get("Daynight-User-ID") != alice.ID {
		t.Fatal("successful empty mutation response lost its principal")
	}
	invalid := h.request("POST", "/api/v1/me/tokens", `{}`, aliceCookies, nil, authRequestOrigin, aliceSession)
	testsupport.AssertProjectError(t, invalid, http.StatusBadRequest, "invalid_input")
	refusal := &model.Fault{Code: "forbidden", Message: "A main-site browser session is required for this operation."}
	forbidden := h.request("POST", "/api/v1/me/tokens", `{"name":"nested","expiresAt":null}`, bobCookies, bearer, authRequestOrigin,
		patAdmission, authRequestCall{name: "CreatePAT", args: []any{pat, identitycore.CreatePAT{Name: "nested"}}, err: refusal})
	testsupport.AssertProjectError(t, forbidden, http.StatusForbidden, "forbidden")
	for _, response := range []*httptest.ResponseRecorder{invalid, forbidden} {
		if response.Header().Get("Daynight-User-ID") != alice.ID {
			t.Fatal("authenticated resource error lost the actual principal")
		}
	}
	for _, response := range []*httptest.ResponseRecorder{
		h.request("GET", "/api/v1/me", "", nil, nil, ""),
		h.request("GET", "/api/v1/me", "", bobCookies, []string{"Bearer invalid"}, "", expectRejectedCredential(model.PATCredential, "invalid")),
		h.request("POST", "/mutation", "", aliceCookies, nil, "https://foreign.test", aliceSession),
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
	response := completeStrictLogin(t, "", "/projects", "default-destination")
	if response.Header().Get("Location") != "/auth/complete?callbackPath=%2Fapi%2Fv1%2Fauth%2Fcallback&returnPath=%2Fprojects" {
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
	h := newStrictAuthHTTP(t)
	actor, _ := authRequestAccount(1)
	cookie := h.cookie(authAliceCookie)
	cookies := []*http.Cookie{cookie}
	admit := expectAuthentication(actor, cookie.Value)
	for _, body := range []string{`{}`, `{"name":null}`, `{"name":""}`, `{"name":"ok","days":null}`, `{"name":"ok","days":"30"}`, `{"name":"ok","days":0}`, `{"name":"ok","days":366}`, `{"name":"ok","unknown":true}`, `invalid`} {
		response := h.request("POST", "/api/v1/me/tokens", body, cookies, nil, authRequestOrigin, admit)
		testsupport.AssertProjectError(t, response, http.StatusBadRequest, "invalid_input")
	}
	invalid := &model.Fault{Code: "invalid_input", Message: "Invalid token input."}
	response := h.request("POST", "/api/v1/me/tokens", `{"name":"","expiresAt":null}`, cookies, nil, authRequestOrigin, admit,
		authRequestCall{name: "CreatePAT", args: []any{actor, identitycore.CreatePAT{Name: ""}}, err: invalid})
	testsupport.AssertProjectError(t, response, http.StatusBadRequest, "invalid_input")
	response = h.request("DELETE", "/api/v1/me/tokens/invalid", "", cookies, nil, authRequestOrigin, admit,
		authRequestCall{name: "RevokePAT", args: []any{actor, "invalid"}, err: invalid})
	testsupport.AssertProjectError(t, response, http.StatusBadRequest, "invalid_input")

	invalidLogin := &model.Fault{Code: "invalid_input", Message: "Invalid login input."}
	for _, test := range []struct {
		path, provider, returnPath string
	}{
		{"/api/v1/auth/login", "", ""},
		{"/api/v1/auth/login?provider=unknown", "unknown", ""},
		{"/api/v1/auth/login?provider=github&returnPath=https://foreign.test", "github", "https://foreign.test"},
		{"/api/v1/auth/login?provider=github&returnPath=//foreign.test", "github", "//foreign.test"},
		{"/api/v1/auth/login?provider=github&returnPath=%2Fapi%2Fv1%2Fauth%2Flogin", "github", "/api/v1/auth/login"},
		{"/api/v1/auth/login?provider=github&returnPath=%2Flogin", "github", "/login"},
		{"/api/v1/auth/login?provider=github&returnPath=%2Flogin%3FreturnPath%3D%2Fprojects", "github", "/login?returnPath=/projects"},
	} {
		response := h.request("GET", test.path, "", nil, nil, "",
			authRequestCall{name: "ValidateLogin", args: []any{test.provider, test.returnPath}, err: invalidLogin})
		testsupport.AssertProjectError(t, response, http.StatusBadRequest, "invalid_input")
	}
	testsupport.AssertProjectError(t, h.request("GET", "/api/v1/auth/login?provider=github&unexpected=x", "", nil, nil, ""), http.StatusBadRequest, "invalid_input")
	for _, path := range []string{"/api/v1/auth/login", "/api/v1/auth/callback"} {
		response := h.request("HEAD", path, "", nil, nil, "")
		if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET" {
			t.Fatalf("HEAD %s: status=%d Allow=%q", path, response.Code, response.Header().Get("Allow"))
		}
	}
	testsupport.AssertProjectError(t, h.request("PUT", "/api/v1/me", "", nil, nil, ""), http.StatusUnauthorized, "unauthenticated")
	response = h.request("PUT", "/api/v1/me", "", cookies, nil, authRequestOrigin, admit)
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "GET, HEAD, PATCH" ||
		response.Header().Get("Daynight-User-ID") != actor.UserID {
		t.Fatalf("authenticated method fallback: status=%d headers=%v", response.Code, response.Header())
	}

	const tokenID = "00000000-0000-0000-0000-000000000001"
	for _, test := range []struct {
		method, path, body, origin string
		pending                    []authRequestCall
		admitted                   string
	}{
		{"GET", "/api/v1/me/tokens", "", "", []authRequestCall{admit, {name: "ListPATs", args: []any{actor}, err: authMissingRelation("list tokens")}}, actor.UserID},
		{"POST", "/api/v1/me/tokens", `{"name":"fails","expiresAt":null}`, authRequestOrigin, []authRequestCall{
			admit, {name: "CreatePAT", args: []any{actor, identitycore.CreatePAT{Name: "fails"}}, err: authMissingRelation("create token")},
		}, actor.UserID},
		{"DELETE", "/api/v1/me/tokens/" + tokenID, "", authRequestOrigin, []authRequestCall{
			admit, {name: "RevokePAT", args: []any{actor, tokenID}, err: authMissingRelation("revoke token")},
		}, actor.UserID},
		{"GET", "/api/v1/me", "", "", []authRequestCall{
			{name: "Authenticate", args: []any{model.SessionCredential, cookie.Value}, err: authMissingRelation("authenticate")},
		}, ""},
	} {
		h.logs.Reset()
		response := h.request(test.method, test.path, test.body, cookies, nil, test.origin, test.pending...)
		testsupport.AssertProjectError(t, response, http.StatusInternalServerError, "internal_error")
		if response.Header().Get("Daynight-User-ID") != test.admitted || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s %s failure has incorrect admission or cache headers: %v", test.method, test.path, response.Header())
		}
		if !strings.Contains(h.logs.String(), `"cause":"database"`) {
			t.Fatalf("%s %s lost operational error classification", test.method, test.path)
		}
	}
}

func TestIdentityHTTPUserDisappearsAfterCredentialAdmission(t *testing.T) {
	h := newStrictAuthHTTP(t)
	actor, _ := authRequestAccount(1)
	cookie := h.cookie(authAliceCookie)
	response := h.request("GET", "/api/v1/me", "", []*http.Cookie{cookie}, nil, "",
		expectAuthentication(actor, cookie.Value),
		authRequestCall{name: "User", args: []any{actor}, err: model.Unauthenticated(model.ErrNotFound)},
	)
	testsupport.AssertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
	if response.Header().Get("Daynight-User-ID") != actor.UserID || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("ETag") != "" {
		t.Fatalf("missing admitted User returned incorrect headers: %v", response.Header())
	}
}

func TestIdentityHTTPLoginReturnsToTestSessionDeepLink(t *testing.T) {
	const destination = "/test-sessions/10000000-0000-4000-8000-000000000001"
	response := completeStrictLogin(t, destination, destination, "test-session-owner")
	if response.Header().Get("Location") != "/auth/complete?"+(url.Values{"returnPath": {destination}, "callbackPath": {"/api/v1/auth/callback"}}).Encode() {
		t.Fatalf("login lost Test Session destination: %d %s", response.Code, response.Header().Get("Location"))
	}
}

func TestIdentityHTTPPATExpiryAndCookieLogoutAreIndependent(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.Login(t, "credential-independence")
	cookies := []*http.Cookie{cookie}
	user := testsupport.DecodeResponse[api.User](t, h.Request(http.MethodGet, "/api/v1/me", "", cookies, nil, ""), http.StatusOK)
	mint := func(name string) api.CreatedPersonalAccessToken {
		t.Helper()
		return testsupport.DecodeResponse[api.CreatedPersonalAccessToken](t, createScopedHTTPPAT(t, h, cookie, name, nil), http.StatusCreated)
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

// completionIdentity isolates the HTTP adapter while keeping the real request parser and router.
type completionIdentity struct {
	*strictIdentity
	complete func(context.Context, url.Values, string) (identitycore.LoginCompletion, error)
}

func (i *completionIdentity) CompleteLogin(ctx context.Context, values url.Values, binding string) (identitycore.LoginCompletion, error) {
	return i.complete(ctx, values, binding)
}

func TestCallbackNavigatesThroughCompletion(t *testing.T) {
	for _, destination := range []string{"/", "/setup?lang=zh#guide", "/projects/p?tab=tasks#item", "/assets/app.js?x=%252F#part", "%2Fprojects?view=1#part"} {
		t.Run(destination, func(t *testing.T) {
			calls := 0
			identity := &completionIdentity{strictIdentity: &strictIdentity{t: t, callback: func() string { return "https://daynight.example/auth/callback" }}}
			identity.complete = func(_ context.Context, values url.Values, binding string) (identitycore.LoginCompletion, error) {
				calls++
				if values.Get("state") != "state" || values.Get("code") != "private-code" || binding != "browser-binding" {
					t.Fatalf("callback arguments: %v %q", values, binding)
				}
				return identitycore.LoginCompletion{LoginID: "login", User: model.User{ID: "private-user"}, Session: model.Session{ID: "private-session", ExpiresAt: time.Now().Add(time.Hour)}, Secret: "private-secret", ReturnPath: destination}, nil
			}
			h, err := NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			if err != nil {
				t.Fatal(err)
			}
			mux := http.NewServeMux()
			h.RegisterRoutes(mux)
			request := httptest.NewRequest(http.MethodGet, "/auth/callback?state=state&code=private-code", nil)
			request.AddCookie(&http.Cookie{Name: h.bindingCookieName("state"), Value: "browser-binding"})
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, request)
			location, err := url.Parse(response.Header().Get("Location"))
			if err != nil || response.Code != http.StatusSeeOther || location.Path != "/auth/complete" || location.Fragment != "" || len(location.Query()) != 2 || len(location.Query()["callbackPath"]) != 1 || location.Query().Get("callbackPath") != "/auth/callback" || len(location.Query()["returnPath"]) != 1 || location.Query().Get("returnPath") != destination || calls != 1 {
				t.Fatalf("completion navigation: %d %q calls=%d err=%v", response.Code, response.Header().Get("Location"), calls, err)
			}
			for _, private := range []string{"private-code", "private-user", "private-session", "private-secret"} {
				if strings.Contains(response.Header().Get("Location"), private) {
					t.Fatalf("Location exposed %s", private)
				}
			}
			cookies := response.Result().Cookies()
			if len(cookies) != 2 || cookies[0].Name != h.bindingCookieName("state") || cookies[0].MaxAge != -1 || cookies[1].Name != h.SessionCookieName() || cookies[1].Value != "private-secret" || !cookies[1].Secure || !cookies[1].HttpOnly || cookies[1].SameSite != http.SameSiteLaxMode || cookies[1].Path != "/" {
				t.Fatalf("callback cookies: %+v", cookies)
			}
		})
	}
}

func TestCallbackStartsPreviewAfterIssuingMainSession(t *testing.T) {
	identity := &completionIdentity{strictIdentity: &strictIdentity{t: t, callback: func() string { return "https://daynight.example/auth/callback" }}}
	identity.complete = func(_ context.Context, _ url.Values, _ string) (identitycore.LoginCompletion, error) {
		return identitycore.LoginCompletion{LoginID: "login", Session: model.Session{ExpiresAt: time.Now().Add(time.Hour)}, Secret: "secret", ReturnPath: "/projects?view=1#part"}, nil
	}
	h, err := NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	h.BindPreviewLogin(func(w http.ResponseWriter, _ *http.Request, target string) {
		calls++
		want := "https://daynight.example/auth/complete?" + (url.Values{"returnPath": {"/projects?view=1#part"}, "callbackPath": {"/auth/callback"}}).Encode()
		if target != want || !strings.Contains(w.Header().Get("Set-Cookie"), "daynight_login_") || len(w.Header().Values("Set-Cookie")) != 2 {
			t.Fatalf("target %q, cookies %v", target, w.Header().Values("Set-Cookie"))
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	r := httptest.NewRequest(http.MethodGet, "/auth/callback?state=state&code=code", nil)
	r.AddCookie(&http.Cookie{Name: h.bindingCookieName("state"), Value: "binding"})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if calls != 1 || w.Code != http.StatusServiceUnavailable {
		t.Fatalf("preview hook calls=%d status=%d", calls, w.Code)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 2 || cookies[1].Name != h.SessionCookieName() || cookies[1].Value != "secret" {
		t.Fatalf("main session lost after SSO failure: %+v", cookies)
	}
}

func TestCallbackPreservesActualEscapedBase(t *testing.T) {
	identity := &completionIdentity{strictIdentity: &strictIdentity{t: t, callback: func() string { return "https://daynight.example/custom/callback" }}}
	identity.complete = func(_ context.Context, _ url.Values, _ string) (identitycore.LoginCompletion, error) {
		return identitycore.LoginCompletion{LoginID: "login", Session: model.Session{ExpiresAt: time.Now().Add(time.Hour)}, Secret: "secret", ReturnPath: "%2Fprojects?view=1#part"}, nil
	}
	h, err := NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	for _, actual := range []string{"/custom/callback", "/cu%73tom/callback"} {
		request := httptest.NewRequest(http.MethodGet, actual+"?state=state&code=code", nil)
		request.AddCookie(&http.Cookie{Name: h.bindingCookieName("state"), Value: "binding"})
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		location, err := url.Parse(response.Header().Get("Location"))
		if err != nil || response.Code != http.StatusSeeOther || location.Path != "/auth/complete" || location.Query().Get("callbackPath") != actual || location.Query().Get("returnPath") != "%2Fprojects?view=1#part" {
			t.Fatalf("callback base: %s %d %q %v", actual, response.Code, response.Header().Get("Location"), err)
		}
	}
}
