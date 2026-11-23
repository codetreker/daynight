package preview

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func TestMissingCookieAndStateMismatchStopWithoutRedirect(t *testing.T) {
	h, _, handler := fixture(t, &operations{}, false)
	state := secret.Random("")
	for _, cookies := range [][]*http.Cookie{nil, {{Name: h.bindingCookieName(state), Value: secret.Random("")}}, {{Name: h.bindingCookieName(state), Value: state}, {Name: h.bindingCookieName(state), Value: state}}} {
		w := request(handler, "GET", "http://preview.daynight.test"+CallbackPath+"?code=x&state="+state, cookies...)
		if w.Code != 401 || w.Header().Get("Location") != "" || !strings.Contains(w.Body.String(), RetryPath+"?state="+state) {
			t.Fatalf("callback missing/mismatch %d", w.Code)
		}
	}
	for _, cookies := range [][]*http.Cookie{nil, {{Name: h.SessionCookieName(), Value: "one"}, {Name: h.SessionCookieName(), Value: "two"}}} {
		w := request(handler, "GET", "http://preview.daynight.test"+CompletePath+"?login=id", cookies...)
		if w.Code != 401 || w.Header().Get("Location") != "" {
			t.Fatalf("complete blocked cookie %d", w.Code)
		}
	}
}

func TestAuthorizeLoginRequiredPreservesRetry(t *testing.T) {
	h, logs, _ := fixture(t, &operations{}, false)
	h.authenticate = func(*http.Request) (model.Principal, error) {
		return model.Principal{}, model.Unauthenticated(errors.New("private-secret"))
	}
	mux := http.NewServeMux()
	h.RegisterMain(mux)
	id, state := "7003942b-a024-4088-b7d9-2bfe545fc80e", secret.Random("")
	r := httptest.NewRequest("GET", "http://daynight.test"+AuthorizePath+"?login="+id+"&state="+state, nil)
	r.Header.Set("Accept-Language", "zh-CN, en;q=0.5")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 401 || !strings.Contains(w.Body.String(), "请先登录") || !strings.Contains(w.Body.String(), "target=\"_blank\"") || !strings.Contains(w.Body.String(), "login="+id+"&amp;state="+state) || w.Header().Get("Location") != "" {
		t.Fatalf("login page: %d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'self' http://daynight.test") {
		t.Fatalf("SSO failure cannot be displayed in a main-site iframe: %v", w.Header())
	}
	if strings.Contains(logs.String(), "private-secret") || strings.Contains(logs.String(), state) {
		t.Fatal("error leaked credential material")
	}
}

func TestOperationFailuresNeverIssueCookieOrReplay(t *testing.T) {
	for _, phase := range []string{"create", "start", "authorize", "redeem", "complete"} {
		t.Run(phase, func(t *testing.T) {
			calls := 0
			failure := errors.New("private-code-and-state")
			ops := &operations{}
			switch phase {
			case "create":
				ops.create = func(context.Context, string) (model.PreviewSSOLogin, error) {
					calls++
					return model.PreviewSSOLogin{}, failure
				}
			case "start":
				ops.start = func(context.Context, string) (identity.PreviewSSOStart, error) {
					calls++
					return identity.PreviewSSOStart{}, failure
				}
			case "authorize":
				ops.authorize = func(context.Context, string, string, model.Principal) (identity.PreviewSSOAuthorization, error) {
					calls++
					return identity.PreviewSSOAuthorization{}, failure
				}
			case "redeem":
				ops.redeem = func(context.Context, string, string, string) (identity.PreviewSSORedemption, error) {
					calls++
					return identity.PreviewSSORedemption{}, failure
				}
			case "complete":
				ops.complete = func(context.Context, string, string) (string, error) { calls++; return "", failure }
			}
			h, logs, handler := fixture(t, ops, false)
			state := secret.Random("")
			target := map[string]string{"create": StartPath, "start": StartPath + "?login=id", "authorize": AuthorizePath + "?login=id&state=" + state, "redeem": CallbackPath + "?code=code&state=" + state, "complete": CompletePath + "?login=id"}[phase]
			host := "preview.daynight.test"
			if phase == "authorize" {
				host = "daynight.test"
			}
			w := request(handler, "GET", "http://"+host+target, &http.Cookie{Name: h.bindingCookieName(state), Value: state}, &http.Cookie{Name: h.SessionCookieName(), Value: "preview-secret"})
			if w.Code != 500 || calls != 1 || len(w.Result().Cookies()) != 0 || w.Header().Get("Location") != "" || strings.Contains(logs.String(), failure.Error()) {
				t.Fatalf("failure result %d calls %d %v", w.Code, calls, w.Header())
			}
		})
	}
}

func TestErrorResponseShortWriteIsLoggedWithoutRetry(t *testing.T) {
	h, logs, _ := fixture(t, &operations{}, false)
	w := &shortWriter{header: make(http.Header)}
	h.Handler().ServeHTTP(w, httptest.NewRequest("GET", "http://preview.daynight.test"+CompletePath+"?login=id", nil))
	if w.status != 401 || w.calls != 1 || !strings.Contains(logs.String(), "write_failed") {
		t.Fatalf("short response status=%d calls=%d logs=%s", w.status, w.calls, logs)
	}
}

type shortWriter struct {
	header        http.Header
	status, calls int
}

func (w *shortWriter) Header() http.Header             { return w.header }
func (w *shortWriter) WriteHeader(status int)          { w.status = status }
func (w *shortWriter) Write(value []byte) (int, error) { w.calls++; return len(value) - 1, nil }

func TestConstructorRejectsMissingInputs(t *testing.T) {
	authenticate := func(*http.Request) (model.Principal, error) { return model.Principal{}, nil }
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, origins := range [][2]string{{"bad", "http://preview.test"}, {"https://main.test", "https://preview.test/path"}, {"https://main.test", "https://preview.test?x=y"}} {
		if _, err := New(&operations{}, authenticate, origins[0], origins[1], logger); err == nil {
			t.Fatal("invalid origins accepted")
		}
	}
	if _, err := New(nil, authenticate, "https://main.test", "https://preview.test", logger); err == nil {
		t.Fatal("missing operations accepted")
	}
}

func TestFailureStatusesAndCancellation(t *testing.T) {
	for _, code := range []string{"unauthenticated", "invalid_input", "forbidden", "permission_denied"} {
		h, _, _ := fixture(t, &operations{}, false)
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", "http://preview.daynight.test/", nil)
		h.fail(w, r, "start", &model.Fault{Code: code}, "")
		if w.Code >= 500 {
			t.Fatalf("known fault %s became %d", code, w.Code)
		}
	}
	h, _, handler := fixture(t, &operations{}, false)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest("GET", "http://preview.daynight.test"+StartPath, nil).WithContext(ctx)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Body.Len() != 0 || len(w.Result().Cookies()) != 0 {
		t.Fatal("cancelled request wrote a response")
	}
	h.failure(w, r, "start", 500, "internal_error", "")
	h.redirect(w, r, "start", "https://daynight.test/projects")
	if w.Body.Len() != 0 || w.Header().Get("Location") != "" {
		t.Fatal("cancelled response was written")
	}
}

func TestStartCancellationReachesOperationAndDrains(t *testing.T) {
	started, finished := make(chan struct{}), make(chan struct{})
	ops := &operations{start: func(ctx context.Context, _ string) (identity.PreviewSSOStart, error) {
		close(started)
		<-ctx.Done()
		return identity.PreviewSSOStart{}, ctx.Err()
	}}
	h, _, _ := fixture(t, ops, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := httptest.NewRequest("GET", "http://preview.daynight.test"+StartPath+"?login=id", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	go func() { defer close(finished); h.Handler().ServeHTTP(w, r) }()
	<-started
	cancel()
	<-finished
	if w.Body.Len() != 0 || len(w.Result().Cookies()) != 0 || w.Header().Get("Location") != "" {
		t.Fatal("cancelled operation wrote navigation results")
	}
}

func TestInvalidCookieResultStopsBeforeNavigation(t *testing.T) {
	state := secret.Random("")
	for _, phase := range []string{"start", "callback"} {
		t.Run(phase, func(t *testing.T) {
			ops := &operations{}
			path := StartPath + "?login=id"
			if phase == "start" {
				ops.start = func(context.Context, string) (identity.PreviewSSOStart, error) {
					return identity.PreviewSSOStart{LoginID: "id", State: "invalid\nstate"}, nil
				}
			} else {
				path = CallbackPath + "?code=code&state=" + state
				ops.redeem = func(context.Context, string, string, string) (identity.PreviewSSORedemption, error) {
					return identity.PreviewSSORedemption{LoginID: "id", Secret: "invalid\ncookie"}, nil
				}
			}
			h, _, handler := fixture(t, ops, false)
			w := request(handler, "GET", "http://preview.daynight.test"+path, &http.Cookie{Name: h.bindingCookieName(state), Value: state})
			if w.Code != 500 || len(w.Result().Cookies()) != 0 || w.Header().Get("Location") != "" {
				t.Fatalf("invalid cookie returned %d %v", w.Code, w.Header())
			}
		})
	}
}
