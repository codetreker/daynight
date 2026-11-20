package tag

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

func tagAuthorization(t *testing.T, kind scopepolicy.CredentialType, ids ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	values, err := scopepolicy.Normalize(kind, ids)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := scopepolicy.NewPolicy(kind, values, 1)
	if err != nil {
		t.Fatal(err)
	}
	principal := model.Principal{Kind: model.PATCredential, UserID: "10000000-0000-4000-8000-000000000001", CredentialID: "10000000-0000-4000-8000-000000000002"}
	profile := model.ScopedPATProfile
	if kind == scopepolicy.MCP {
		principal.Kind, profile = model.OAuthCredential, model.ScopedMCPProfile
	}
	return model.CredentialAuthorization{Principal: principal, Profile: profile, Policy: &policy}
}

func TestAuthorizationRequiresIndependentTagScopes(t *testing.T) {
	for _, kind := range []scopepolicy.CredentialType{scopepolicy.PAT, scopepolicy.MCP} {
		for _, tc := range []struct {
			name                string
			ids                 []scopepolicy.ScopeID
			read, write, delete bool
		}{
			{name: "read", ids: []scopepolicy.ScopeID{"tag:read"}, read: true},
			{name: "write without response read", ids: []scopepolicy.ScopeID{"tag:write"}},
			{name: "write", ids: []scopepolicy.ScopeID{"tag:read", "tag:write"}, read: true, write: true},
			{name: "delete", ids: []scopepolicy.ScopeID{"tag:delete"}, delete: true},
			{name: "task association", ids: []scopepolicy.ScopeID{"task:write"}},
			{name: "all", ids: []scopepolicy.ScopeID{"tag:read", "tag:write", "tag:delete"}, read: true, write: true, delete: true},
		} {
			t.Run(string(kind)+"/"+tc.name, func(t *testing.T) {
				auth := tagAuthorization(t, kind, tc.ids...)
				for _, operation := range []struct {
					op      scopepolicy.Operation
					allowed bool
				}{{scopepolicy.TagRead, tc.read}, {scopepolicy.TagWrite, tc.write}, {scopepolicy.TagDelete, tc.delete}} {
					err := RequireAuthorization(auth, operation.op)
					if operation.allowed {
						if err != nil {
							t.Fatalf("%s: %v", operation.op, err)
						}
					} else {
						var fault *model.Fault
						if !errors.Is(err, scopepolicy.ErrInsufficientScope) || !errors.As(err, &fault) || fault.Code != "insufficient_scope" {
							t.Fatalf("%s: %v", operation.op, err)
						}
					}
				}
			})
		}
	}
}

func TestAuthorizationRejectsInvalidProfilesAndOperations(t *testing.T) {
	valid := tagAuthorization(t, scopepolicy.PAT, "tag:read")
	for _, mutate := range []func(*model.CredentialAuthorization){
		func(a *model.CredentialAuthorization) { a.Profile = "" },
		func(a *model.CredentialAuthorization) { a.Policy = nil },
		func(a *model.CredentialAuthorization) { a.Profile = model.OAuthAPIProfile },
		func(a *model.CredentialAuthorization) { a.Profile = model.SessionProfile },
		func(a *model.CredentialAuthorization) { a.Principal = model.Principal{} },
		func(a *model.CredentialAuthorization) { a.Profile = model.ScopedMCPProfile },
	} {
		auth := valid
		mutate(&auth)
		if err := RequireAuthorization(auth, scopepolicy.TagRead); err == nil {
			t.Fatalf("accepted invalid authorization: %+v", auth)
		}
	}
	if err := RequireAuthorization(valid, scopepolicy.TaskWrite); err == nil {
		t.Fatal("accepted an unrelated operation")
	}
}

func TestAuthorizationRetainsExplicitFixedProfiles(t *testing.T) {
	for _, profile := range []model.CredentialPolicyProfile{model.SessionProfile, model.OAuthAPIProfile} {
		auth := tagAuthorization(t, scopepolicy.PAT, "tag:read")
		auth.Profile, auth.Policy = profile, nil
		auth.Principal.Kind = model.SessionCredential
		if profile == model.OAuthAPIProfile {
			auth.Principal.Kind = model.OAuthCredential
		}
		for _, operation := range []scopepolicy.Operation{scopepolicy.TagRead, scopepolicy.TagWrite, scopepolicy.TagDelete} {
			if err := RequireAuthorization(auth, operation); err != nil {
				t.Fatal(err)
			}
		}
		if err := RequireAuthorization(auth, scopepolicy.TaskWrite); err == nil {
			t.Fatal("fixed profile accepted unrelated operation")
		}
	}
}
