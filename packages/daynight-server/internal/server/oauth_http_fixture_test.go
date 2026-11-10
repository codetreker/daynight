package server

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type oauthHTTPRequestKey struct{}
type oauthHTTPRequest struct {
	ctx           context.Context
	authenticated atomic.Int32
}

func markOAuthHTTPRequests(handler http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		marker := new(oauthHTTPRequest)
		ctx := context.WithValue(r.Context(), oauthHTTPRequestKey{}, marker)
		marker.ctx = ctx
		handler.ServeHTTP(w, r.WithContext(ctx))
	})
}
func oauthHTTPDirectContext(t *testing.T, ctx context.Context) {
	t.Helper()
	oauthHTTPContext(t, ctx)
	if _, ok := ctx.Value(operationHTTPRequestKey{}).(*operationHTTPRequest); ok {
		requireExactOperationHTTPContext(t, ctx)
		return
	}
	marker, ok := ctx.Value(oauthHTTPRequestKey{}).(*oauthHTTPRequest)
	if !ok || marker.ctx != ctx {
		unexpectedHTTPCall(t, "OAuth changed request context")
	}
}

type oauthHTTPFixture struct {
	t                     *testing.T
	Ops                   *oauthHTTPOperations
	Auth                  *authhttp.Authentication
	Identity              *operationHTTPIdentity
	Principal, Other      model.Principal
	Session, OtherSession *http.Cookie
	Origin                string
	Now                   time.Time
	mu                    sync.Mutex
	Rates                 map[string]int
	Starts                map[string]int
	ClientBudgetID        string
	PersonalTeamID        string
	ExpectedTokens        oauthservice.TokenResult
}

func newOAuthHTTPFixture(t *testing.T) *oauthHTTPFixture {
	t.Helper()
	f := &oauthHTTPFixture{t: t, Ops: &oauthHTTPOperations{t: t}, Origin: "http://127.0.0.1:8787", Now: time.Now().UTC().Truncate(time.Microsecond), Rates: make(map[string]int), Starts: make(map[string]int)}
	f.Principal = model.Principal{Kind: model.SessionCredential, UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "b2222222-2222-4222-8222-222222222222"}
	f.Other = model.Principal{Kind: model.SessionCredential, UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444"}
	f.Session = &http.Cookie{Name: "daynight_session", Value: httpTestToken(model.SessionCredential)}
	f.OtherSession = &http.Cookie{Name: "daynight_session", Value: "dnst_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA"}
	f.Identity = &operationHTTPIdentity{t: t, CallbackURLFn: func() string { return f.Origin + "/api/v1/auth/callback" }, AuthenticateFn: func(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		oauthHTTPDirectContext(t, ctx)
		if marker, ok := ctx.Value(oauthHTTPRequestKey{}).(*oauthHTTPRequest); ok && marker.authenticated.Add(1) != 1 {
			unexpectedHTTPCall(t, "repeated OAuth Identity.Authenticate")
		}
		if kind != model.SessionCredential {
			unexpectedHTTPCall(t, "OAuth Identity credential kind")
		}
		switch token {
		case f.Session.Value:
			return f.Principal, nil
		case f.OtherSession.Value:
			return f.Other, nil
		default:
			unexpectedHTTPCall(t, "OAuth Identity raw credential")
			return model.Principal{}, model.ErrNotFound
		}
	}}
	f.resetAuth()
	return f
}
func (f *oauthHTTPFixture) resetAuth() {
	var err error
	f.Auth, err = authhttp.NewAuthentication(f.Identity, config.AuthSettings{PublicOrigin: f.Origin, AllowHTTPTestOrigin: true}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		f.t.Fatal(err)
	}
	f.Session.Name, f.OtherSession.Name = f.Auth.SessionCookieName(), f.Auth.SessionCookieName()
}
func oauthHTTPContext(t *testing.T, ctx context.Context) {
	t.Helper()
	if ctx == nil || ctx.Err() != nil {
		unexpectedHTTPCall(t, "OAuth request context")
	}
}
func oauthHTTPCount(t *testing.T, want int) func() {
	t.Helper()
	var n atomic.Int32
	t.Cleanup(func() {
		if got := n.Load(); got != int32(want) {
			t.Errorf("OAuth operation calls=%d, want %d", got, want)
		}
	})
	return func() {
		if got := n.Add(1); got > int32(want) {
			unexpectedHTTPCall(t, "extra OAuth operation")
		}
	}
}
func oauthHTTPCheck(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("OAuth operation argument/result: got %#v, want %#v", got, want)
		panic("OAuth operation contract violated")
	}
}

func (f *oauthHTTPFixture) handler(configure func(*httpDependencies)) http.Handler {
	c := configuredTestConfig()
	c.PublicOrigin, c.UniAuthCallbackURL = f.Origin, f.Origin+"/api/v1/auth/callback"
	c.AllowHTTPTestOrigin = true
	return newOperationHTTPServerWithConfig(f.t, f.Identity, func(d *httpDependencies) {
		d.Registration, d.Authorizations, d.TokenCodes, d.TokenGrants = f.Ops, f.Ops, f.Ops, f.Ops
		d.TokenAdmission = f.admission
		if configure != nil {
			configure(d)
		}
	}, io.Discard, f.Principal, c)
}
