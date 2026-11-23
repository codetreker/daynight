package token

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type apiGrantOperations struct {
	rotate func(context.Context, string, string, string, func(context.Context, string) error) (core.RotatedTokens, error)
	revoke func(context.Context, string, string) error
}

func (s apiGrantOperations) Rotate(ctx context.Context, token, client, resource string, admit func(context.Context, string) error) (core.RotatedTokens, error) {
	return s.rotate(ctx, token, client, resource, admit)
}
func (s apiGrantOperations) RevokePublic(ctx context.Context, token, client string) error {
	return s.revoke(ctx, token, client)
}

func apiRefreshForm(token string) url.Values {
	return url.Values{"grant_type": {"refresh_token"}, "client_id": {core.APIClientID}, "resource": {"https://server.test/api/v1"}, "refresh_token": {token}}
}

func apiTokenAdapter(grants GrantLifecycle) *PublicTokens {
	return &PublicTokens{Admission: core.PublicAdmission{Writer: tokenWriter{&tokenRate{counts: map[string]int{}}}}, Resource: "https://server.test/mcp", APIResource: "https://server.test/api/v1", Grants: grants}
}

func TestAPIRefreshUsesActualGrantAndCanonicalResponse(t *testing.T) {
	for _, scope := range []string{"omitted", core.APIScope} {
		t.Run(scope, func(t *testing.T) {
			refresh := secret.Random(core.APIRefreshPrefix)
			now := time.Date(2026, 11, 12, 4, 5, 6, 123456000, time.UTC)
			grant := store.OAuthGrant{ID: "11111111-1111-4111-8111-111111111111", UserID: "22222222-2222-4222-8222-222222222222", ClientID: core.APIClientID, Resource: "https://server.test/api/v1", Scope: core.APIScope, ExpiresAt: now.Add(core.GrantLifetime)}
			rotated := core.RotatedTokens{AccessToken: secret.Random(core.APIAccessPrefix), RefreshToken: secret.Random(core.APIRefreshPrefix), ExpiresIn: 3600, Grant: &grant, AccessExpiresAt: now.Add(core.AccessLifetime)}
			calls := 0
			var operation context.Context
			grants := apiGrantOperations{rotate: func(ctx context.Context, actualToken, client, resource string, admit func(context.Context, string) error) (core.RotatedTokens, error) {
				calls++
				operation = ctx
				deadline, ok := ctx.Deadline()
				if actualToken != refresh || client != grant.ClientID || resource != grant.Resource || !ok || time.Until(deadline) <= 14*time.Second || time.Until(deadline) > 15*time.Second {
					t.Fatal("refresh tuple or operation deadline changed")
				}
				if err := admit(ctx, client); err != nil {
					t.Fatal(err)
				}
				return rotated, nil
			}}
			h := apiTokenAdapter(grants)
			form := apiRefreshForm(refresh)
			if scope != "omitted" {
				form.Set("scope", scope)
			}
			w := tokenRequest(h.Token, form.Encode())
			var out api.OAuthAPITokens
			if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &out) != nil || calls != 1 || operation.Err() != context.Canceled {
				t.Fatalf("status=%d calls=%d body=%s", w.Code, calls, w.Body.String())
			}
			want := api.OAuthAPITokens{AccessToken: rotated.AccessToken, TokenType: "Bearer", ExpiresIn: 3600, AccessExpiresAt: rotated.AccessExpiresAt, RefreshToken: rotated.RefreshToken, GrantExpiresAt: grant.ExpiresAt, Scope: grant.Scope, Resource: grant.Resource, ClientID: grant.ClientID, GrantID: grant.ID, UserID: grant.UserID}
			if !reflect.DeepEqual(out, want) || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Pragma") != "no-cache" || w.Header().Get("Access-Control-Allow-Origin") != "*" {
				t.Fatalf("response did not preserve actual grant metadata: %+v", out)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(w.Body.Bytes(), &fields); err != nil || len(fields) != 11 || string(fields["access_expires_at"]) != `"2026-11-12T05:05:06.123456Z"` {
				t.Fatalf("unexpected exact token DTO: %s", w.Body.String())
			}
		})
	}
}

func TestAPIRefreshProtocolRefusalsDoNotRotate(t *testing.T) {
	refresh := secret.Random(core.APIRefreshPrefix)
	for _, tc := range []struct {
		name, field, value, code string
	}{
		{"wrong scope", "scope", core.Scope, "invalid_scope"},
		{"empty scope", "scope", "", "invalid_scope"},
		{"wrong client", "client_id", "other", "invalid_grant"},
		{"empty client", "client_id", "", "invalid_request"},
		{"wrong resource", "resource", "https://other.test/api/v1", "invalid_grant"},
		{"empty resource", "resource", "", "invalid_request"},
		{"MCP refresh", "refresh_token", secret.Random(core.RefreshPrefix), "invalid_grant"},
		{"malformed refresh", "refresh_token", core.APIRefreshPrefix + "malformed", "invalid_grant"},
		{"empty refresh", "refresh_token", "", "invalid_request"},
		{"code mixed", "code", "code", "invalid_request"},
		{"empty code mixed", "code", "", "invalid_request"},
		{"redirect mixed", "redirect_uri", "https://client.test", "invalid_request"},
		{"verifier mixed", "code_verifier", "verifier", "invalid_request"},
		{"API authorization code", "grant_type", "authorization_code", "invalid_grant"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			form := apiRefreshForm(refresh)
			form.Set(tc.field, tc.value)
			h := apiTokenAdapter(apiGrantOperations{rotate: func(context.Context, string, string, string, func(context.Context, string) error) (core.RotatedTokens, error) {
				t.Fatal("protocol refusal called rotation")
				return core.RotatedTokens{}, nil
			}})
			w := tokenRequest(h.Token, form.Encode())
			if w.Code != http.StatusBadRequest || w.Body.String() != "{\"error\":\""+tc.code+"\"}\n" {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
	for _, body := range []string{apiRefreshForm(refresh).Encode() + "&client_id=" + core.APIClientID, apiRefreshForm(refresh).Encode() + "&scope=&scope=" + core.APIScope} {
		h := apiTokenAdapter(nil)
		w := tokenRequest(h.Token, body)
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "invalid_request") {
			t.Fatalf("duplicate form status=%d body=%s", w.Code, w.Body.String())
		}
	}
}

func TestAPIRefreshPreservesParentCancellationAndDeadline(t *testing.T) {
	type contextKey struct{}
	parent, cancel := context.WithCancel(context.WithValue(context.Background(), contextKey{}, "original request"))
	defer cancel()
	started, finished := make(chan struct{}), make(chan struct{})
	rotations := 0
	h := apiTokenAdapter(apiGrantOperations{rotate: func(ctx context.Context, _, _, _ string, _ func(context.Context, string) error) (core.RotatedTokens, error) {
		rotations++
		if ctx.Value(contextKey{}) != "original request" {
			t.Error("request context values were lost")
		}
		close(started)
		<-ctx.Done()
		return core.RotatedTokens{}, ctx.Err()
	}})
	r := httptest.NewRequest(http.MethodPost, "https://server.test/oauth/token", strings.NewReader(apiRefreshForm(secret.Random(core.APIRefreshPrefix)).Encode())).WithContext(parent)
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	go func() { defer close(finished); h.Token(w, r) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("refresh did not start")
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("refresh did not inherit cancellation")
	}
	if rotations != 1 || strings.Contains(w.Body.String(), "access_token") {
		t.Fatalf("canceled refresh rotations=%d body=%s", rotations, w.Body.String())
	}

	deadline := time.Now().Add(10 * time.Second)
	short, cancelShort := context.WithDeadline(context.Background(), deadline)
	defer cancelShort()
	h = apiTokenAdapter(apiGrantOperations{rotate: func(ctx context.Context, _, _, _ string, _ func(context.Context, string) error) (core.RotatedTokens, error) {
		if got, ok := ctx.Deadline(); !ok || !got.Equal(deadline) {
			t.Fatal("operation budget extended an earlier parent deadline")
		}
		return core.RotatedTokens{}, core.ErrInvalidGrant
	}})
	r = r.Clone(short)
	r.Body = http.NoBody
	form := apiRefreshForm(secret.Random(core.APIRefreshPrefix)).Encode()
	r.Body = io.NopCloser(strings.NewReader(form))
	r.ContentLength = int64(len(form))
	h.Token(httptest.NewRecorder(), r)
}

func TestPublicOAuthFailurePrecedencePreservesCompletion(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"unknown before refusal", errors.Join(core.ErrInvalidGrant, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: context.Canceled}), 503, "outcome_unknown"},
		{"unknown marker before rate", errors.Join(core.ErrRateLimited, core.ErrAuthorizationUnknown), 503, "outcome_unknown"},
		{"cleanup before unknown", &store.TransactionError{Phase: "rollback", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: core.ErrInvalidGrant}, 500, "server_error"},
		{"database before refusal", errors.Join(core.ErrInvalidGrant, &store.Error{DatabaseFailure: true, Phase: "query"}), 500, "server_error"},
		{"commit failure before refusal", &store.TransactionError{Phase: "commit", Outcome: store.TransactionNotCommitted, Cause: core.ErrInvalidGrant}, 500, "server_error"},
		{"committed cleanup", &store.TransactionError{Phase: "release", Outcome: store.TransactionCommitted, Cause: core.ErrInvalidGrant}, 500, "server_error"},
		{"ordinary refused operation", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: core.ErrInvalidGrant}, 400, "invalid_grant"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := apiTokenAdapter(apiGrantOperations{rotate: func(context.Context, string, string, string, func(context.Context, string) error) (core.RotatedTokens, error) {
				return core.RotatedTokens{}, tc.err
			}})
			w := tokenRequest(h.Token, apiRefreshForm(secret.Random(core.APIRefreshPrefix)).Encode())
			if w.Code != tc.status || w.Body.String() != "{\"error\":\""+tc.code+"\"}\n" || strings.Contains(w.Body.String(), "access_token") {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}
