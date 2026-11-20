package oauth

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

// AccessPolicy binds a current grant policy to an authenticated access identity.
type AccessPolicy struct {
	Authorization model.CredentialAuthorization
	GrantID       string
	ExpiresAt     time.Time
}

func accessPolicy(identity store.OAuthAccessIdentity, profile credentialProfile, now time.Time) (AccessPolicy, error) {
	if !validID(identity.GrantID) || !validID(identity.Principal.UserID) || !validID(identity.Principal.CredentialID) || identity.Principal.Kind != model.OAuthCredential || !identity.ExpiresAt.After(now) {
		return AccessPolicy{}, model.Unauthenticated(nil)
	}
	policyProfile := model.ScopedMCPProfile
	if profile.scope == APIScope {
		policyProfile = model.OAuthAPIProfile
	}
	a := model.CredentialAuthorization{Principal: identity.Principal, Profile: policyProfile, Policy: identity.ScopePolicy}
	if err := a.Validate(); err != nil {
		return AccessPolicy{}, fmt.Errorf("invalid persisted OAuth authorization: %w", err)
	}
	return AccessPolicy{Authorization: a, GrantID: identity.GrantID, ExpiresAt: identity.ExpiresAt}, nil
}

// AuthenticateAccessPolicy reads the current grant policy by access token hash.
// This separate path does not change legacy authentication before activation.
func AuthenticateAccessPolicy(ctx context.Context, dao store.OAuthScopeDAO, token, resource string, now time.Time) (AccessPolicy, error) {
	profile, valid := profileForResource(resource)
	if !valid || !secret.Valid(token, profile.accessPrefix) || now.IsZero() {
		return AccessPolicy{}, model.Unauthenticated(nil)
	}
	identity, err := dao.ScopedAccess(ctx, secret.Hash(token), []store.OAuthBinding{profile.binding(resource)}, now.UTC().Truncate(time.Microsecond))
	if errors.Is(err, model.ErrNotFound) {
		return AccessPolicy{}, model.Unauthenticated(err)
	}
	if err != nil {
		return AccessPolicy{}, err
	}
	return accessPolicy(identity, profile, now)
}

// LockAccessPolicy rechecks the actor against the current grant policy under
// grant then access locks. The caller retains the transaction for its operation.
func LockAccessPolicy(ctx context.Context, dao store.OAuthScopeDAO, principal model.Principal, resource string, now time.Time) (AccessPolicy, error) {
	profile, valid := profileForResource(resource)
	if !valid || principal.Kind != model.OAuthCredential || !validID(principal.UserID) || !validID(principal.CredentialID) || now.IsZero() {
		return AccessPolicy{}, model.Unauthenticated(nil)
	}
	identity, err := dao.LockScopedAccess(ctx, principal, []store.OAuthBinding{profile.binding(resource)}, now.UTC().Truncate(time.Microsecond))
	if errors.Is(err, model.ErrNotFound) {
		return AccessPolicy{}, model.Unauthenticated(err)
	}
	if err != nil {
		return AccessPolicy{}, err
	}
	if identity.Principal != principal {
		return AccessPolicy{}, model.Unauthenticated(nil)
	}
	return accessPolicy(identity, profile, now)
}

// ScopeSessionDAO supplies session locking and the database clock within the
// same transaction as the OAuthScopeDAO.
type ScopeSessionDAO interface {
	LockOwnerSession(context.Context, model.Principal, time.Time) error
	FreshTime(context.Context, time.Time) (time.Time, error)
}

// UpdateSessionGrantScope replaces a single owned MCP grant policy. Both DAOs
// must belong to the same caller-owned transaction; no result is committed here.
// Locking the grant before the session matches grant revocation and description
// updates. The database clock is sampled after both locks have been acquired.
func UpdateSessionGrantScope(ctx context.Context, session ScopeSessionDAO, dao store.OAuthScopeDAO, principal model.Principal, expectedUserID, grantID string, expected int64, selected []scopepolicy.ScopeID, now time.Time) (store.OAuthGrant, error) {
	return updateSessionGrantScope(ctx, session, dao, principal, expectedUserID, grantID, expected, selected, now, nil)
}

func updateSessionGrantScope(ctx context.Context, session ScopeSessionDAO, dao store.OAuthScopeDAO, principal model.Principal, expectedUserID, grantID string, expected int64, selected []scopepolicy.ScopeID, now time.Time, catalog *scopepolicy.CatalogSnapshot) (store.OAuthGrant, error) {
	if !validOwnerSession(principal) {
		return store.OAuthGrant{}, model.Unauthenticated(nil)
	}
	if !validID(expectedUserID) || !validID(grantID) || expected < 1 || now.IsZero() {
		return store.OAuthGrant{}, invalidInput()
	}
	if expectedUserID != principal.UserID {
		return store.OAuthGrant{}, &model.Fault{Code: "identity_mismatch", Message: "The current account differs from the expected account."}
	}
	selected, err := scopepolicy.Normalize(scopepolicy.MCP, selected)
	if err != nil {
		return store.OAuthGrant{}, invalidInput()
	}
	grant, err := dao.LockGrantScope(ctx, principal.UserID, grantID)
	if errors.Is(err, model.ErrNotFound) {
		return store.OAuthGrant{}, &model.Fault{Code: "not_found", Message: "Active grant was not found.", Cause: err}
	}
	if err != nil {
		return store.OAuthGrant{}, err
	}
	if err := session.LockOwnerSession(ctx, principal, now); err != nil {
		return store.OAuthGrant{}, scopeSessionError(err)
	}
	fresh, err := session.FreshTime(ctx, now)
	if err != nil {
		return store.OAuthGrant{}, err
	}
	if err := session.LockOwnerSession(ctx, principal, fresh); err != nil {
		return store.OAuthGrant{}, scopeSessionError(err)
	}
	if grant.ID != grantID || grant.UserID != principal.UserID || grant.RevokedAt != nil || !grant.ExpiresAt.After(fresh) {
		return store.OAuthGrant{}, &model.Fault{Code: "not_found", Message: "Active grant was not found."}
	}
	profile, valid := profileForResource(grant.Resource)
	if !valid || grant.Scope != profile.scope {
		return store.OAuthGrant{}, fmt.Errorf("invalid persisted OAuth grant profile")
	}
	if profile.scope != Scope {
		return store.OAuthGrant{}, invalidInput()
	}
	a := model.CredentialAuthorization{Principal: model.Principal{Kind: model.OAuthCredential, UserID: grant.UserID, CredentialID: grant.ID}, Profile: model.ScopedMCPProfile, Policy: grant.ScopePolicy}
	if err := a.Validate(); err != nil {
		return store.OAuthGrant{}, fmt.Errorf("invalid persisted OAuth grant policy: %w", err)
	}
	if grant.ScopePolicy.Version() != expected {
		return store.OAuthGrant{}, &model.Fault{Code: "version_conflict", Message: "Grant scopes changed. Read the current grant before trying again."}
	}
	if catalog != nil {
		selected, err = catalog.ValidateEditSelection(scopepolicy.MCP, selected, grant.ScopePolicy.Scopes())
		if err != nil {
			return store.OAuthGrant{}, invalidInput()
		}
	}
	return dao.CompareGrantScope(ctx, principal.UserID, grantID, expected, selected, fresh)
}

func scopeSessionError(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return model.Unauthenticated(err)
	}
	return err
}
