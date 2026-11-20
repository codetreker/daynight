package identity

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

// AuthenticatePATPolicy returns the policy attached to the authenticated PAT.
// This separate path leaves legacy authentication unchanged until scope activation.
func (s *Identity) AuthenticatePATPolicy(ctx context.Context, dao store.PATScopeDAO, value string, now time.Time) (model.CredentialAuthorization, error) {
	if err := ValidateCredential(model.PATCredential, value); err != nil {
		return model.CredentialAuthorization{}, err
	}
	token, err := dao.PATByHash(ctx, secret.Hash(value), now)
	if err != nil {
		return model.CredentialAuthorization{}, authLookupError(err)
	}
	return patAuthorization(token)
}

func patAuthorization(token model.PersonalAccessToken) (model.CredentialAuthorization, error) {
	a := model.CredentialAuthorization{
		Principal: model.Principal{Kind: model.PATCredential, UserID: token.UserID, CredentialID: token.ID},
		Profile:   model.ScopedPATProfile,
		Policy:    token.ScopePolicy,
	}
	if err := a.Validate(); err != nil {
		return model.CredentialAuthorization{}, fmt.Errorf("invalid persisted PAT authorization: %w", err)
	}
	return a, nil
}

// LockPATAuthorization reads the current policy under the credential lock. The
// caller retains the surrounding transaction through the protected operation.
func (s *Identity) LockPATAuthorization(ctx context.Context, dao store.PATScopeDAO, clock store.PATManagementDAO, p model.Principal, now time.Time) (model.CredentialAuthorization, error) {
	if p.Kind != model.PATCredential || model.RequirePrincipal(p) != nil {
		return model.CredentialAuthorization{}, model.Unauthenticated(nil)
	}
	token, err := dao.ReadLockedPATScope(ctx, p.UserID, p.CredentialID)
	if err != nil {
		return model.CredentialAuthorization{}, authLookupError(err)
	}
	fresh, err := clock.FreshPATTime(ctx, now)
	if err != nil {
		return model.CredentialAuthorization{}, err
	}
	if token.ExpiresAt != nil && !token.ExpiresAt.After(fresh) {
		return model.CredentialAuthorization{}, model.Unauthenticated(nil)
	}
	return patAuthorization(token)
}

// UpdatePATScope replaces the explicit policy after rechecking account, session,
// target expiry and the caller's observed version within the caller's transaction.
func (s *Identity) UpdatePATScope(ctx context.Context, dao store.IdentityDAO, scopes store.PATScopeDAO, clock store.PATManagementDAO, p model.Principal, id, expectedUserID string, expected int64, selected []scopepolicy.ScopeID, now time.Time) (model.PersonalAccessToken, error) {
	if err := ValidatePATOwner(p, expectedUserID); err != nil {
		return model.PersonalAccessToken{}, err
	}
	id, err := model.CanonicalID(id)
	if err != nil {
		return model.PersonalAccessToken{}, err
	}
	if expected < 1 {
		return model.PersonalAccessToken{}, invalidInput("Expected scope version must be positive.")
	}
	selected, err = scopepolicy.Normalize(scopepolicy.PAT, selected)
	if err != nil {
		return model.PersonalAccessToken{}, invalidInput("Invalid token scopes.")
	}
	if err := authLookupError(dao.LockSession(ctx, p, now)); err != nil {
		return model.PersonalAccessToken{}, err
	}
	current, err := scopes.LockPATScope(ctx, p.UserID, id)
	if errors.Is(err, model.ErrNotFound) {
		return model.PersonalAccessToken{}, &model.Fault{Code: "not_found", Message: "Active token was not found.", Cause: err}
	}
	if err != nil {
		return model.PersonalAccessToken{}, err
	}
	fresh, err := clock.FreshPATTime(ctx, now)
	if err != nil {
		return model.PersonalAccessToken{}, err
	}
	if err := authLookupError(dao.LockSession(ctx, p, fresh)); err != nil {
		return model.PersonalAccessToken{}, err
	}
	if current.ExpiresAt != nil && !current.ExpiresAt.After(fresh) {
		return model.PersonalAccessToken{}, &model.Fault{Code: "not_found", Message: "Active token was not found."}
	}
	if _, err := patAuthorization(current); err != nil {
		return model.PersonalAccessToken{}, err
	}
	if current.ScopePolicy.Version() != expected {
		return model.PersonalAccessToken{}, &model.Fault{Code: "version_conflict", Message: "Token scopes changed. Read the current token before trying again."}
	}
	return scopes.ComparePATScope(ctx, p.UserID, id, expected, selected, fresh)
}
