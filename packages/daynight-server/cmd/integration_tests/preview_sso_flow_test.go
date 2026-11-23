//go:build integration

package main

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"net/url"
	"testing"
	"time"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	"github.com/jackc/pgx/v5/pgxpool"
)

func serverAPIPreviewSSONormalFlow(t *testing.T, f *fixture) {
	browser := testauth.Browser(t)
	testauth.Login(t, browser, f.origin, "alice")
	main, err := url.Parse(f.origin)
	if err != nil {
		t.Fatal(err)
	}
	var mainCookie *http.Cookie
	for _, cookie := range browser.Jar.Cookies(main) {
		if cookie.Name == "daynight_session" {
			mainCookie = cookie
		}
	}
	if mainCookie == nil {
		t.Fatal("main login did not establish its session cookie")
	}
	database, err := pgxpool.New(f.context, f.databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	type sessionState struct {
		user             string
		created, expires time.Time
		lastUsed         *time.Time
	}
	readSession := func() sessionState {
		t.Helper()
		var state sessionState
		if err := database.QueryRow(f.context, `SELECT user_id,created_at,expires_at,last_used_at FROM sessions WHERE token_hash=$1`, secret.Hash(mainCookie.Value)).Scan(&state.user, &state.created, &state.expires, &state.lastUsed); err != nil {
			t.Fatal(err)
		}
		return state
	}
	initial := readSession()
	if initial.expires.Sub(initial.created) != identitycore.SessionLifetime {
		t.Fatal("new browser session did not use the 168-hour server lifetime")
	}
	activity, _ := usageRequest(t, f, browser, http.MethodPost, "/api/v1/auth/session/activity", `{"expectedUserId":"`+initial.user+`"}`, "application/json", "", http.StatusNoContent)
	active := readSession()
	if active.lastUsed == nil || !active.expires.Equal(active.lastUsed.Add(identitycore.SessionLifetime)) || len(activity.Cookies()) != 0 || activity.Header.Get("Daynight-User-ID") != initial.user {
		t.Fatal("activity did not commit the shared rolling deadline without reissuing credentials")
	}
	usageRequest(t, f, browser, http.MethodPost, "/api/v1/auth/session/activity", `{"expectedUserId":"20000000-0000-4000-8000-000000000001"}`, "application/json", "", http.StatusConflict)
	refused := readSession()
	if !refused.expires.Equal(active.expires) || refused.lastUsed == nil || !refused.lastUsed.Equal(*active.lastUsed) {
		t.Fatal("account refusal changed the browser session")
	}
	previewOrigin := testauth.PreviewOrigin(f.origin)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	t.Cleanup(transport.CloseIdleConnections)
	plain := &http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	navigate := func(address string, cookies []*http.Cookie, status int) *http.Response {
		t.Helper()
		target, err := url.Parse(address)
		if err != nil {
			t.Fatal("invalid SSO navigation URL")
		}
		request, err := http.NewRequestWithContext(f.context, http.MethodGet, f.origin+target.RequestURI(), nil)
		if err != nil {
			t.Fatal(err)
		}
		// Host selects the configured virtual host while the socket stays on
		// the fixture-owned listener.
		request.Host = target.Host
		client := plain
		if target.Host == main.Host {
			client = browser
		}
		for _, cookie := range cookies {
			request.AddCookie(cookie)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatalf("SSO %s request failed", target.Path)
		}
		_, readErr := io.Copy(io.Discard, io.LimitReader(response.Body, 1<<20))
		if err := errors.Join(readErr, response.Body.Close()); err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != status || response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("Referrer-Policy") != "no-referrer" {
			t.Fatalf("SSO %s returned HTTP %d (want %d) or lost its response policy", target.Path, response.StatusCode, status)
		}
		return response
	}
	location := func(response *http.Response, origin, path string) string {
		t.Helper()
		target, err := response.Location()
		if err != nil || target.Scheme+"://"+target.Host != origin || target.Path != path {
			t.Fatalf("SSO navigation did not reach %s", path)
		}
		return target.String()
	}
	exchange := func() (*http.Cookie, string) {
		t.Helper()
		started := navigate(previewOrigin+"/auth/sso/start", nil, http.StatusSeeOther)
		authorizeURL := location(started, f.origin, "/api/v1/auth/preview/authorize")
		authorize, err := url.Parse(authorizeURL)
		if err != nil {
			t.Fatal("invalid SSO authorization URL")
		}
		bindings := started.Cookies()
		if len(bindings) != 1 || bindings[0].Domain != "" || bindings[0].Value != authorize.Query().Get("state") || !bindings[0].HttpOnly {
			t.Fatal("SSO start did not bind the browser to its state")
		}
		authorized := navigate(authorizeURL, nil, http.StatusSeeOther)
		callbackURL := location(authorized, previewOrigin, "/auth/sso/callback")
		redeemed := navigate(callbackURL, bindings, http.StatusSeeOther)
		completeURL := location(redeemed, previewOrigin, "/auth/sso/complete")
		for _, cookie := range redeemed.Cookies() {
			if cookie.Name == "daynight_preview_session" {
				if cookie.Value == mainCookie.Value || !cookie.HttpOnly || cookie.Path != "/" || cookie.SameSite != http.SameSiteLaxMode || cookie.MaxAge != int(authhttp.BrowserCookieLifetime.Seconds()) {
					t.Fatal("preview credential or cookie properties differ")
				}
				return cookie, completeURL
			}
		}
		t.Fatal("SSO callback did not issue a preview cookie")
		return nil, ""
	}
	previewCookie, completeURL := exchange()
	completed := navigate(completeURL, []*http.Cookie{previewCookie}, http.StatusSeeOther)
	if target := location(completed, f.origin, "/projects"); target != f.origin+"/projects" {
		t.Fatal("SSO completion changed its original target")
	}
	project := createProject(t, f, "Task preview API")
	task := createTask(t, f, project, "Preview content", nil)
	content := []byte("<html><body>Real preview content</body></html>")
	file := taskPath(task) + "/attachments/files/docs/index.html"
	f.request(t, http.MethodPut, file, "text/html; charset=utf-8", content, http.StatusCreated)
	previewPath := taskPath(task) + "/preview/docs/index.html?version=1"
	preview, err := url.Parse(previewOrigin)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		before := readSession()
		request, err := http.NewRequestWithContext(f.context, method, f.origin+previewPath, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Host = task.ID + "." + preview.Host
		request.AddCookie(previewCookie)
		request.Header.Set("Sec-Fetch-Site", "same-origin")
		request.Header.Set("Sec-Fetch-Mode", "cors")
		request.Header.Set("Sec-Fetch-Dest", "empty")
		response, err := plain.Do(request)
		if err != nil {
			t.Fatalf("Task preview %s failed: %v", method, err)
		}
		body, readErr := io.ReadAll(response.Body)
		if err := errors.Join(readErr, response.Body.Close()); err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "text/html; charset=utf-8" || response.Header.Get("Cache-Control") != "no-store" || response.ContentLength != int64(len(content)) {
			t.Fatalf("Task preview %s response: %d %v", method, response.StatusCode, response.Header)
		}
		if method == http.MethodGet && !bytes.Equal(body, content) || method == http.MethodHead && len(body) != 0 {
			t.Fatalf("Task preview %s body differs", method)
		}
		after := readSession()
		if after.lastUsed == nil || !after.lastUsed.After(*before.lastUsed) || !after.expires.Equal(after.lastUsed.Add(identitycore.SessionLifetime)) || len(response.Cookies()) != 0 {
			t.Fatalf("Task preview %s did not renew the source session without reissuing its cookie", method)
		}
	}
	var sameSession bool
	var expires time.Time
	if err := database.QueryRow(f.context, `SELECT token_hash=$1,expires_at FROM sessions WHERE preview_token_hash=$2`, secret.Hash(mainCookie.Value), secret.Hash(previewCookie.Value)).Scan(&sameSession, &expires); err != nil {
		t.Fatal(err)
	}
	if !sameSession || !previewCookie.Expires.After(expires) {
		t.Fatal("preview credential did not retain the main session with its long-lived isolated cookie")
	}
	usageRequest(t, f, browser, http.MethodGet, "/api/v1/me", "", "", "", http.StatusOK)
	latestCookie, pendingComplete := exchange()
	usageRequest(t, f, browser, http.MethodPost, "/api/v1/auth/logout", "", "", "", http.StatusNoContent)
	navigate(pendingComplete, []*http.Cookie{latestCookie}, http.StatusUnauthorized)
	usageRequest(t, f, browser, http.MethodGet, "/api/v1/me", "", "", "", http.StatusUnauthorized)
	t.Log("Main activity and authorized preview reads renewed the same 168-hour source session without reissuing credentials; account refusal preserved it, and main logout invalidated both credentials.")
}
