package oauth

import (
	"strings"
	"testing"

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
