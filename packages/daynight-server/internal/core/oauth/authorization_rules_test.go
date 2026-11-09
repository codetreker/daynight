package oauth

import (
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func TestAuthorizationStartAdmission(t *testing.T) {
	const resource = "https://server.example/mcp"
	valid := []string{"code", Scope, resource, resource, "ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA", "S256", "state"}
	if !ValidAuthorizationStart(valid[0], valid[1], valid[2], valid[3], valid[4], valid[5], valid[6]) {
		t.Fatal("valid request rejected")
	}
	for _, tc := range []struct {
		index int
		value string
	}{
		{0, "token"}, {1, "other"}, {2, "https://other/mcp"}, {4, "bad"}, {5, "plain"}, {6, "bad\x00state"},
	} {
		in := append([]string(nil), valid...)
		in[tc.index] = tc.value
		if ValidAuthorizationStart(in[0], in[1], in[2], in[3], in[4], in[5], in[6]) {
			t.Fatalf("invalid start accepted: field %d", tc.index)
		}
	}
}

func TestAuthorizationCodeInputAdmission(t *testing.T) {
	const resource = "https://server.example/mcp"
	valid := []string{secret.Random(CodePrefix), "client", resource, resource, strings.Repeat("a", 43)}
	if !ValidAuthorizationCodeInput(valid[0], valid[1], valid[2], valid[3], valid[4]) {
		t.Fatal("valid input rejected")
	}
	for _, tc := range []struct {
		index int
		value string
	}{{0, "bad"}, {1, ""}, {2, "https://other/mcp"}, {4, "short"}} {
		in := append([]string(nil), valid...)
		in[tc.index] = tc.value
		if ValidAuthorizationCodeInput(in[0], in[1], in[2], in[3], in[4]) {
			t.Fatalf("invalid code input accepted: field %d", tc.index)
		}
	}
}

func TestAuthorizationChallengeAndCallback(t *testing.T) {
	verifier := strings.Repeat("a", 43)
	if !VerifyChallenge("ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA", verifier) {
		t.Fatal("valid S256 challenge rejected")
	}
	if VerifyChallenge("ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA", strings.Repeat("b", 43)) || ValidVerifier(strings.Repeat("a", 42)) || ValidVerifier(strings.Repeat("a", 42)+"+") {
		t.Fatal("invalid verifier accepted")
	}
	raw := "https://example.com/cb?z=%2f&x=a%20b&z=2"
	got, err := CallbackURI(raw, url.Values{"code": {"secret"}, "iss": {"https://server.example"}})
	if err != nil || got != raw+"&code=secret&iss=https%3A%2F%2Fserver.example" {
		t.Fatalf("callback changed query: %q, %v", got, err)
	}
	for _, uri := range []string{"https://example.com/cb?%63ode=x", "https://example.com/cb?state=x", "https://example.com/cb?bad=%xx"} {
		if _, err := CallbackURI(uri, nil); err == nil {
			t.Fatalf("unsafe callback accepted: %s", uri)
		}
	}
}

func TestValidStateEnforcesUTF8ByteLimitAndRejectsNUL(t *testing.T) {
	for _, tc := range []struct {
		name  string
		state string
		valid bool
	}{
		{"empty", "", true},
		{"opaque Unicode", "state=授权&value=é", true},
		{"ASCII byte limit", strings.Repeat("a", 4096), true},
		{"Unicode byte limit", strings.Repeat("界", 1365) + "a", true},
		{"ASCII over limit", strings.Repeat("a", 4097), false},
		{"Unicode over byte limit", strings.Repeat("界", 1366), false},
		{"NUL", "before\x00after", false},
		{"invalid UTF8", string([]byte{0xff}), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ValidState(tc.state); got != tc.valid {
				t.Fatalf("ValidState() = %v; want %v", got, tc.valid)
			}
		})
	}
}

func TestCallbackURIEncodesResponseWithoutChangingRegisteredBytes(t *testing.T) {
	fields := url.Values{"code": {"a+b/c="}, "state": {"x&y=é"}}
	encoded := "code=a%2Bb%2Fc%3D&state=x%26y%3D%C3%A9"
	for _, tc := range []struct {
		name   string
		raw    string
		fields url.Values
		want   string
	}{
		{"new query", "https://example.com/%63b", fields, "https://example.com/%63b?" + encoded},
		{"forced query", "http://127.0.0.1:123/cb?", fields, "http://127.0.0.1:123/cb?" + encoded},
		{"empty response", "https://example.com/cb?x=%2f&x=a%20b", nil, "https://example.com/cb?x=%2f&x=a%20b"},
		{"preserved empty query", "https://example.com/cb?", url.Values{}, "https://example.com/cb?"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := CallbackURI(tc.raw, tc.fields)
			if err != nil || got != tc.want {
				t.Fatalf("CallbackURI() = %q, %v; want %q", got, err, tc.want)
			}
		})
	}
	for _, raw := range []string{"http://remote.example/cb", "https://example.com/cb#error", "https://example.com/cb?error=denied", "https://example.com/cb?iss=other"} {
		got, err := CallbackURI(raw, fields)
		if got != "" || err != ErrInvalidAuthorization {
			t.Fatalf("CallbackURI(%q) = %q, %v; want invalid authorization", raw, got, err)
		}
	}
}

func TestAuthorizationRulesDecisionAndRedemption(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	binding := secret.Random(BindingPrefix)
	request := AuthorizationRequest{ID: "request", Binding: binding, ClientID: "client", RedirectURI: "https://client.example/cb", Resource: "https://server.example/mcp", Scope: Scope, Challenge: "ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA", State: "state"}
	a := NewAuthorization(request, now)
	if status, _ := AuthorizationStatus(a, a.ExpiresAt); status != "expired" {
		t.Fatalf("expiry boundary: %s", status)
	}
	if _, err := DecideAuthorization(&a, secret.Random(BindingPrefix), "approve", "user", "https://server.example", now); !errors.Is(err, ErrInvalidAuthorization) || a.Status != "pending" {
		t.Fatalf("wrong binding changed decision: %+v %v", a, err)
	}
	if _, err := DecideAuthorization(&a, binding, "approve", "user", "https://server.example", a.ExpiresAt); !errors.Is(err, ErrInvalidAuthorization) || a.Status != "pending" {
		t.Fatalf("expired decision: %+v %v", a, err)
	}
	callback, err := DecideAuthorization(&a, binding, "approve", "user", "https://server.example", now)
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(callback)
	if err != nil || u.Query().Get("state") != "state" || u.Query().Get("code") == "" || a.State != "" || a.StatePresent || a.Status != "approved" {
		t.Fatalf("approval: %+v %q %v", a, callback, err)
	}
	valid := CodeBinding{ClientID: request.ClientID, RedirectURI: request.RedirectURI, Resource: request.Resource, Verifier: strings.Repeat("a", 43)}
	wrong := valid
	wrong.Verifier = strings.Repeat("b", 43)
	if _, err := CheckAuthorizationCode(a, wrong, now); !errors.Is(err, ErrInvalidGrant) || a.Status != "approved" {
		t.Fatalf("wrong verifier: %v", err)
	}
	if replay, err := CheckAuthorizationCode(a, valid, now); replay || err != nil {
		t.Fatalf("valid code: %t %v", replay, err)
	}
	if _, err := CheckAuthorizationCode(a, valid, *a.CodeExpiresAt); !errors.Is(err, ErrInvalidGrant) {
		t.Fatalf("code expiry: %v", err)
	}
	ConsumeAuthorization(&a, "grant", now.Add(time.Hour))
	if replay, err := CheckAuthorizationCode(a, valid, now); !replay || err != nil {
		t.Fatalf("replay: %t %v", replay, err)
	}
	if replay, err := CheckAuthorizationCode(a, wrong, now); replay || !errors.Is(err, ErrInvalidGrant) {
		t.Fatalf("wrong replay: %t %v", replay, err)
	}
}
