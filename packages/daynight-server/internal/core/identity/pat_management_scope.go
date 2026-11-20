package identity

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/credentialdescription"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// CreateScopedPAT binds the selected policy to the same transaction as issuance.
func (s *Identity) CreateScopedPAT(ctx context.Context, dao store.IdentityDAO, management store.PATManagementDAO, p model.Principal, expectedUserID string, input CreatePAT, description *string, selected []scopepolicy.ScopeID, now time.Time) (MintedPAT, error) {
	if err := ValidatePATOwner(p, expectedUserID); err != nil {
		return MintedPAT{}, err
	}
	value, err := credentialdescription.Normalize(description)
	if err != nil {
		return MintedPAT{}, invalidInput("Invalid credential description.")
	}
	selected, err = scopepolicy.Normalize(scopepolicy.PAT, selected)
	if err != nil {
		return MintedPAT{}, invalidInput("Invalid token scopes.")
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, selected, 1)
	if err != nil {
		return MintedPAT{}, err
	}
	result, err := s.createPATWithPolicy(ctx, dao, p, input, value, &policy, now)
	if err != nil {
		return MintedPAT{}, err
	}
	fresh, err := management.FreshPATTime(ctx, now)
	if err != nil {
		return MintedPAT{}, err
	}
	if err := authLookupError(dao.LockSession(ctx, p, fresh)); err != nil {
		return MintedPAT{}, err
	}
	if _, err := validatedTokenExpiry(result.Credential.ExpiresAt, fresh); err != nil {
		return MintedPAT{}, err
	}
	return result, nil
}

// ListScopedPATs retains expired rows and validates the session after the read.
func (s *Identity) ListScopedPATs(ctx context.Context, dao store.IdentityDAO, scopes store.PATScopeDAO, management store.PATManagementDAO, p model.Principal, now time.Time) ([]model.PersonalAccessToken, error) {
	if err := ValidateSession(p); err != nil {
		return nil, err
	}
	if err := authLookupError(dao.LockSession(ctx, p, now)); err != nil {
		return nil, err
	}
	items, err := scopes.ListPATScopes(ctx, p.UserID)
	if err != nil {
		return nil, err
	}
	if err := checkPATSession(ctx, dao, management, p, now); err != nil {
		return nil, err
	}
	return items, nil
}
