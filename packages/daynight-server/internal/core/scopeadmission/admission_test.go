package scopeadmission

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

func TestRequireCredentialProfilesAndAllOperations(t *testing.T) {
	principal := model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222", Kind: model.PATCredential}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"prompt:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	auth := model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}
	if err := Require(auth, scopepolicy.PromptRead); err != nil {
		t.Fatal(err)
	}
	err = Require(auth, scopepolicy.PromptRead, scopepolicy.PromptWrite)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "insufficient_scope" || !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("missing write: %v", err)
	}
	auth.Policy = nil
	if err := Require(auth, scopepolicy.PromptRead); err == nil {
		t.Fatal("missing policy admitted")
	}
	auth = model.CredentialAuthorization{Principal: model.Principal{UserID: principal.UserID, CredentialID: principal.CredentialID, Kind: model.SessionCredential}, Profile: model.SessionProfile}
	if err := Require(auth, scopepolicy.PromptWrite); err != nil {
		t.Fatal(err)
	}
	if err := Require(auth, "unknown"); err == nil {
		t.Fatal("unknown operation admitted")
	}
}
