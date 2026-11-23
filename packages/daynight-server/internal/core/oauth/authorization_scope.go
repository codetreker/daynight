package oauth

import (
	"context"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// DecideAuthorizationScoped records the explicit business permissions with the
// original browser-bound decision. The caller owns the locked transaction.
func DecideAuthorizationScoped(a *store.OAuthAuthorization, binding, decision, userID, issuer string, selected []scopepolicy.ScopeID, now time.Time) (string, error) {
	var normalized []scopepolicy.ScopeID
	if decision == "approve" {
		var err error
		normalized, err = scopepolicy.Normalize(scopepolicy.MCP, selected)
		if err != nil {
			return "", invalidInput()
		}
	} else if selected != nil {
		return "", invalidInput()
	}
	redirect, err := DecideAuthorization(a, binding, decision, userID, issuer, now)
	if err != nil {
		return "", err
	}
	a.ApprovedScopes = normalized
	return redirect, nil
}

// IssueScopedFamily carries the canonical approved set into the original
// grant/access/refresh insertion. Access tokens never copy the grant policy.
func IssueScopedFamily(ctx context.Context, dao store.CredentialFamilyDAO, input IssueInput, now time.Time) (IssuedFamily, error) {
	policy, err := scopepolicy.NewPolicy(scopepolicy.MCP, input.ApprovedScopes, 1)
	if err != nil {
		return IssuedFamily{}, fmt.Errorf("invalid approved OAuth scopes: %w", err)
	}
	return issueFamily(ctx, dao, input, mcpProfile, &policy, now)
}
