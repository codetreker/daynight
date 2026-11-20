package model

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

func TestCredentialAuthorizationRequire(t *testing.T) {
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"project:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	principal := Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222", Kind: PATCredential}
	auth := CredentialAuthorization{Principal: principal, Profile: ScopedPATProfile, Policy: &policy}
	if err := auth.Require(scopepolicy.ProjectRead); err != nil {
		t.Fatal(err)
	}
	err = auth.Require(scopepolicy.ProjectRead, scopepolicy.ProjectWrite)
	var fault *Fault
	if !errors.As(err, &fault) || fault.Code != "insufficient_scope" || !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("combined requirement: %v", err)
	}
	auth.Policy = nil
	if err := auth.Require(scopepolicy.ProjectRead); err == nil {
		t.Fatal("missing scoped policy accepted")
	}
	principal.Kind = SessionCredential
	auth = CredentialAuthorization{Principal: principal, Profile: SessionProfile}
	if err := auth.Require(scopepolicy.ProjectRead); err != nil {
		t.Fatal(err)
	}
	if err := auth.Require(scopepolicy.Operation("unclassified")); err == nil {
		t.Fatal("unknown operation accepted for fixed profile")
	}
}
