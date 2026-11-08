package oauth

import (
	"net/url"
	"strings"
	"testing"
)

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
