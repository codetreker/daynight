package auth

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/jackc/pgx/v5/pgconn"
)

const authRequestOrigin = "http://127.0.0.1:8787"
const authAliceCookie = "dnst_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const authBobCookie = "dnst_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA"
const authReplacementCookie = "dnst_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA"
const authTestBearer = "dnpat_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA"

type authRequestCall struct {
	name   string
	args   []any
	result any
	err    error
}

type authRequestContextKey struct{}

type strictAuthHTTP struct {
	t             *testing.T
	auth          *Authentication
	handler       http.Handler
	logs          bytes.Buffer
	pending       []authRequestCall
	requestMarker *http.Request
	operationCtx  context.Context
}

func newStrictAuthHTTP(t *testing.T) *strictAuthHTTP {
	t.Helper()
	h := &strictAuthHTTP{t: t}
	callbackCalls := 0
	identity := &strictIdentity{
		t: t,
		callback: func() string {
			callbackCalls++
			return authRequestOrigin + "/api/v1/auth/callback"
		},
		validateLogin: func(provider, returnPath string) error {
			return h.consume("ValidateLogin", provider, returnPath).err
		},
		authenticate: func(ctx context.Context, kind model.CredentialKind, value string) (model.Principal, error) {
			return authRequestResult[model.Principal](h.take(ctx, "Authenticate", kind, value))
		},
		user: func(ctx context.Context, principal model.Principal) (model.User, error) {
			return authRequestResult[model.User](h.take(ctx, "User", principal))
		},
		createPAT: func(ctx context.Context, principal model.Principal, input identitycore.CreatePAT) (identitycore.MintedPAT, error) {
			return authRequestResult[identitycore.MintedPAT](h.take(ctx, "CreatePAT", principal, input))
		},
		listPATs: func(ctx context.Context, principal model.Principal) ([]model.PersonalAccessToken, error) {
			return authRequestResult[[]model.PersonalAccessToken](h.take(ctx, "ListPATs", principal))
		},
		updatePAT: func(ctx context.Context, principal model.Principal, tokenID string, input identitycore.UpdatePATExpiry) (model.PersonalAccessToken, error) {
			return authRequestResult[model.PersonalAccessToken](h.take(ctx, "UpdatePATExpiry", principal, tokenID, input))
		},
		revokePAT: func(ctx context.Context, principal model.Principal, tokenID string) error {
			return h.take(ctx, "RevokePAT", principal, tokenID).err
		},
	}
	logger := slog.New(slog.NewJSONHandler(&h.logs, nil))
	var err error
	h.auth, err = NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: authRequestOrigin, AllowHTTPTestOrigin: true}, logger)
	if err != nil || callbackCalls != 1 {
		t.Fatalf("construct authentication: callback calls=%d err=%v", callbackCalls, err)
	}
	mux := http.NewServeMux()
	h.auth.RegisterRoutes(mux)
	mux.HandleFunc("POST /mutation", h.auth.Require(func(w http.ResponseWriter, r *http.Request, principal model.Principal) {
		h.take(r.Context(), "mutation", principal)
		w.WriteHeader(http.StatusNoContent)
	}))
	h.handler = httpx.RequestLogging(logger, mux)
	return h
}

func (h *strictAuthHTTP) take(ctx context.Context, name string, args ...any) authRequestCall {
	h.t.Helper()
	if ctx.Value(authRequestContextKey{}) != h.requestMarker || httpx.RequestID(ctx) != "project-test" {
		h.t.Fatalf("unexpected authentication request operation %s: pending=%v context marker=%v request ID=%q",
			name, len(h.pending), ctx.Value(authRequestContextKey{}) == h.requestMarker, httpx.RequestID(ctx))
	}
	if h.operationCtx == nil {
		h.operationCtx = ctx
	} else if h.operationCtx != ctx {
		h.t.Fatalf("%s changed the admitted request context", name)
	}
	return h.consume(name, args...)
}

func (h *strictAuthHTTP) consume(name string, args ...any) authRequestCall {
	h.t.Helper()
	if len(h.pending) == 0 {
		h.t.Fatalf("unexpected identity operation %s(%#v)", name, args)
	}
	want := h.pending[0]
	h.pending = h.pending[1:]
	if name != want.name || !reflect.DeepEqual(args, want.args) {
		h.t.Fatalf("identity operation %s(%#v), want %s(%#v)", name, args, want.name, want.args)
	}
	return want
}

func authRequestResult[T any](call authRequestCall) (T, error) {
	if call.err != nil {
		var zero T
		return zero, call.err
	}
	return call.result.(T), nil
}

func (h *strictAuthHTTP) cookie(value string) *http.Cookie {
	return &http.Cookie{Name: h.auth.SessionCookieName(), Value: value}
}

func (h *strictAuthHTTP) request(method, path, body string, cookies []*http.Cookie, authorization []string, origin string, pending ...authRequestCall) *httptest.ResponseRecorder {
	h.t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	for _, cookie := range cookies {
		request.AddCookie(cookie)
	}
	if authorization != nil {
		request.Header["Authorization"] = authorization
	}
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	return h.serve(request, pending...)
}

func (h *strictAuthHTTP) serve(request *http.Request, pending ...authRequestCall) *httptest.ResponseRecorder {
	h.t.Helper()
	h.requestMarker = request
	h.operationCtx = nil
	h.pending = pending
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	h.handler.ServeHTTP(response, request.WithContext(context.WithValue(h.t.Context(), authRequestContextKey{}, h.requestMarker)))
	if len(h.pending) != 0 {
		h.t.Fatalf("request %s %s missed identity operation %s", request.Method, request.URL.Path, h.pending[0].name)
	}
	return response
}

func authRequestAccount(n int) (model.Principal, model.User) {
	p := model.Principal{
		UserID:       fmt.Sprintf("10000000-0000-4000-8000-%012d", n),
		CredentialID: fmt.Sprintf("20000000-0000-4000-8000-%012d", n),
		Kind:         model.SessionCredential,
	}
	unverified := false
	return p, model.User{
		ID: p.UserID, EmailVerified: &unverified,
		PersonalTeam: model.TeamRef{ID: fmt.Sprintf("30000000-0000-4000-8000-%012d", n), Kind: "personal"},
	}
}

func authRequestMintedPAT(principal model.Principal, name string) identitycore.MintedPAT {
	return identitycore.MintedPAT{
		Credential: model.PersonalAccessToken{
			ID: "40000000-0000-4000-8000-000000000001", UserID: principal.UserID, Name: name,
			CreatedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
		},
		Secret: authTestBearer,
	}
}

func expectAuthentication(principal model.Principal, value string) authRequestCall {
	return authRequestCall{name: "Authenticate", args: []any{principal.Kind, value}, result: principal}
}

func expectRejectedCredential(kind model.CredentialKind, value string) authRequestCall {
	return authRequestCall{name: "Authenticate", args: []any{kind, value}, err: model.Unauthenticated(model.ErrNotFound)}
}

func expectUser(principal model.Principal, user model.User) authRequestCall {
	return authRequestCall{name: "User", args: []any{principal}, result: user}
}

func authMissingRelation(phase string) *store.Error {
	return &store.Error{
		Phase: phase, DatabaseFailure: true, SQLState: "42P01",
		Cause: &pgconn.PgError{Code: "42P01", Message: "relation is unavailable"},
	}
}
