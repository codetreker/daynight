package mcp

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func TestTeamBusinessBodyLimitAndVersion(t *testing.T) {
	base := api.CreateTeamRequest{ExpectedUserID: "account"}
	encoded, _ := json.Marshal(base)
	base.Name = strings.Repeat("x", httpx.MaxJSONBody-len(encoded))
	if err := checkTeamBody(base); err != nil {
		t.Fatalf("exact limit: %v", err)
	}
	base.Name += "x"
	if err := checkTeamBody(base); err == nil {
		t.Fatal("oversized business body accepted")
	}
	// These characters remain unescaped in the CLI's JSON.stringify output.
	for _, text := range []string{strings.Repeat("<>&", 200000), strings.Repeat("\u2028", 200000), strings.Repeat("\u2029", 200000)} {
		base.Name = text
		if err := checkTeamBody(base); err != nil {
			t.Fatalf("valid JSON.stringify input rejected: %v", err)
		}
	}
	// An actual backslash-u sequence is escaped by JSON.stringify and counts as
	// seven bytes, rather than as one three-byte Unicode character.
	base.Name = strings.Repeat(`\u2028`, 150000)
	if err := checkTeamBody(base); err == nil {
		t.Fatal("escaped literal over limit accepted")
	}

	old := "9"
	if _, err := observedVersion(&old, 10); err == nil {
		t.Fatal("stale version accepted")
	}
	huge := "9223372036854775808"
	if _, err := observedVersion(&huge, 10); err == nil {
		t.Fatal("overflow accepted")
	}
	if v, err := observedVersion(nil, 10); err != nil || v != 10 {
		t.Fatalf("default version=%d, %v", v, err)
	}
}
