package token

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type tokenRate struct {
	store.IdentityDAO
	counts map[string]int
}

func (d *tokenRate) PruneDeviceRates(context.Context, time.Time) error { return nil }
func (d *tokenRate) IncrementDeviceRate(_ context.Context, b model.DeviceRateBucket, _ time.Time) (int, error) {
	d.counts[string(b.Hash)]++
	return d.counts[string(b.Hash)], nil
}

type tokenScope struct {
	store.IdentityScope
	dao store.IdentityDAO
}

func (s tokenScope) IdentityDAO() store.IdentityDAO { return s.dao }

type tokenWriter struct{ dao *tokenRate }

func (w tokenWriter) WriteIdentity(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
	err := fn(tokenScope{dao: w.dao})
	return store.Completion{Outcome: store.TransactionCommitted}, err
}

type tokenStub struct {
	calls int
	fail  error
}

func (s *tokenStub) RedeemCode(ctx context.Context, in service.RedeemInput) (service.TokenResult, error) {
	s.calls++
	if s.fail != nil {
		return service.TokenResult{}, s.fail
	}
	if err := in.AdmitClient(ctx, "verified"); err != nil {
		return service.TokenResult{}, err
	}
	return service.TokenResult{AccessToken: "access", RefreshToken: "refresh", TokenType: "Bearer", Scope: core.Scope, ExpiresIn: 3600}, nil
}
func (s *tokenStub) Rotate(ctx context.Context, _, _, _ string, admit func(context.Context, string) error) (core.RotatedTokens, error) {
	s.calls++
	if s.fail != nil {
		return core.RotatedTokens{}, s.fail
	}
	if err := admit(ctx, "verified"); err != nil {
		return core.RotatedTokens{}, err
	}
	return core.RotatedTokens{AccessToken: "access", RefreshToken: "refresh", ExpiresIn: 3600}, nil
}
func (s *tokenStub) RevokePublic(context.Context, string, string) error { s.calls++; return s.fail }
func tokenRequest(h http.HandlerFunc, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "https://server.test/oauth/token", strings.NewReader(body))
	r.RemoteAddr = "192.0.2.1:123"
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	h(w, r)
	return w
}
func TestTokenAdmissionAndDispatch(t *testing.T) {
	d := &tokenRate{counts: map[string]int{}}
	s := &tokenStub{}
	h := PublicTokens{Admission: core.PublicAdmission{Writer: tokenWriter{d}}, Resource: "https://server.test/mcp", Codes: s, Grants: s}
	form := url.Values{"grant_type": {"authorization_code"}, "client_id": {"client"}, "resource": {"https://server.test/mcp"}, "code": {"code"}, "redirect_uri": {"https://client.test"}, "code_verifier": {"verifier"}}
	w := tokenRequest(h.Token, form.Encode())
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"access_token":"access"`) || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("code: %d %s", w.Code, w.Body.String())
	}
	form = url.Values{"grant_type": {"refresh_token"}, "client_id": {"client"}, "resource": {"https://server.test/mcp"}, "refresh_token": {"refresh"}}
	w = tokenRequest(h.Token, form.Encode())
	if w.Code != 200 || s.calls != 2 {
		t.Fatalf("refresh: %d %s", w.Code, w.Body.String())
	}
	for key, want := range map[string]int{"oauth:token:global": 2, "oauth:token:source:192.0.2.1": 2, "oauth:token:client:verified": 2} {
		if got := d.counts[string(secret.Hash(key))]; got != want {
			t.Fatalf("%s=%d", key, got)
		}
	}
	form.Set("extension", "value")
	form.Set("scope", "")
	w = tokenRequest(h.Token, form.Encode())
	if w.Code != 200 {
		t.Fatalf("extension and empty scope: %d %s", w.Code, w.Body.String())
	}
	form.Set("scope", core.Scope)
	w = tokenRequest(h.Token, form.Encode())
	if w.Code != 200 {
		t.Fatalf("same scope: %d %s", w.Code, w.Body.String())
	}
	form.Set("scope", "other")
	w = tokenRequest(h.Token, form.Encode())
	if w.Code != 400 || !strings.Contains(w.Body.String(), "invalid_scope") {
		t.Fatalf("wrong scope: %d %s", w.Code, w.Body.String())
	}
	form.Del("scope")
	s.fail = core.ErrInvalidGrant
	w = tokenRequest(h.Token, form.Encode())
	if w.Code != 400 || !strings.Contains(w.Body.String(), "invalid_grant") || d.counts[string(secret.Hash("oauth:token:client:verified"))] != 4 {
		t.Fatalf("invalid: %d %s", w.Code, w.Body.String())
	}
	w = tokenRequest(h.Token, form.Encode()+"&client_id=other")
	if w.Code != 400 || s.calls != 5 {
		t.Fatalf("duplicates: %d", w.Code)
	}
	w = tokenRequest(h.Token, "grant_type=unknown&client_id=x&resource=https%3A%2F%2Fserver.test%2Fmcp")
	if w.Code != 400 || !strings.Contains(w.Body.String(), "unsupported_grant_type") {
		t.Fatalf("unknown: %d %s", w.Code, w.Body.String())
	}
	s.fail = errors.New("failure")
	w = tokenRequest(h.Revoke, "token=unknown&client_id=x")
	if w.Code != 500 {
		t.Fatalf("revoke error: %d", w.Code)
	}
	s.fail = nil
	w = tokenRequest(h.Revoke, "token=unknown&client_id=x")
	if w.Code != 200 {
		t.Fatalf("revoke: %d", w.Code)
	}
}
