package model

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

func TestCredentialAuthorizationProfiles(t *testing.T) {
	pat, _ := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 1)
	mcp, _ := scopepolicy.NewPolicy(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read"}, 1)
	zero := scopepolicy.Policy{}
	principal := Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	for _, tc := range []struct {
		profile CredentialPolicyProfile
		kind    CredentialKind
		policy  *scopepolicy.Policy
		valid   bool
	}{
		{ScopedPATProfile, PATCredential, &pat, true}, {ScopedMCPProfile, OAuthCredential, &mcp, true},
		{SessionProfile, SessionCredential, nil, true}, {OAuthAPIProfile, OAuthCredential, nil, true},
		{ScopedPATProfile, PATCredential, nil, false}, {ScopedMCPProfile, OAuthCredential, nil, false},
		{ScopedPATProfile, PATCredential, &mcp, false}, {ScopedMCPProfile, OAuthCredential, &pat, false},
		{ScopedPATProfile, PATCredential, &zero, false}, {SessionProfile, SessionCredential, &pat, false},
		{OAuthAPIProfile, PATCredential, nil, false}, {"", OAuthCredential, nil, false},
	} {
		p := principal
		p.Kind = tc.kind
		err := (CredentialAuthorization{Principal: p, Profile: tc.profile, Policy: tc.policy}).Validate()
		if (err == nil) != tc.valid {
			t.Errorf("%s %s: %v", tc.profile, tc.kind, err)
		}
	}
}
