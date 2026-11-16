package preview

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func TestRecoveryLinksRequireExplicitNavigationAndSourceSession(t *testing.T) {
	state := secret.Random("")
	principal := model.Principal{Kind: model.SessionCredential, UserID: "user", CredentialID: "session"}
	calls, redemptions := 0, 0
	ops := &operations{
		redeem: func(context.Context, string, string, string) (identity.PreviewSSORedemption, error) {
			redemptions++
			return identity.PreviewSSORedemption{}, model.Unauthenticated(nil)
		},
		retry: func(_ context.Context, login, gotState string, got model.Principal) (string, error) {
			calls++
			if login != "" || gotState != state || got != principal {
				t.Fatalf("retry arguments: %q %q %#v", login, gotState, got)
			}
			return "new-record", nil
		},
	}
	h, logs, handler := fixture(t, ops, false)
	h.authenticate = func(*http.Request) (model.Principal, error) { return principal, nil }
	target := "http://preview.daynight.test" + CallbackPath + "?" + (url.Values{"code": {"expired-code"}, "state": {state}}).Encode()
	for _, cookies := range [][]*http.Cookie{nil, {{Name: h.bindingCookieName(state), Value: secret.Random("")}}} {
		invalid := request(handler, "GET", target, cookies...)
		if invalid.Code != 401 || invalid.Header().Get("Location") != "" || !strings.Contains(invalid.Body.String(), RetryPath+"?state="+state) || calls != 0 || redemptions != 0 {
			t.Fatalf("unbound callback = %d %q calls=%d redemptions=%d", invalid.Code, invalid.Body, calls, redemptions)
		}
	}
	badState := request(handler, "GET", "http://preview.daynight.test"+CallbackPath+"?code=x&state=invalid")
	if badState.Code != 401 || strings.Contains(badState.Body.String(), RetryPath+"?") || calls != 0 || redemptions != 0 {
		t.Fatalf("invalid state = %d %q calls=%d redemptions=%d", badState.Code, badState.Body, calls, redemptions)
	}
	bound := request(handler, "GET", target, &http.Cookie{Name: h.bindingCookieName(state), Value: state})
	if bound.Code != 401 || !strings.Contains(bound.Body.String(), RetryPath+"?state="+state) || bound.Header().Get("Location") != "" || calls != 0 {
		t.Fatalf("bound callback = %d %q calls=%d", bound.Code, bound.Body, calls)
	}
	hash := sha256.Sum256([]byte(preserveRetryFragment))
	if !strings.Contains(bound.Body.String(), "<script>"+preserveRetryFragment+"</script>") || !strings.Contains(bound.Header().Get("Content-Security-Policy"), "'sha256-"+base64.StdEncoding.EncodeToString(hash[:])+"'") {
		t.Fatal("retry fragment script is not allowed by its CSP")
	}
	w := request(handler, "GET", "http://daynight.test"+retryPath("", state))
	if w.Code != 303 || w.Header().Get("Location") != "http://preview.daynight.test/auth/sso/start?login=new-record" || calls != 1 || redemptions != 1 {
		t.Fatalf("retry = %d %v calls=%d redemptions=%d", w.Code, w.Header(), calls, redemptions)
	}
	if strings.Contains(logs.String(), state) || strings.Contains(logs.String(), "expired-code") {
		t.Fatalf("SSO recovery leaked credentials: %s", logs)
	}
}

func TestStartFailureRetainsExplicitOriginalLoginRetry(t *testing.T) {
	const record = "7003942b-a024-4088-b7d9-2bfe545fc80e"
	state := secret.Random("")
	for _, outcome := range []string{"not_committed", "already_committed"} {
		t.Run(outcome, func(t *testing.T) {
			calls := 0
			ops := &operations{start: func(_ context.Context, id string) (identity.PreviewSSOStart, error) {
				calls++
				if id != record {
					t.Fatal("incorrect login")
				}
				if calls == 1 {
					return identity.PreviewSSOStart{}, errors.New("commit outcome unavailable")
				}
				if outcome == "already_committed" {
					return identity.PreviewSSOStart{}, model.Unauthenticated(nil)
				}
				return identity.PreviewSSOStart{LoginID: record, State: state, ExpiresAt: time.Now().Add(time.Minute)}, nil
			}}
			_, _, handler := fixture(t, ops, false)
			path := StartPath + "?login=" + record
			first := request(handler, "GET", "http://preview.daynight.test"+path)
			if first.Code != 500 || calls != 1 || first.Header().Get("Location") != "" || !strings.Contains(first.Body.String(), `href="http://preview.daynight.test`+path+`"`) {
				t.Fatalf("initial failure: %d %q calls=%d", first.Code, first.Body, calls)
			}
			second := request(handler, "GET", "http://preview.daynight.test"+path)
			if outcome == "not_committed" {
				if second.Code != 303 || !strings.Contains(second.Header().Get("Location"), AuthorizePath+"?") {
					t.Fatalf("manual retry: %d %v", second.Code, second.Header())
				}
			} else if second.Code != 401 || strings.Contains(second.Body.String(), `href="http://preview.daynight.test`+path+`"`) || !strings.Contains(second.Body.String(), "Return to projects") {
				t.Fatalf("already consumed: %d %q", second.Code, second.Body)
			}
			if calls != 2 {
				t.Fatalf("unexpected calls: %d", calls)
			}
		})
	}
}

func TestRetryFailureRetainsExplicitOriginalRecovery(t *testing.T) {
	const record = "7003942b-a024-4088-b7d9-2bfe545fc80e"
	state := secret.Random("")
	for _, outcome := range []string{"not_committed", "already_committed"} {
		t.Run(outcome, func(t *testing.T) {
			calls := 0
			ops := &operations{retry: func(_ context.Context, id, actualState string, _ model.Principal) (string, error) {
				calls++
				if id != record || actualState != state {
					t.Fatal("incorrect recovery identity")
				}
				if calls == 1 {
					return "", errors.New("commit outcome unavailable")
				}
				if outcome == "already_committed" {
					return "", model.Unauthenticated(nil)
				}
				return "new-record", nil
			}}
			_, _, handler := fixture(t, ops, false)
			path := retryPath(record, state)
			first := request(handler, "GET", "http://daynight.test"+path)
			if first.Code != 500 || calls != 1 || first.Header().Get("Location") != "" || !strings.Contains(first.Body.String(), RetryPath+"?login="+record+"&amp;state="+state) {
				t.Fatalf("initial failure: %d %q calls=%d", first.Code, first.Body, calls)
			}
			second := request(handler, "GET", "http://daynight.test"+path)
			if outcome == "not_committed" {
				if second.Code != 303 || second.Header().Get("Location") != "http://preview.daynight.test/auth/sso/start?login=new-record" {
					t.Fatalf("manual retry: %d %v", second.Code, second.Header())
				}
			} else if second.Code != 401 || strings.Contains(second.Body.String(), RetryPath+"?") || !strings.Contains(second.Body.String(), "Return to projects") {
				t.Fatalf("already consumed: %d %q", second.Code, second.Body)
			}
			if calls != 2 {
				t.Fatalf("unexpected calls: %d", calls)
			}
		})
	}
}

func TestCallbackRecoveryRejectsDifferentMainSession(t *testing.T) {
	state := secret.Random("")
	other := model.Principal{Kind: model.SessionCredential, UserID: "user", CredentialID: "different-session"}
	retries, redemptions := 0, 0
	ops := &operations{
		redeem: func(context.Context, string, string, string) (identity.PreviewSSORedemption, error) {
			redemptions++
			return identity.PreviewSSORedemption{}, nil
		},
		retry: func(_ context.Context, id, actualState string, principal model.Principal) (string, error) {
			retries++
			if id != "" || actualState != state || principal != other {
				t.Fatal("wrong retry identity")
			}
			return "", model.Unauthenticated(nil)
		},
	}
	h, _, handler := fixture(t, ops, false)
	h.authenticate = func(*http.Request) (model.Principal, error) { return other, nil }
	callback := request(handler, "GET", "http://preview.daynight.test"+CallbackPath+"?code=x&state="+state)
	if callback.Code != 401 || callback.Header().Get("Location") != "" || redemptions != 0 || retries != 0 || !strings.Contains(callback.Body.String(), RetryPath+"?state="+state) {
		t.Fatalf("callback with missing binding: %d %q", callback.Code, callback.Body)
	}
	retry := request(handler, "GET", "http://daynight.test"+retryPath("", state))
	if retry.Code != 401 || retry.Header().Get("Location") != "" || retries != 1 || redemptions != 0 || strings.Contains(retry.Body.String(), RetryPath+"?") {
		t.Fatalf("wrong session recovery: %d %q retries=%d", retry.Code, retry.Body, retries)
	}
}

func TestRecoveryAuthenticationAndUnavailableTarget(t *testing.T) {
	const record = "7003942b-a024-4088-b7d9-2bfe545fc80e"
	calls := 0
	ops := &operations{retry: func(_ context.Context, login, state string, principal model.Principal) (string, error) {
		calls++
		if login != record || state != "" || principal.CredentialID != "session" {
			t.Fatalf("unexpected retry arguments")
		}
		return "", model.Unauthenticated(nil)
	}}
	h, _, handler := fixture(t, ops, false)
	complete := request(handler, "GET", "http://preview.daynight.test"+CompletePath+"?login="+record)
	if complete.Code != 401 || !strings.Contains(complete.Body.String(), RetryPath+"?login="+record) || complete.Header().Get("Location") != "" || calls != 0 {
		t.Fatalf("cookie failure = %d %q", complete.Code, complete.Body)
	}
	invalidID := request(handler, "GET", "http://preview.daynight.test"+CompletePath+"?login="+strings.Repeat("x", 1000))
	if invalidID.Code != 401 || strings.Contains(invalidID.Body.String(), RetryPath+"?") || calls != 0 {
		t.Fatalf("invalid login identifier exposed in recovery link: %d", invalidID.Code)
	}
	h.authenticate = func(*http.Request) (model.Principal, error) { return model.Principal{}, model.Unauthenticated(nil) }
	missing := request(handler, "GET", "http://daynight.test"+retryPath(record, ""))
	if missing.Code != 401 || calls != 0 || !strings.Contains(missing.Body.String(), RetryPath+"?login="+record) || !strings.Contains(missing.Body.String(), "target=\"_blank\"") {
		t.Fatalf("missing main session = %d %q", missing.Code, missing.Body)
	}
	h.authenticate = func(*http.Request) (model.Principal, error) {
		return model.Principal{Kind: model.SessionCredential, CredentialID: "session"}, nil
	}
	unavailable := request(handler, "GET", "http://daynight.test"+retryPath(record, ""))
	if unavailable.Code != 401 || calls != 1 || unavailable.Header().Get("Location") != "" || strings.Contains(unavailable.Body.String(), RetryPath+"?") || !strings.Contains(unavailable.Body.String(), "Return to projects") {
		t.Fatalf("unavailable target = %d %q calls=%d", unavailable.Code, unavailable.Body, calls)
	}
	if !strings.Contains(unavailable.Body.String(), `href="http://preview.daynight.test/auth/sso/start"`) || !strings.Contains(unavailable.Body.String(), "Start sign-in (returns to projects)") || strings.Contains(unavailable.Body.String(), preserveRetryFragment) {
		t.Fatalf("fallback sign-in is missing or misrepresents the lost target: %q", unavailable.Body)
	}
	for _, query := range []string{"", "?login=one&state=two&extra=x", "?login=one&login=two", "?state=", "?unknown=x"} {
		w := request(handler, "GET", "http://daynight.test"+RetryPath+query)
		if w.Code != 400 || calls != 1 {
			t.Fatalf("invalid retry %q = %d calls=%d", query, w.Code, calls)
		}
	}
	h.authenticate = func(*http.Request) (model.Principal, error) { return model.Principal{}, errors.New("offline") }
	w := request(handler, "GET", "http://daynight.test"+retryPath(record, ""))
	if w.Code != 500 || calls != 1 {
		t.Fatalf("authentication error = %d", w.Code)
	}
	for _, method := range []string{"HEAD", "POST"} {
		r := httptest.NewRequest(method, "http://daynight.test"+retryPath(record, ""), nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 405 || calls != 1 {
			t.Fatalf("%s = %d", method, w.Code)
		}
	}
}

func TestAuthorizeFailureOffersOneExplicitRecovery(t *testing.T) {
	const record = "7003942b-a024-4088-b7d9-2bfe545fc80e"
	state := secret.Random("")
	for _, choice := range []string{"not_issued", "issued", "refused"} {
		t.Run(choice, func(t *testing.T) {
			authorizations, restarts := 0, 0
			ops := &operations{
				authorize: func(_ context.Context, id, actualState string, principal model.Principal) (identity.PreviewSSOAuthorization, error) {
					authorizations++
					if id != record || actualState != state || principal.CredentialID != "session" {
						t.Fatal("incorrect authorization arguments")
					}
					return identity.PreviewSSOAuthorization{}, errors.New("commit outcome unavailable")
				},
				retry: func(_ context.Context, id, actualState string, principal model.Principal) (string, error) {
					restarts++
					if id != record || actualState != state || principal.CredentialID != "session" {
						t.Fatal("incorrect restart arguments")
					}
					if choice == "refused" {
						return "", model.Unauthenticated(nil)
					}
					return "new-record", nil
				},
			}
			h, _, handler := fixture(t, ops, false)
			h.authenticate = func(*http.Request) (model.Principal, error) {
				return model.Principal{Kind: model.SessionCredential, CredentialID: "session"}, nil
			}
			path := AuthorizePath + "?" + (url.Values{"login": {record}, "state": {state}}).Encode()
			w := request(handler, "GET", "http://daynight.test"+path)
			if w.Code != 500 || authorizations != 1 || restarts != 0 || !strings.Contains(w.Body.String(), RetryPath+"?login="+record+"&amp;state="+state) || strings.Contains(w.Body.String(), AuthorizePath+"?login=") {
				t.Fatalf("authorization error = %d %q", w.Code, w.Body)
			}
			w = request(handler, "GET", "http://daynight.test"+retryPath(record, state))
			if choice == "refused" {
				if w.Code != 401 || w.Header().Get("Location") != "" || !strings.Contains(w.Body.String(), "Return to projects") {
					t.Fatalf("refusal = %d %q", w.Code, w.Body)
				}
			} else if w.Code != 303 || w.Header().Get("Location") != "http://preview.daynight.test/auth/sso/start?login=new-record" {
				t.Fatalf("manual restart = %d %v", w.Code, w.Header())
			}
			if authorizations != 1 || restarts != 1 {
				t.Fatalf("unexpected calls: authorization=%d restart=%d", authorizations, restarts)
			}
		})
	}
}
