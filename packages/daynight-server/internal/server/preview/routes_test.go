package preview

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func TestExplicitNavigationAndCookieContract(t *testing.T) {
	for _, secure := range []bool{false, true} {
		t.Run(map[bool]string{false: "http-test", true: "https"}[secure], func(t *testing.T) {
			scheme := "http"
			if secure {
				scheme = "https"
			}
			main, preview := scheme+"://daynight.test", scheme+"://preview.daynight.test"
			state, code, value := secret.Random(""), secret.Random(""), secret.Random("dnpv_")
			expires := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
			calls := []string{}
			ops := &operations{
				create: func(ctx context.Context, target string) (model.PreviewSSOLogin, error) {
					calls = append(calls, "create")
					if target != main+"/projects" || httpx.RequestID(ctx) == "" {
						t.Fatalf("create target/context: %q", target)
					}
					return model.PreviewSSOLogin{ID: "login"}, nil
				},
				start: func(_ context.Context, id string) (identity.PreviewSSOStart, error) {
					calls = append(calls, "start")
					if id != "login" {
						t.Fatalf("start id %q", id)
					}
					return identity.PreviewSSOStart{LoginID: id, State: state, ExpiresAt: expires}, nil
				},
				authorize: func(_ context.Context, id, s string, p model.Principal) (identity.PreviewSSOAuthorization, error) {
					calls = append(calls, "authorize")
					if id != "login" || s != state || p.CredentialID != "session" || p.Kind != model.SessionCredential {
						t.Fatalf("authorize input %+v", p)
					}
					return identity.PreviewSSOAuthorization{Code: code}, nil
				},
				redeem: func(_ context.Context, c, s, b string) (identity.PreviewSSORedemption, error) {
					calls = append(calls, "redeem")
					if c != code || s != state || b != state {
						t.Fatal("redeem input")
					}
					return identity.PreviewSSORedemption{LoginID: "login", Secret: value, ExpiresAt: expires}, nil
				},
				complete: func(_ context.Context, id, v string) (string, error) {
					calls = append(calls, "complete")
					if id != "login" || v != value {
						t.Fatal("complete input")
					}
					return main + "/projects?x=%252F&b=two+words", nil
				},
			}
			h, logs, handler := fixture(t, ops, secure)
			start := request(handler, "GET", preview+StartPath)
			if start.Code != 303 || start.Header().Get("Location") != main+AuthorizePath+"?"+(url.Values{"login": {"login"}, "state": {state}}).Encode() {
				t.Fatalf("start %d %v", start.Code, start.Header())
			}
			binding := start.Result().Cookies()[0]
			if binding.Name != h.bindingCookieName(state) || binding.Value != state || binding.Domain != "" || binding.Path != "/" || !binding.HttpOnly || binding.Secure != secure || binding.SameSite != http.SameSiteLaxMode || !binding.Expires.Equal(expires) {
				t.Fatalf("state cookie %+v", binding)
			}
			authorize := request(handler, "GET", start.Header().Get("Location"))
			if authorize.Code != 303 || authorize.Header().Get("Location") != preview+CallbackPath+"?"+(url.Values{"code": {code}, "state": {state}}).Encode() {
				t.Fatalf("authorize %d %v", authorize.Code, authorize.Header())
			}
			callback := request(handler, "GET", authorize.Header().Get("Location"), binding)
			if callback.Code != 303 || callback.Header().Get("Location") != preview+CompletePath+"?login=login" {
				t.Fatalf("callback %d %v", callback.Code, callback.Header())
			}
			cookies := callback.Result().Cookies()
			if len(cookies) != 2 {
				t.Fatalf("callback cookies %v", cookies)
			}
			cookie := cookies[0]
			if cookie.Name != h.SessionCookieName() || cookie.Value != value || cookie.Domain != "preview.daynight.test" || cookie.Path != "/" || cookie.Secure != secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || !cookie.Expires.Equal(expires) || cookie.MaxAge != 0 {
				t.Fatalf("session cookie %+v", cookie)
			}
			if cookies[1].Name != binding.Name || cookies[1].MaxAge != -1 || cookies[1].Domain != "" {
				t.Fatalf("clear cookie %+v", cookies[1])
			}
			complete := request(handler, "GET", callback.Header().Get("Location"), cookie)
			if complete.Code != 303 || complete.Header().Get("Location") != main+"/projects?x=%252F&b=two+words" {
				t.Fatalf("complete %d %v", complete.Code, complete.Header())
			}
			for _, response := range []*httptest.ResponseRecorder{start, authorize, callback, complete} {
				if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Referrer-Policy") != "no-referrer" {
					t.Fatal("navigation security headers missing")
				}
			}
			if strings.Join(calls, ",") != "create,start,authorize,redeem,complete" {
				t.Fatalf("calls %v", calls)
			}
			for _, s := range []string{state, code, value} {
				if strings.Contains(logs.String(), s) {
					t.Fatalf("secret leaked in logs")
				}
			}
		})
	}
}

func TestNavigationRejectsProtocolWithoutBusinessCalls(t *testing.T) {
	_, _, handler := fixture(t, &operations{}, false)
	for _, path := range []string{StartPath, CallbackPath, CompletePath} {
		for _, method := range []string{"POST", "HEAD", "OPTIONS"} {
			w := request(handler, method, "http://preview.daynight.test"+path)
			if w.Code != 405 || w.Header().Get("Allow") != "GET" {
				t.Fatalf("%s %s: %d", method, path, w.Code)
			}
			if method == "HEAD" && w.Body.Len() != 0 {
				t.Fatal("HEAD error wrote a body")
			}
		}
	}
	for _, target := range []string{
		"http://preview.daynight.test" + StartPath + "?login=", "http://preview.daynight.test" + StartPath + "?login=x&login=y", "http://preview.daynight.test" + StartPath + "?return_url=https://outside.test/", "http://preview.daynight.test" + CallbackPath + "?code=x", "http://preview.daynight.test" + CallbackPath + "?code=x&state=y&unknown=z", "http://preview.daynight.test" + CompletePath, "http://daynight.test" + AuthorizePath + "?state=x", "http://daynight.test" + AuthorizePath + "?login=x&state=%zz", "http://daynight.test/api/v1/auth/preview/%61uthorize?login=x&state=y",
	} {
		w := request(handler, "GET", target)
		if w.Code != 400 {
			t.Fatalf("target %s status %d", target, w.Code)
		}
	}
	for _, target := range []string{"http://preview.daynight.test/auth/sso/%73tart", "http://preview.daynight.test/auth//sso/start", "http://preview.daynight.test/api/v1/me"} {
		if w := request(handler, "GET", target); w.Code != 404 {
			t.Fatalf("preview unknown %s = %d", target, w.Code)
		}
	}
}
