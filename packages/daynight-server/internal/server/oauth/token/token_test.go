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

type countedBody struct{ reads int }

func (b *countedBody) Read([]byte) (int, error) { b.reads++; return 0, errors.New("unexpected read") }
func (*countedBody) Close() error               { return nil }

func TestTokenCapacityRefusalDoesNotReadBody(t *testing.T) {
	d := &tokenRate{counts: map[string]int{string(secret.Hash("oauth:token:global")): 1200}}
	h := PublicTokens{Admission: core.PublicAdmission{Writer: tokenWriter{d}}}
	body := &countedBody{}
	r := httptest.NewRequest(http.MethodPost, "/oauth/token", nil)
	r.Body, r.ContentLength = body, 1<<20
	r.RemoteAddr = "192.0.2.1:123"
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	h.Token(w, r)
	if w.Code != http.StatusTooManyRequests || !r.Close || body.reads != 0 {
		t.Fatalf("status=%d close=%v reads=%d", w.Code, r.Close, body.reads)
	}
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
	w = tokenRequest(h.Revoke, url.Values{"token": {secret.Random(model.OAuthAccessPrefix)}, "client_id": {"x"}}.Encode())
	if w.Code != 500 {
		t.Fatalf("revoke error: %d", w.Code)
	}
	s.fail = nil
	w = tokenRequest(h.Revoke, url.Values{"token": {secret.Random(model.OAuthAccessPrefix)}, "client_id": {"x"}}.Encode())
	if w.Code != 200 {
		t.Fatalf("revoke: %d", w.Code)
	}
}

func TestPublicMethodsAndMalformedRequests(t *testing.T) {
	d := &tokenRate{counts: map[string]int{}}
	s := &tokenStub{}
	h := PublicTokens{Admission: core.PublicAdmission{Writer: tokenWriter{d}}, Resource: "https://server.test/mcp", Codes: s, Grants: s}
	for _, handler := range []http.HandlerFunc{h.Token, h.Revoke} {
		for _, tc := range []struct {
			method string
			status int
			allow  string
		}{{http.MethodOptions, http.StatusNoContent, ""}, {http.MethodGet, http.StatusMethodNotAllowed, "POST, OPTIONS"}} {
			r := httptest.NewRequest(tc.method, "https://server.test/oauth/token", nil)
			w := httptest.NewRecorder()
			handler(w, r)
			if w.Code != tc.status || w.Header().Get("Allow") != tc.allow || w.Header().Get("Access-Control-Allow-Origin") != "*" || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("%s: %d %#v", tc.method, w.Code, w.Header())
			}
		}
	}
	valid := "grant_type=refresh_token&client_id=client&resource=https%3A%2F%2Fserver.test%2Fmcp&refresh_token=refresh"
	for _, tc := range []struct {
		name, target, contentType, body string
	}{
		{"query", "https://server.test/oauth/token?extra=1", "application/x-www-form-urlencoded", valid},
		{"media type", "https://server.test/oauth/token", "application/json", valid},
		{"charset", "https://server.test/oauth/token", "application/x-www-form-urlencoded; charset=latin-1", valid},
		{"malformed encoding", "https://server.test/oauth/token", "application/x-www-form-urlencoded", valid + "&x=%zz"},
		{"invalid UTF-8", "https://server.test/oauth/token", "application/x-www-form-urlencoded", valid + "&x=%ff"},
		{"oversized", "https://server.test/oauth/token", "application/x-www-form-urlencoded", strings.Repeat("x", core.MetadataLimit+1)},
		{"wrong resource", "https://server.test/oauth/token", "application/x-www-form-urlencoded", strings.Replace(valid, "server.test", "other.test", 1)},
		{"wrong grant fields", "https://server.test/oauth/token", "application/x-www-form-urlencoded", valid + "&code=unexpected"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, tc.target, strings.NewReader(tc.body))
			r.RemoteAddr = "192.0.2.1:123"
			r.Header.Set("Content-Type", tc.contentType)
			w := httptest.NewRecorder()
			h.Token(w, r)
			want := http.StatusBadRequest
			if tc.name == "oversized" {
				want = http.StatusRequestEntityTooLarge
			}
			if w.Code != want || s.calls != 0 {
				t.Fatalf("status=%d body=%s calls=%d", w.Code, w.Body.String(), s.calls)
			}
		})
	}
	w := tokenRequest(h.Revoke, "client_id=client")
	if w.Code != http.StatusBadRequest || s.calls != 0 {
		t.Fatalf("missing revoke token: %d %s", w.Code, w.Body.String())
	}
}

func TestTokenRateLimitsAndErrorResponses(t *testing.T) {
	valid := "grant_type=refresh_token&client_id=client&resource=https%3A%2F%2Fserver.test%2Fmcp&refresh_token=refresh"
	for _, tc := range []struct {
		name, key string
		count     int
		calls     int
	}{
		{"global", "oauth:token:global", 1200, 0},
		{"source", "oauth:token:source:192.0.2.1", 120, 0},
		{"verified client", "oauth:token:client:verified", 240, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &tokenRate{counts: map[string]int{string(secret.Hash(tc.key)): tc.count}}
			s := &tokenStub{}
			h := PublicTokens{Admission: core.PublicAdmission{Writer: tokenWriter{d}}, Resource: "https://server.test/mcp", Codes: s, Grants: s}
			w := tokenRequest(h.Token, valid)
			if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") != "60" || s.calls != tc.calls {
				t.Fatalf("status=%d body=%s calls=%d", w.Code, w.Body.String(), s.calls)
			}
		})
	}
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{core.ErrInvalidGrant, http.StatusBadRequest, "invalid_grant"},
		{core.ErrAuthorizationUnknown, http.StatusServiceUnavailable, "outcome_unknown"},
		{errors.New("private storage detail"), http.StatusInternalServerError, "server_error"},
	} {
		d := &tokenRate{counts: map[string]int{}}
		s := &tokenStub{fail: tc.err}
		h := PublicTokens{Admission: core.PublicAdmission{Writer: tokenWriter{d}}, Resource: "https://server.test/mcp", Codes: s, Grants: s}
		for _, handler := range []http.HandlerFunc{h.Token, h.Revoke} {
			body := valid
			if s.calls > 0 {
				body = url.Values{"token": {secret.Random(core.RefreshPrefix)}, "client_id": {"client"}}.Encode()
			}
			w := tokenRequest(handler, body)
			if w.Code != tc.status || !strings.Contains(w.Body.String(), `"`+tc.code+`"`) || strings.Contains(w.Body.String(), "private storage detail") {
				t.Fatalf("error %v: %d %s", tc.err, w.Code, w.Body.String())
			}
		}
	}
	missingStore := PublicTokens{Resource: "https://server.test/mcp"}
	w := tokenRequest(missingStore.Token, valid)
	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "server_error") {
		t.Fatalf("admission store failure: %d %s", w.Code, w.Body.String())
	}
}

func TestPublicRevocationAdmitsOnlyCanonicalMCPSecrets(t *testing.T) {
	for _, prefix := range []string{core.APIAccessPrefix, core.APIRefreshPrefix, model.OAuthAccessPrefix, core.RefreshPrefix, "unknown_"} {
		t.Run(prefix, func(t *testing.T) {
			stub := &tokenStub{}
			handler := PublicTokens{Grants: stub}
			form := url.Values{"token": {secret.Random(prefix)}, "client_id": {"societas-bot"}}
			response := tokenRequest(handler.Revoke, form.Encode())
			calls := 0
			if prefix == model.OAuthAccessPrefix || prefix == core.RefreshPrefix {
				calls = 1
			}
			if response.Code != http.StatusOK || response.Body.Len() != 0 || stub.calls != calls || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("revocation status=%d body=%q calls=%d want=%d", response.Code, response.Body.String(), stub.calls, calls)
			}
		})
	}
	for _, token := range []string{"unknown", model.OAuthAccessPrefix + "malformed", core.RefreshPrefix + "malformed"} {
		stub := &tokenStub{}
		handler := PublicTokens{Grants: stub}
		response := tokenRequest(handler.Revoke, url.Values{"token": {token}, "client_id": {"client"}}.Encode())
		if response.Code != http.StatusOK || response.Body.Len() != 0 || stub.calls != 0 {
			t.Fatalf("malformed revocation status=%d calls=%d", response.Code, stub.calls)
		}
	}
}
