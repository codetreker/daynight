package server

import (
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

	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

type identityResultWireCut struct {
	armed     atomic.Bool
	requests  atomic.Int64
	consumed  atomic.Int64
	closed    atomic.Int64
	active    atomic.Int64
	hijacked  atomic.Int64
	cutDone   chan struct{}
	transport *http.Transport
	server    *httptest.Server
}

func newIdentityResultWireCut(t *testing.T, origin string) *identityResultWireCut {
	t.Helper()
	upstream, err := url.Parse(origin)
	if err != nil {
		t.Fatal("parse real gateway origin failed")
	}
	cut := &identityResultWireCut{cutDone: make(chan struct{}), transport: http.DefaultTransport.(*http.Transport).Clone()}
	cut.transport.Proxy = nil
	cut.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		cut.active.Add(1)
		defer cut.active.Add(-1)
		forwarded := request.Clone(request.Context())
		forwarded.URL.Scheme, forwarded.URL.Host = upstream.Scheme, upstream.Host
		forwarded.Host, forwarded.RequestURI = upstream.Host, ""
		resultRequest := request.Method == http.MethodPost && request.URL.Path == "/auth/result"
		if resultRequest {
			cut.requests.Add(1)
		}
		response, err := cut.transport.RoundTrip(forwarded)
		if err != nil {
			t.Error("forwarding to the real UniAuth gateway failed")
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		defer response.Body.Close()
		if resultRequest && cut.armed.CompareAndSwap(true, false) {
			defer close(cut.cutDone)
			body, readErr := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
			var identity struct {
				Provider string `json:"provider"`
				ID       string `json:"id"`
			}
			if response.StatusCode != http.StatusOK || readErr != nil || len(body) > 1<<20 || json.Unmarshal(body, &identity) != nil || identity.Provider != "github" || identity.ID == "" {
				t.Error("wire cut did not follow a successful real one-time identity retrieval")
				w.WriteHeader(http.StatusBadGateway)
				return
			}
			cut.consumed.Add(1)
			// The upstream has finished consuming its result. Closing the actual
			// downstream socket loses that response before the SDK receives headers.
			connection, _, err := http.NewResponseController(w).Hijack()
			if err != nil {
				t.Error("hijacking the real SDK connection failed")
				return
			}
			cut.hijacked.Add(1)
			if err := connection.Close(); err != nil {
				t.Error("closing the real SDK connection failed")
			} else {
				cut.closed.Add(1)
			}
			cut.hijacked.Add(-1)
			return
		}
		for name, values := range response.Header {
			w.Header()[name] = append([]string(nil), values...)
		}
		w.WriteHeader(response.StatusCode)
		if _, err := io.Copy(w, response.Body); err != nil {
			t.Error("forwarding the real gateway response failed")
		}
	}))
	t.Cleanup(func() {
		cut.server.Close()
		cut.transport.CloseIdleConnections()
		if cut.active.Load() != 0 || cut.hijacked.Load() != 0 {
			t.Error("wire-loss proxy retained an active request or hijacked connection")
		}
	})
	return cut
}

func TestAuthenticationRealUniAuthResultWireLoss(t *testing.T) {
	database := projectTestStore(t)
	product := httptest.NewUnstartedServer(nil)
	t.Cleanup(product.Close)
	origin := "http://" + product.Listener.Addr().String()
	callbackPath := "/auth/callback"
	logs := &identityIntegrationLogs{}
	gateway := testauth.StartGatewayWithOutput(t, origin+callbackPath, logs)
	cut := newIdentityResultWireCut(t, gateway.Origin)
	directTransport := http.DefaultTransport.(*http.Transport).Clone()
	t.Cleanup(directTransport.CloseIdleConnections)
	direct, err := uniauth.New(uniauth.Config{BaseURL: gateway.Origin, AppID: gateway.AppID, AppSecret: gateway.AppSecret,
		AllowLoopbackHTTP: true, HTTPClient: &http.Client{Timeout: 5 * time.Second, Transport: directTransport}})
	if err != nil {
		t.Fatal("construct direct real UniAuth SDK client failed")
	}
	config := configuredTestConfig()
	config.PublicOrigin, config.UniAuthURL = origin, cut.server.URL
	config.UniAuthAppID, config.UniAuthAppSecret, config.UniAuthCallbackURL = gateway.AppID, gateway.AppSecret, origin+callbackPath
	config.AllowHTTPTestOrigin, config.AllowLoopbackHTTP = true, true
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	handler, err := New(Dependencies{Store: database, Files: attachmentTestFiles(t)}, config, logger)
	if err != nil {
		t.Fatal("compose the production authenticated handler failed")
	}
	product.Config.Handler = RequestLogging(logger, handler)
	product.Start()
	integration := &identityIntegration{server: product, gateway: cut.server.URL, logs: logs,
		sessionCookie: "daynight_session", callbackPath: callbackPath, secrets: []string{gateway.AppSecret}}
	t.Cleanup(func() {
		product.Close()
		cut.server.Close()
		cut.transport.CloseIdleConnections()
		directTransport.CloseIdleConnections()
		gateway.Close(t)
		for _, secret := range integration.secrets {
			if secret != "" && logs.contains(secret) {
				t.Error("wire-loss authentication logs exposed a credential or handover value")
			}
		}
		if cut.active.Load() != 0 || cut.hijacked.Load() != 0 {
			t.Error("wire-loss acceptance retained a request or hijacked connection")
		}
		if !t.Failed() {
			t.Log("wire-loss cleanup: product_closed=true proxy_closed=true gateway_reaped=true active_requests=0 hijacked_connections=0")
		}
	})
	browser := identityBrowser(t)
	callback := integration.providerCallback(t, browser, integration.start(t, browser), "alice")
	mainURL, err := url.Parse(origin)
	if err != nil {
		t.Fatal("parse product origin failed")
	}
	bindings := browser.Jar.Cookies(mainURL)
	for _, cookie := range bindings {
		integration.secrets = append(integration.secrets, cookie.Value)
	}
	cut.armed.Store(true)
	response, _ := identityRequest(t, browser, http.MethodGet, callback.String(), "", nil, http.StatusSeeOther)
	if response.Header.Get("Location") != "/login?authError=login_failed&returnPath=%2Fprojects%3Fview%3Dtasks" || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("lost identity response did not safely return to the login UI")
	}
	select {
	case <-cut.cutDone:
	case <-time.After(5 * time.Second):
		t.Fatal("wire-loss proxy did not finish closing the SDK connection")
	}
	cookies := response.Cookies()
	if len(cookies) != 1 || !strings.HasPrefix(cookies[0].Name, "daynight_login_") || cookies[0].MaxAge != -1 {
		t.Fatal("lost identity response did not clear only its browser binding")
	}
	if cut.requests.Load() != 1 || cut.consumed.Load() != 1 || cut.closed.Load() != 1 {
		t.Fatalf("the SDK did not encounter exactly one actual connection cut after successful upstream consumption: requests=%d consumed=%d closed=%d", cut.requests.Load(), cut.consumed.Load(), cut.closed.Load())
	}
	_, err = direct.Retrieve(t.Context(), callback.Query().Get("code"))
	var unavailable *uniauth.APIError
	if !errors.As(err, &unavailable) || unavailable.StatusCode != http.StatusGone || unavailable.Code != "result_unavailable" {
		t.Fatal("the real gateway retained the result after its response was lost")
	}
	assertEmptyIdentity := func() {
		t.Helper()
		var pending, users, sessions int
		if err := database.Pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM login_transactions), (SELECT count(*) FROM users), (SELECT count(*) FROM sessions)`).Scan(&pending, &users, &sessions); err != nil {
			t.Fatal("inspect failed-login persistence failed")
		}
		if pending != 0 || users != 0 || sessions != 0 {
			t.Fatal("a lost one-time result left a reusable pending login or issued a local identity/session")
		}
	}
	assertEmptyIdentity()
	identityRequest(t, browser, http.MethodGet, origin+"/api/v1/me", "", nil, http.StatusUnauthorized)
	browser.Jar.SetCookies(mainURL, bindings)
	identityRequest(t, browser, http.MethodGet, callback.String(), "", nil, http.StatusUnauthorized)
	if cut.requests.Load() != 1 {
		t.Fatal("replaying a consumed callback retrieved the one-time identity again")
	}
	assertEmptyIdentity()
	if !logs.contains(`"cause":"network"`) {
		t.Fatal("lost SDK connection did not retain sanitized network diagnostics")
	}
	user := integration.login(t, browser, "alice")
	if user.ID == "" || cut.requests.Load() != 2 || cut.consumed.Load() != 1 || cut.closed.Load() != 1 {
		t.Fatal("fresh normal PKCE login did not recover after the one-time wire failure")
	}
	var sessions int
	if err := database.Pool.QueryRow(t.Context(), `SELECT count(*) FROM sessions`).Scan(&sessions); err != nil || sessions != 1 {
		t.Fatal("fresh login did not persist exactly one session")
	}
	t.Log("wire-loss evidence: upstream_result=200 downstream_socket_closed=1 upstream_replay=410 callback_replay=401 failed_login_sessions=0 fresh_login_sessions=1")
}
