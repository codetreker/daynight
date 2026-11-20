package identity

import (
	"context"
	"errors"
	"net/url"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// strict runs account writes without the device polling runner's refusal commits.
func (s *Identity) strict(ctx context.Context, operation func(store.IdentityScope) error) error {
	completion, err := s.writer.WriteIdentity(ctx, operation)
	if completion.Outcome == store.TransactionUnknown {
		var transaction *store.TransactionError
		if errors.As(err, &transaction) && transaction.Outcome == store.TransactionUnknown {
			return err
		}
		return &store.TransactionError{Phase: "confirmation", Outcome: store.TransactionUnknown, Cause: err}
	}
	if err != nil {
		return err
	}
	if completion.Outcome != store.TransactionCommitted {
		return errors.New("identity transaction did not confirm commit")
	}
	return nil
}

// EnsureUser returns an initialized account only after confirmed commit.
func (s *Identity) EnsureUser(ctx context.Context, input model.User) (model.User, error) {
	input, err := s.ops.validateExternalUser(input)
	if err != nil {
		return model.User{}, err
	}
	var result model.User
	err = s.strict(ctx, func(scope store.IdentityScope) error {
		now := s.now().UTC()
		var err error
		result, _, err = s.ops.ensureUser(ctx, scope.IdentityDAO(), input, now)
		if err != nil {
			return err
		}
		result.PersonalTeam, err = s.ops.bootstrapPersonalTeam(ctx, scope.PersonalTeamDAO(), result.ID, now)
		if err != nil {
			return err
		}
		var facts store.PersonalTeamFacts
		result, facts, err = s.ops.user(ctx, scope.IdentityDAO(), model.Principal{UserID: result.ID})
		if err != nil {
			return err
		}
		if err := s.ops.validatePersonalTeam(facts); err != nil {
			return err
		}
		result.PersonalTeam.ID, result.PersonalTeam.Kind = facts.ID, "personal"
		return s.ops.admitCompleteUser(result, true)
	})
	if err != nil {
		return model.User{}, err
	}
	return result, nil
}

func (s *Identity) PatchUser(ctx context.Context, p model.Principal, patch model.UserProfilePatch) (model.User, error) {
	return s.patchUser(ctx, p, patch, nil)
}

// ProfileScopeRecheck reads the current policy within the same identity transaction.
// Scoped profiles must provide it at each existing credential recheck boundary.
type ProfileScopeRecheck func(context.Context, store.IdentityScope, model.Principal) (model.CredentialAuthorization, error)

// PatchUserAuthorized is the policy-aware entry point for scoped assembly.
func (s *Identity) PatchUserAuthorized(ctx context.Context, authorization model.CredentialAuthorization, patch model.UserProfilePatch, recheck ProfileScopeRecheck) (model.User, error) {
	if err := authorization.Validate(); err != nil {
		return model.User{}, err
	}
	if (authorization.Profile == model.ScopedPATProfile || authorization.Profile == model.ScopedMCPProfile) && recheck == nil {
		return model.User{}, errors.New("profile scope recheck is required")
	}
	check := func(ctx context.Context, scope store.IdentityScope) error {
		if err := scopeadmission.Require(authorization, scopepolicy.AccountWrite); err != nil {
			return err
		}
		if authorization.Profile == model.ScopedPATProfile || authorization.Profile == model.ScopedMCPProfile {
			current, err := recheck(ctx, scope, authorization.Principal)
			if err != nil {
				return err
			}
			if current.Principal != authorization.Principal || current.Profile != authorization.Profile {
				return errors.New("profile scope recheck identity changed")
			}
			return scopeadmission.Require(current, scopepolicy.AccountWrite)
		}
		return nil
	}
	return s.patchUser(ctx, authorization.Principal, patch, check)
}

func (s *Identity) patchUser(ctx context.Context, p model.Principal, patch model.UserProfilePatch, recheck func(context.Context, store.IdentityScope) error) (model.User, error) {
	if err := s.ops.validateProfilePatch(patch); err != nil {
		return model.User{}, err
	}
	var result model.User
	err := s.strict(ctx, func(scope store.IdentityScope) error {
		resource := ""
		if p.Kind == model.OAuthCredential {
			callback, err := url.Parse(s.callbackURL)
			if err != nil {
				return err
			}
			resource = callback.Scheme + "://" + callback.Host + "/api/v1"
		}
		lock := func() error {
			if err := s.ops.lockProfileCredential(ctx, scope.IdentityDAO(), scope.CredentialFamilyDAO(), p, resource, s.now().UTC()); err != nil {
				return err
			}
			if recheck != nil {
				return recheck(ctx, scope)
			}
			return nil
		}
		if err := lock(); err != nil {
			return err
		}
		if _, err := s.ops.patchUser(ctx, scope.IdentityDAO(), p.UserID, patch); err != nil {
			return err
		}
		var facts store.PersonalTeamFacts
		var err error
		result, facts, err = s.ops.user(ctx, scope.IdentityDAO(), p)
		if err != nil {
			return err
		}
		if err := s.ops.validatePersonalTeam(facts); err != nil {
			return err
		}
		result.PersonalTeam.ID, result.PersonalTeam.Kind = facts.ID, "personal"
		if err := s.ops.admitCompleteUser(result, true); err != nil {
			return err
		}
		// User-row contention can outlast the first credential check.
		return lock()
	})
	if err != nil {
		return model.User{}, err
	}
	return result, nil
}
