package mcp

import (
	"strings"
	"testing"
)

func TestScopeCoverageRejectsMissingAdmission(t *testing.T) {
	if err := (&Entry{}).ValidateScopeCoverage(); err == nil || !strings.Contains(err.Error(), "authentication is unavailable") {
		t.Fatalf("missing scoped authentication: %v", err)
	}
	f := newEntryFixture(t)
	if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{}); err != nil {
		t.Fatal(err)
	}
	// The fixture's existing public tool deliberately has no scope classification.
	if err := f.entry.ValidateScopeCoverage(); err == nil || !strings.Contains(err.Error(), "test_only") {
		t.Fatalf("unclassified public tool accepted: %v", err)
	}
	empty := &Entry{}
	if err := empty.EnableScopedAuthentication(testScopedAuthenticator{}); err != nil {
		t.Fatal(err)
	}
	if err := empty.ValidateScopeCoverage(); err != nil {
		t.Fatal(err)
	}
}
