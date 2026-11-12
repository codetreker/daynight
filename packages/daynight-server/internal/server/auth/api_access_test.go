package auth

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/google/uuid"
)

func applicationIdentity() store.OAuthAccessIdentity {
	return store.OAuthAccessIdentity{Principal: model.Principal{Kind: model.OAuthCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}, GrantID: uuid.NewString(), ExpiresAt: time.Now().UTC().Add(time.Hour).Add(123 * time.Nanosecond)}
}

func TestAPIAccessBindingPreservesVerifierInputsAndIdentity(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/channel", nil)
	ctx := context.WithValue(request.Context(), struct{}{}, "application context")
	request = request.WithContext(ctx)
	request.Header.Set("Origin", "https://application.example")
	identity := applicationIdentity()
	calls := 0
	h := &RequestAuthentication{}
	h.BindAPIAccess(func(gotCtx context.Context, token string) (store.OAuthAccessIdentity, error) {
		calls++
		if gotCtx != ctx || token != "explicit-application-secret" || calls != 1 {
			t.Fatal("application verifier changed caller context, secret, or call count")
		}
		return identity, nil
	}, "https://application.example")
	got, err := h.AuthenticateAPIAccess(request, "explicit-application-secret")
	if err != nil || got != identity || calls != 1 {
		t.Fatalf("application authentication = %+v, %v; want exact %+v", got, err, identity)
	}
}

func TestAPIAccessBindingRequiresExactConfiguredApplicationOrigin(t *testing.T) {
	for _, test := range []struct {
		name       string
		configured string
		origins    []string
	}{
		{name: "missing", configured: "https://application.example"},
		{name: "different", configured: "https://application.example", origins: []string{"https://main.example"}},
		{name: "case", configured: "https://application.example", origins: []string{"https://APPLICATION.example"}},
		{name: "trailing slash", configured: "https://application.example", origins: []string{"https://application.example/"}},
		{name: "duplicate", configured: "https://application.example", origins: []string{"https://application.example", "https://application.example"}},
		{name: "unconfigured", origins: []string{"https://application.example"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/channel", nil)
			request.Header["Origin"] = test.origins
			calls := 0
			h := &RequestAuthentication{}
			h.BindAPIAccess(func(context.Context, string) (store.OAuthAccessIdentity, error) {
				calls++
				return applicationIdentity(), nil
			}, test.configured)
			got, err := h.AuthenticateAPIAccess(request, "explicit-secret")
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "forbidden" || got != (store.OAuthAccessIdentity{}) || calls != 1 {
				t.Fatalf("Origin refusal = %+v %v calls=%d", got, err, calls)
			}
		})
	}
	h := &RequestAuthentication{}
	if got, err := h.AuthenticateAPIAccess(httptest.NewRequest(http.MethodGet, "/channel", nil), "explicit-secret"); err == nil || got != (store.OAuthAccessIdentity{}) {
		t.Fatalf("unconfigured verifier = %+v %v", got, err)
	}
}

func TestAPIAccessBindingPreservesActualFailuresAndHTTPClassification(t *testing.T) {
	missing := &store.Error{Phase: "access", MissingRow: true, Cause: model.ErrNotFound}
	sql := &store.Error{Phase: "access", DatabaseFailure: true, SQLState: "08006", Cause: errors.New("private SQL cause")}
	for _, test := range []struct {
		name    string
		failure error
		status  int
	}{
		{name: "actual missing access", failure: &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.Unauthenticated(missing)}, status: http.StatusUnauthorized},
		{name: "actual SQL failure", failure: &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: sql}, status: http.StatusInternalServerError},
		{name: "actual cancellation", failure: &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: context.Canceled}, status: http.StatusInternalServerError},
		{name: "actual unknown confirmation", failure: &store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionUnknown, Cause: context.DeadlineExceeded}, status: http.StatusInternalServerError},
	} {
		t.Run(test.name, func(t *testing.T) {
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			request := httptest.NewRequest(http.MethodGet, "/channel", nil)
			request.Header.Set("Origin", "https://application.example")
			h := &RequestAuthentication{}
			h.BindAPIAccess(func(context.Context, string) (store.OAuthAccessIdentity, error) {
				return applicationIdentity(), test.failure
			}, "https://application.example")
			got, err := h.AuthenticateAPIAccess(request, "private-application-secret")
			if err != test.failure || got != (store.OAuthAccessIdentity{}) {
				t.Fatalf("verifier failure changed = %+v %v", got, err)
			}
			response := httptest.NewRecorder()
			httpx.WriteError(response, request, logger, "auth", "application access", err)
			if response.Code != test.status || strings.Contains(response.Body.String(), "private") || strings.Contains(logs.String(), "private-application-secret") {
				t.Fatalf("failure response=%d %s logs=%s", response.Code, response.Body.String(), logs.String())
			}
		})
	}
}

func TestAPIAccessVerifierReceivesRequestCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	request := httptest.NewRequest(http.MethodGet, "/channel", nil).WithContext(ctx)
	request.Header.Set("Origin", "https://application.example")
	started, done := make(chan struct{}), make(chan error, 1)
	h := &RequestAuthentication{}
	h.BindAPIAccess(func(got context.Context, _ string) (store.OAuthAccessIdentity, error) {
		if got != ctx {
			t.Error("application verifier received a replacement request context")
		}
		close(started)
		<-got.Done()
		return store.OAuthAccessIdentity{}, got.Err()
	}, "https://application.example")
	go func() { _, err := h.AuthenticateAPIAccess(request, "secret"); done <- err }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("application verifier did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("application cancellation = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("application verifier did not drain after cancellation")
	}
}

func TestNativeRequestAuthenticationIgnoresBoundAPIVerifier(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.SessionCredential, model.PATCredential} {
		t.Run(string(kind), func(t *testing.T) {
			principal := model.Principal{Kind: kind, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
			calls := 0
			h := &RequestAuthentication{origin: "https://main.example", authenticate: func(_ context.Context, got model.CredentialKind, secret string) (model.Principal, error) {
				calls++
				if got != kind || secret != "native-secret" {
					t.Fatal("native authentication changed credential priority")
				}
				return principal, nil
			}}
			h.BindAPIAccess(func(context.Context, string) (store.OAuthAccessIdentity, error) {
				t.Fatal("native request invoked the application verifier")
				return store.OAuthAccessIdentity{}, nil
			}, "https://application.example")
			request := httptest.NewRequest(http.MethodGet, "/channel", nil)
			if kind == model.PATCredential {
				request.Header.Set("Authorization", "Bearer native-secret")
				request.AddCookie(&http.Cookie{Name: h.SessionCookieName(), Value: "competing-cookie"})
			} else {
				request.AddCookie(&http.Cookie{Name: h.SessionCookieName(), Value: "native-secret"})
			}
			got, err := h.AuthenticateRequest(request)
			if err != nil || got != principal || calls != 1 {
				t.Fatalf("native authentication = %+v %v calls=%d", got, err, calls)
			}
		})
	}
}
