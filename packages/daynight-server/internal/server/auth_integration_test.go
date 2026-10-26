package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

type identityIntegrationLogs struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (logs *identityIntegrationLogs) Write(value []byte) (int, error) {
	logs.mu.Lock()
	defer logs.mu.Unlock()
	return logs.buffer.Write(value)
}

func (logs *identityIntegrationLogs) count(value string) int {
	logs.mu.Lock()
	defer logs.mu.Unlock()
	return strings.Count(logs.buffer.String(), value)
}

func (logs *identityIntegrationLogs) contains(value string) bool {
	logs.mu.Lock()
	defer logs.mu.Unlock()
	return strings.Contains(logs.buffer.String(), value)
}

type identityIntegration struct {
	server        *httptest.Server
	gateway       string
	client        *uniauth.Client
	requests      *identityCLIRequests
	logs          *identityIntegrationLogs
	sessionCookie string
	callbackPath  string
	secrets       []string
}

func newIdentityIntegration(t *testing.T) *identityIntegration {
	t.Helper()
	return newIdentityIntegrationCallback(t, "/api/v1/auth/callback")
}

func newIdentityIntegrationCallback(t *testing.T, callbackPath string) *identityIntegration {
	t.Helper()
	database := projectTestStore(t)
	server := httptest.NewUnstartedServer(nil)
	t.Cleanup(server.Close)
	origin := "http://" + server.Listener.Addr().String()
	callback := origin + callbackPath
	logs := &identityIntegrationLogs{}
	ready := testauth.StartGatewayWithOutput(t, callback, logs)
	base := http.DefaultTransport.(*http.Transport).Clone()
	t.Cleanup(base.CloseIdleConnections)
	client, err := uniauth.New(uniauth.Config{BaseURL: ready.Origin, AppID: ready.AppID, AppSecret: ready.AppSecret, AllowLoopbackHTTP: true, HTTPClient: &http.Client{Timeout: 5 * time.Second, Transport: base}})
	if err != nil {
		t.Fatal("construct real UniAuth SDK client failed")
	}
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	config := configuredTestConfig()
	config.PublicOrigin, config.UniAuthURL = origin, ready.Origin
	config.UniAuthAppID, config.UniAuthAppSecret, config.UniAuthCallbackURL = ready.AppID, ready.AppSecret, callback
	config.AllowHTTPTestOrigin, config.AllowLoopbackHTTP = true, true
	handler, err := New(Dependencies{Store: database, Files: attachmentTestFiles(t)}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	requests := &identityCLIRequests{}
	server.Config.Handler = RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		observed := request.URL.Path == "/api/v1/projects"
		bearer := strings.HasPrefix(request.Header.Get("Authorization"), "Bearer ")
		if observed {
			requests.all.Add(1)
			if bearer {
				requests.bearer.Add(1)
			} else if request.Header.Get("Authorization") == "" {
				requests.anonymous.Add(1)
			}
		}
		response := &responseRecorder{ResponseWriter: w}
		handler.ServeHTTP(response, request)
		if observed && response.status == http.StatusUnauthorized {
			requests.unauthorized.Add(1)
		}
		if observed && bearer && response.status >= 200 && response.status < 300 {
			requests.authenticatedPAT.Add(1)
		}
	}))
	server.Start()
	return &identityIntegration{server: server, gateway: ready.Origin, client: client, requests: requests, logs: logs, sessionCookie: "daynight_session", callbackPath: callbackPath, secrets: []string{ready.AppSecret}}
}

func identityBrowser(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Jar: jar, Transport: transport, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func identityRequest(t *testing.T, browser *http.Client, method, address, body string, headers map[string]string, status int) (*http.Response, []byte) {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), method, address, strings.NewReader(body))
	if err != nil {
		t.Fatal("construct integration HTTP request failed")
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := browser.Do(request)
	if err != nil {
		t.Fatal("integration HTTP request failed")
	}
	data, readError := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	closeError := response.Body.Close()
	if readError != nil || closeError != nil {
		t.Fatal("read integration HTTP response failed")
	}
	if response.StatusCode != status {
		t.Fatalf("%s %s returned HTTP %d; want %d", method, request.URL.Path, response.StatusCode, status)
	}
	return response, data
}

func identityDecode[T any](t *testing.T, data []byte) T {
	t.Helper()
	var result T
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal("decode integration response failed")
	}
	return result
}

func (integration *identityIntegration) start(t *testing.T, browser *http.Client) *url.URL {
	t.Helper()
	response, _ := identityRequest(t, browser, http.MethodGet, integration.server.URL+"/api/v1/auth/login?provider=github&returnPath=%2Fprojects%3Fview%3Dtasks", "", nil, http.StatusSeeOther)
	authorization, err := response.Location()
	if err != nil || authorization.Scheme+"://"+authorization.Host != integration.gateway {
		t.Fatal("Daynight did not redirect to its real UniAuth gateway")
	}
	integration.secrets = append(integration.secrets, authorization.Query().Get("state"))
	response, _ = identityRequest(t, browser, http.MethodGet, authorization.String(), "", nil, http.StatusFound)
	upstream, err := response.Location()
	if err != nil || upstream.Scheme != "https" || upstream.Host != "github.com" || upstream.Path != "/login/oauth/authorize" || upstream.Query().Get("code_challenge_method") != "S256" || upstream.Query().Get("code_challenge") == "" {
		t.Fatal("real GitHub provider authorization or PKCE challenge changed")
	}
	if upstream.Query().Get("state") == authorization.Query().Get("state") {
		t.Fatal("UniAuth must own a separate browser-bound provider state")
	}
	integration.secrets = append(integration.secrets, upstream.Query().Get("state"))
	return upstream
}

func (integration *identityIntegration) providerCallback(t *testing.T, browser *http.Client, upstream *url.URL, persona string) *url.URL {
	t.Helper()
	values := url.Values{"state": {upstream.Query().Get("state")}}
	if persona == "denied" {
		values.Set("error", "access_denied")
	} else {
		values.Set("code", persona+":"+upstream.Query().Get("code_challenge"))
	}
	response, _ := identityRequest(t, browser, http.MethodGet, integration.gateway+"/auth/callback/github?"+values.Encode(), "", nil, http.StatusFound)
	callback, err := response.Location()
	if err != nil || callback.Scheme+"://"+callback.Host != integration.server.URL || callback.Path != integration.callbackPath {
		t.Fatal("UniAuth changed the registered Daynight callback")
	}
	if code := callback.Query().Get("code"); code != "" {
		integration.secrets = append(integration.secrets, code)
	}
	return callback
}

func (integration *identityIntegration) complete(t *testing.T, browser *http.Client, callback *url.URL) {
	t.Helper()
	response, _ := identityRequest(t, browser, http.MethodGet, callback.String(), "", nil, http.StatusSeeOther)
	if response.Header.Get("Location") != "/projects?view=tasks" {
		t.Fatal("successful login did not retain its main-site return path")
	}
	for _, cookie := range response.Cookies() {
		if cookie.Name == integration.sessionCookie {
			if !cookie.HttpOnly || cookie.Secure || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" || cookie.MaxAge <= 0 {
				t.Fatal("loopback session cookie attributes changed")
			}
			integration.secrets = append(integration.secrets, cookie.Value)
		}
	}
}

func (integration *identityIntegration) login(t *testing.T, browser *http.Client, persona string) api.User {
	t.Helper()
	integration.complete(t, browser, integration.providerCallback(t, browser, integration.start(t, browser), persona))
	_, data := identityRequest(t, browser, http.MethodGet, integration.server.URL+"/api/v1/me", "", nil, http.StatusOK)
	return identityDecode[api.User](t, data)
}

func TestAuthenticationUniAuthIdentityAndCredentials(t *testing.T) {
	integration := newIdentityIntegration(t)
	aliceBrowser, bobBrowser := identityBrowser(t), identityBrowser(t)
	alice := integration.login(t, aliceBrowser, "alice")
	bob := integration.login(t, bobBrowser, "bob")
	if alice.ID == "" || bob.ID == "" || alice.ID == bob.ID || alice.Email == nil || bob.Email == nil || *alice.Email != *bob.Email {
		t.Fatal("provider IDs must produce distinct local users even with the same email")
	}
	if alice.Name == nil || *alice.Name != "Alice" || alice.EmailVerified == nil || !*alice.EmailVerified || alice.AvatarURL == nil {
		t.Fatal("real GitHub profile was not projected to the local user")
	}
	updated := integration.login(t, aliceBrowser, "alice-updated")
	if updated.ID != alice.ID || updated.Name == nil || *updated.Name != "Alice Updated" || updated.Email == nil || *updated.Email != "refreshed@example.test" || updated.EmailVerified == nil || *updated.EmailVerified || updated.AvatarURL == nil || *updated.AvatarURL == *alice.AvatarURL {
		t.Fatal("repeat login did not refresh the existing user's full profile")
	}
	cleared := integration.login(t, aliceBrowser, "alice-null")
	if cleared.ID != alice.ID || cleared.Email != nil || cleared.EmailVerified != nil || cleared.Name != nil || cleared.AvatarURL != nil {
		t.Fatal("nullable upstream profile must clear old values without changing local identity")
	}
	_, data := identityRequest(t, bobBrowser, http.MethodGet, integration.server.URL+"/api/v1/me", "", nil, http.StatusOK)
	if !reflect.DeepEqual(identityDecode[api.User](t, data), bob) {
		t.Fatal("refreshing Alice changed Bob's same-email account")
	}
	origin := map[string]string{"Origin": integration.server.URL}
	identityRequest(t, aliceBrowser, http.MethodPost, integration.server.URL+"/api/v1/me/tokens", `{"name":"CLI acceptance","expiresAt":null}`, nil, http.StatusForbidden)
	_, data = identityRequest(t, aliceBrowser, http.MethodPost, integration.server.URL+"/api/v1/me/tokens", `{"name":"CLI acceptance","expiresAt":null}`, origin, http.StatusCreated)
	token := identityDecode[api.CreatedPersonalAccessToken](t, data)
	if token.ID == "" || !strings.HasPrefix(token.Token, "dnpat_") || token.Name != "CLI acceptance" || token.ExpiresAt != nil {
		t.Fatal("personal token creation contract changed")
	}
	integration.secrets = append(integration.secrets, token.Token)
	bearer := map[string]string{"Authorization": "Bearer " + token.Token}
	patBrowser := identityBrowser(t)
	_, data = identityRequest(t, patBrowser, http.MethodGet, integration.server.URL+"/api/v1/me", "", bearer, http.StatusOK)
	if !reflect.DeepEqual(identityDecode[api.User](t, data), cleared) {
		t.Fatal("PAT did not authenticate its owning user")
	}
	identityRequest(t, patBrowser, http.MethodGet, integration.server.URL+"/api/v1/me/tokens", "", bearer, http.StatusForbidden)
	identityRequest(t, patBrowser, http.MethodPost, integration.server.URL+"/api/v1/me/tokens", `{"name":"forbidden","expiresAt":null}`, bearer, http.StatusForbidden)
	identityRequest(t, aliceBrowser, http.MethodGet, integration.server.URL+"/api/v1/me", "", map[string]string{"Authorization": "Bearer invalid"}, http.StatusUnauthorized)
	_, data = identityRequest(t, aliceBrowser, http.MethodGet, integration.server.URL+"/api/v1/me/tokens", "", nil, http.StatusOK)
	listed := identityDecode[api.PersonalAccessTokenList](t, data)
	if len(listed.Items) != 1 || listed.Items[0].ID != token.ID || bytes.Contains(data, []byte(token.Token)) {
		t.Fatal("token list must expose only its owner's token metadata")
	}
	identityRequest(t, aliceBrowser, http.MethodDelete, integration.server.URL+"/api/v1/me/tokens/"+token.ID, "", origin, http.StatusNoContent)
	identityRequest(t, patBrowser, http.MethodGet, integration.server.URL+"/api/v1/me", "", bearer, http.StatusUnauthorized)
	identityRequest(t, aliceBrowser, http.MethodPost, integration.server.URL+"/api/v1/auth/logout", "", origin, http.StatusNoContent)
	identityRequest(t, aliceBrowser, http.MethodGet, integration.server.URL+"/api/v1/me", "", nil, http.StatusUnauthorized)
	for _, secret := range integration.secrets {
		if secret != "" && integration.logs.contains(secret) {
			t.Fatal("authentication logs exposed a credential or OAuth handover value")
		}
	}
}

func TestAuthenticationProvidersAndConfiguredCallbackUseProductionMux(t *testing.T) {
	integration := newIdentityIntegrationCallback(t, "/auth/callback")
	browser := identityBrowser(t)
	_, data := identityRequest(t, browser, http.MethodGet, integration.server.URL+"/api/v1/auth/providers", "", nil, http.StatusOK)
	providers := identityDecode[struct {
		Providers []string `json:"providers"`
	}](t, data)
	if !reflect.DeepEqual(providers.Providers, []string{"github"}) {
		t.Fatal("production provider discovery must return the actual App/provider intersection")
	}
	integration.login(t, browser, "alice")
	identityRequest(t, browser, http.MethodGet, integration.server.URL+"/api/v1/auth/callback", "", nil, http.StatusNotFound)
	identityRequest(t, browser, http.MethodGet, integration.server.URL+"/api/v1/auth/login?provider=github&returnPath=%2Fauth%2Fcallback", "", nil, http.StatusBadRequest)
	identityRequest(t, browser, http.MethodHead, integration.server.URL+"/auth/callback", "", nil, http.StatusMethodNotAllowed)
}

func TestAuthenticationUniAuthBrowserBindingAndConsumption(t *testing.T) {
	integration := newIdentityIntegration(t)
	browser, stranger := identityBrowser(t), identityBrowser(t)
	callback := integration.providerCallback(t, browser, integration.start(t, browser), "alice")
	before := integration.logs.count("type=fixture_result_request")
	identityRequest(t, stranger, http.MethodGet, callback.String(), "", nil, http.StatusUnauthorized)
	identityRequest(t, stranger, http.MethodGet, integration.server.URL+"/api/v1/me", "", nil, http.StatusUnauthorized)
	if integration.logs.count("type=fixture_result_request") != before {
		t.Fatal("an unbound callback retrieved the gateway result")
	}
	integration.complete(t, browser, callback)
	if integration.logs.count("type=fixture_result_request") != before+1 {
		t.Fatal("a bound login must retrieve its one-time gateway result exactly once")
	}
	identityRequest(t, browser, http.MethodGet, callback.String(), "", nil, http.StatusUnauthorized)
	if integration.logs.count("type=fixture_result_request") != before+1 {
		t.Fatal("a repeated Daynight callback retrieved the result again")
	}
	_, err := integration.client.Retrieve(t.Context(), callback.Query().Get("code"))
	var unavailable *uniauth.APIError
	if !errors.As(err, &unavailable) || unavailable.StatusCode != http.StatusGone || unavailable.Code != "result_unavailable" {
		t.Fatal("real UniAuth result remained available after Daynight consumed it")
	}
	deniedBrowser := identityBrowser(t)
	denied := integration.providerCallback(t, deniedBrowser, integration.start(t, deniedBrowser), "denied")
	if denied.Query().Get("error") == "" || denied.Query().Get("code") != "" {
		t.Fatal("real provider denial did not become a gateway error callback")
	}
	mainURL, err := url.Parse(integration.server.URL)
	if err != nil {
		t.Fatal(err)
	}
	bindings := deniedBrowser.Jar.Cookies(mainURL)
	before = integration.logs.count("type=fixture_result_request")
	response, _ := identityRequest(t, deniedBrowser, http.MethodGet, denied.String(), "", nil, http.StatusSeeOther)
	if response.Header.Get("Location") != "/login?authError=login_failed&returnPath=%2Fprojects%3Fview%3Dtasks" {
		t.Fatal("provider denial did not produce the generic login failure")
	}
	identityRequest(t, deniedBrowser, http.MethodGet, integration.server.URL+"/api/v1/me", "", nil, http.StatusUnauthorized)
	deniedBrowser.Jar.SetCookies(mainURL, bindings)
	identityRequest(t, deniedBrowser, http.MethodGet, denied.String(), "", nil, http.StatusUnauthorized)
	if integration.logs.count("type=fixture_result_request") != before {
		t.Fatal("provider denial or its replay retrieved an identity result")
	}
	for _, secret := range integration.secrets {
		if secret != "" && integration.logs.contains(secret) {
			t.Fatal("authentication logs exposed a credential or OAuth handover value")
		}
	}
}
