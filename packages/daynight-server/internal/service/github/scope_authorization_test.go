package github

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

func TestCurrentAdmissionRejectsMissingAndMismatchedCredentials(t *testing.T) {
	original := scopeAppAuth(t, "github:read")
	if err := currentAdmission(t.Context(), nil, original, scopepolicy.GithubRead); err == nil {
		t.Fatal("missing current authority accepted")
	}
	for _, mutate := range []func(*model.CredentialAuthorization){func(a *model.CredentialAuthorization) {
		a.Principal.CredentialID = "99999999-9999-4999-8999-999999999999"
	}, func(a *model.CredentialAuthorization) { a.Profile = model.SessionProfile }, func(a *model.CredentialAuthorization) { a.Policy = nil }} {
		current := original
		mutate(&current)
		if err := currentAdmission(t.Context(), func(context.Context, model.CredentialAuthorization) (model.CredentialAuthorization, error) {
			return current, nil
		}, original, scopepolicy.GithubRead); err == nil {
			t.Fatal("invalid current authority accepted")
		}
	}
	session := model.CredentialAuthorization{Principal: original.Principal, Profile: model.SessionProfile}
	session.Principal.Kind = model.SessionCredential
	if err := currentAdmission(t.Context(), nil, session, scopepolicy.GithubRead); err != nil {
		t.Fatalf("fixed session: %v", err)
	}
}
