package server

import (
	"bytes"
	"context"
	"encoding/json"
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

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
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
	plan          *identityHTTPPlan
	server        *httptest.Server
	gateway       string
	client        *uniauth.Client
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
	database, plan := newIdentityHTTPPlan(t)
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
	config.Server.PublicOrigin, config.UniAuth.URL = origin, ready.Origin
	config.UniAuth.AppID, config.UniAuth.AppSecret, config.UniAuth.CallbackURL = ready.AppID, ready.AppSecret, callback
	config.Server.AllowHTTPTestOrigin, config.UniAuth.AllowLoopbackHTTP = true, true
	handler, err := newTestHandler(Dependencies{Store: database, Files: attachmentTestFiles(t)}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := handler.(Handler).Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	server.Config.Handler = httpx.RequestLogging(logger, handler)
	server.Start()
	return &identityIntegration{plan: plan, server: server, gateway: ready.Origin, client: client, logs: logs, sessionCookie: "daynight_session", callbackPath: callbackPath, secrets: []string{ready.AppSecret}}
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
	write := integration.plan.start()
	loginURL := integration.server.URL + "/api/v1/auth/login?provider=github&returnPath=%2Fprojects%3Fview%3Dtasks"
	response, _ := identityRequest(t, browser, http.MethodGet, loginURL, "", nil, http.StatusSeeOther)
	if response.Header.Get("Location") == "/api/v1/auth/login?provider=github&returnPath=%2Fprojects%3Fview%3Dtasks" {
		response, _ = identityRequest(t, browser, http.MethodGet, loginURL, "", nil, http.StatusSeeOther)
	}
	authorization, err := response.Location()
	if err != nil || authorization.Scheme+"://"+authorization.Host != integration.gateway {
		t.Fatal("Daynight did not redirect to its real UniAuth gateway")
	}
	state := authorization.Query().Get("state")
	pending := write.value()
	identityHTTPCheck(t, bytes.Equal(pending.StateHash, secret.Hash(state)) && bytes.Equal(pending.ScopeHash, secret.Hash(identityCookie(t, browser, integration.server.URL, "daynight_login_scope"))) && bytes.Equal(pending.BrowserBindingHash, secret.Hash(identityCookie(t, browser, integration.server.URL, identityHTTPBinding(state)))), "login wire hashes differ from write arguments")
	integration.secrets = append(integration.secrets, state)
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
	integration.completeFor(t, browser, callback, "alice")
}

func (integration *identityIntegration) completeFor(t *testing.T, browser *http.Client, callback *url.URL, persona string) {
	t.Helper()
	integration.plan.consume(callback.Query().Get("state"), identityCookie(t, browser, integration.server.URL, identityHTTPBinding(callback.Query().Get("state"))), true)
	integration.plan.complete(persona)
	response, _ := identityRequest(t, browser, http.MethodGet, callback.String(), "", nil, http.StatusSeeOther)
	if response.Header.Get("Location") != "/projects?view=tasks" {
		t.Fatal("successful login did not retain its main-site return path")
	}
	for _, cookie := range response.Cookies() {
		if cookie.Name == integration.sessionCookie {
			draft := integration.plan.sessionWrite()
			identityHTTPCheck(t, bytes.Equal(draft.TokenHash, secret.Hash(cookie.Value)), "session response/write credential identity")
			if !cookie.HttpOnly || cookie.Secure || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" || cookie.MaxAge <= 0 {
				t.Fatal("loopback session cookie attributes changed")
			}
			integration.secrets = append(integration.secrets, cookie.Value)
		}
	}
}

func (integration *identityIntegration) login(t *testing.T, browser *http.Client, persona string) api.User {
	t.Helper()
	integration.completeFor(t, browser, integration.providerCallback(t, browser, integration.start(t, browser), persona), persona)
	integration.me(t, browser, identityHTTPUser(persona), nil)
	_, data := identityRequest(t, browser, http.MethodGet, integration.server.URL+"/api/v1/me", "", nil, http.StatusOK)
	return identityDecode[api.User](t, data)
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
