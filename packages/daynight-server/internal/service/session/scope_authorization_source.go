package session

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// SessionAuthorizationSource reads current credential policy inside the same
// transaction as a Session operation. The authenticated profile determines the
// exact OAuth resource binding; an identity alone cannot select a profile.
type SessionAuthorizationSource struct {
	origin string
	now    func() time.Time
}

func NewSessionAuthorizationSource(origin string) *SessionAuthorizationSource {
	return &SessionAuthorizationSource{origin: origin, now: time.Now}
}

func (s *SessionAuthorizationSource) SessionWrite(ctx context.Context, tx store.SessionScope, original model.CredentialAuthorization) (model.CredentialAuthorization, error) {
	if err := original.Validate(); err != nil {
		return model.CredentialAuthorization{}, err
	}
	if tx == nil {
		return model.CredentialAuthorization{}, errors.New("Session authorization transaction is unavailable")
	}
	now := s.now()
	if original.Profile == model.SessionProfile {
		if err := tx.SessionDAO().LockCredential(ctx, original.Principal, now); err != nil {
			if errors.Is(err, model.ErrNotFound) {
				return model.CredentialAuthorization{}, model.Unauthenticated(err)
			}
			return model.CredentialAuthorization{}, err
		}
		return original, nil
	}
	scoped, ok := tx.(store.ScopedSessionAuthorizationScope)
	if !ok {
		return model.CredentialAuthorization{}, errors.New("Session authorization policy DAOs are unavailable")
	}
	var current model.CredentialAuthorization
	var err error
	switch original.Profile {
	case model.ScopedPATProfile:
		current, err = identity.NewIdentity("").LockPATAuthorization(ctx, scoped.PATScopeDAO(), scoped.PATManagementDAO(), original.Principal, now)
	case model.ScopedMCPProfile, model.OAuthAPIProfile:
		resource := s.origin + "/mcp"
		if original.Profile == model.OAuthAPIProfile {
			resource = s.origin + "/api/v1"
		}
		var access oauth.AccessPolicy
		access, err = oauth.LockAccessPolicy(ctx, scoped.OAuthScopeDAO(), original.Principal, resource, now)
		current = access.Authorization
	default:
		return model.CredentialAuthorization{}, errors.New("unsupported Session authorization profile")
	}
	if err != nil {
		return model.CredentialAuthorization{}, err
	}
	if current.Principal != original.Principal || current.Profile != original.Profile {
		return model.CredentialAuthorization{}, fmt.Errorf("Session authorization identity or profile changed")
	}
	return current, current.Validate()
}

// SessionSnapshot reads the policy in the same snapshot as Session data.
func (s *SessionAuthorizationSource) SessionSnapshot(ctx context.Context, snapshot store.SnapshotScope, original model.CredentialAuthorization) (model.CredentialAuthorization, error) {
	if err := original.Validate(); err != nil {
		return model.CredentialAuthorization{}, err
	}
	if snapshot == nil {
		return model.CredentialAuthorization{}, errors.New("Session authorization snapshot is unavailable")
	}
	if original.Profile == model.SessionProfile {
		if _, err := snapshot.CredentialDAO().Credential(ctx, original.Principal); err != nil {
			if errors.Is(err, model.ErrNotFound) {
				return model.CredentialAuthorization{}, model.Unauthenticated(err)
			}
			return model.CredentialAuthorization{}, err
		}
		return original, nil
	}
	scoped, ok := snapshot.(store.ScopedSessionSnapshot)
	if !ok {
		return model.CredentialAuthorization{}, errors.New("Session authorization snapshot policy is unavailable")
	}
	now := s.now()
	current := model.CredentialAuthorization{Principal: original.Principal, Profile: original.Profile}
	var err error
	switch original.Profile {
	case model.ScopedPATProfile:
		var token model.PersonalAccessToken
		token, err = scoped.SessionPATPolicy(ctx, original.Principal, now)
		if err == nil {
			if token.ID != original.Principal.CredentialID || token.UserID != original.Principal.UserID || token.ExpiresAt != nil && !token.ExpiresAt.After(now) {
				return model.CredentialAuthorization{}, model.Unauthenticated(nil)
			}
			current.Policy = token.ScopePolicy
		}
	case model.ScopedMCPProfile, model.OAuthAPIProfile:
		if !oauth.ValidAPIOrigin(s.origin) {
			return model.CredentialAuthorization{}, model.Unauthenticated(nil)
		}
		binding := store.OAuthBinding{Resource: s.origin + "/mcp", Scope: oauth.Scope}
		if original.Profile == model.OAuthAPIProfile {
			binding = store.OAuthBinding{Resource: s.origin + "/api/v1", Scope: oauth.APIScope, ClientID: oauth.APIClientID}
		}
		var access store.OAuthAccessIdentity
		access, err = scoped.SessionOAuthPolicy(ctx, original.Principal, []store.OAuthBinding{binding}, now)
		if err == nil {
			grantID, grantErr := model.CanonicalID(access.GrantID)
			if access.Principal != original.Principal || !access.ExpiresAt.After(now) || grantErr != nil || grantID == "00000000-0000-0000-0000-000000000000" {
				return model.CredentialAuthorization{}, model.Unauthenticated(nil)
			}
			current.Policy = access.ScopePolicy
		}
	default:
		return model.CredentialAuthorization{}, errors.New("unsupported Session authorization profile")
	}
	if errors.Is(err, model.ErrNotFound) {
		return model.CredentialAuthorization{}, model.Unauthenticated(err)
	}
	if err != nil {
		return model.CredentialAuthorization{}, err
	}
	return current, current.Validate()
}
