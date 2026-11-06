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
